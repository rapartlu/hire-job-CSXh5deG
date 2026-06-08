"""
mitmproxy addon for CSXh5deG -- Deliveroo API traffic capture.

Intercepts HTTPS responses from Deliveroo API hosts and stores them in
SQLite for analysis. Also records a lightweight seen_hosts log for every
unique hostname that passes through the proxy, regardless of filter -- this
helps diagnose cases where Deliveroo uses an unexpected API domain.

The CA cert is written directly into the shared data volume by mitmproxy
itself (the proxy runs with --set confdir=/data/mitmproxy), so the
dashboard can serve it for browser installation.
"""
import json
import os
import sqlite3
from datetime import datetime, timezone

DB_PATH = os.environ.get("DB_PATH", "/data/captures.db")

# Primary API hosts to capture fully (with request/response bodies).
# Includes both the global and regional variants known to be used by
# Deliveroo's web frontend and mobile apps.
DELIVEROO_API_HOSTS = {
    "api.deliveroo.com",
    "consumer-api.deliveroo.com",
    "api.uk.deliveroo.com",
    "consumer-api.uk.deliveroo.com",
    "api.eu.deliveroo.com",
    "consumer-api.eu.deliveroo.com",
    "graphql.deliveroo.com",
}

# Broader match: any subdomain of deliveroo.com or deliveroo.co.uk.
# Used for the seen_hosts log and as a fallback API capture to avoid
# missing traffic if Deliveroo adds or renames an API subdomain.
DELIVEROO_ROOT_DOMAINS = {
    "deliveroo.com",
    "deliveroo.co.uk",
}


def _is_deliveroo_api(host: str) -> bool:
    """Return True if host is a known Deliveroo API host."""
    return any(
        host == h or host.endswith("." + h) for h in DELIVEROO_API_HOSTS
    )


def _is_deliveroo_any(host: str) -> bool:
    """Return True if host is any Deliveroo subdomain."""
    return any(
        host == h or host.endswith("." + h) for h in DELIVEROO_ROOT_DOMAINS
    )


def _ensure_db() -> None:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS captures (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            ts           TEXT    NOT NULL,
            method       TEXT    NOT NULL,
            url          TEXT    NOT NULL,
            req_headers  TEXT,
            req_body     TEXT,
            resp_status  INTEGER,
            resp_headers TEXT,
            resp_body    TEXT
        )
        """
    )
    # Lightweight host-visibility log: one row per unique host seen,
    # updated with each new request. No bodies -- stays small regardless
    # of traffic volume. Used by /api/debug/hosts for filter diagnosis.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS seen_hosts (
            host         TEXT    PRIMARY KEY,
            first_seen   TEXT    NOT NULL,
            last_seen    TEXT    NOT NULL,
            request_count INTEGER NOT NULL DEFAULT 1,
            is_captured  INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    conn.commit()
    conn.close()


class DeliverooCapture:
    def __init__(self):
        _ensure_db()

    def response(self, flow):
        """Record Deliveroo traffic to SQLite."""
        host = flow.request.pretty_host
        is_api = _is_deliveroo_api(host)
        is_deliveroo = is_api or _is_deliveroo_any(host)

        if not is_deliveroo:
            return

        now = datetime.now(timezone.utc).isoformat()
        conn = sqlite3.connect(DB_PATH)

        # Always update seen_hosts for any Deliveroo domain
        conn.execute(
            """
            INSERT INTO seen_hosts (host, first_seen, last_seen, request_count, is_captured)
            VALUES (?, ?, ?, 1, ?)
            ON CONFLICT(host) DO UPDATE SET
                last_seen = excluded.last_seen,
                request_count = request_count + 1,
                is_captured = MAX(is_captured, excluded.is_captured)
            """,
            (host, now, now, 1 if is_api else 0),
        )

        # Full capture only for known API hosts
        if is_api:
            req_body = ""
            try:
                req_body = flow.request.content.decode("utf-8", errors="replace")
            except Exception:
                pass

            resp_body = ""
            try:
                resp_body = flow.response.content.decode("utf-8", errors="replace")
            except Exception:
                pass

            conn.execute(
                """
                INSERT INTO captures
                    (ts, method, url, req_headers, req_body,
                     resp_status, resp_headers, resp_body)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    now,
                    flow.request.method,
                    flow.request.url,
                    json.dumps(dict(flow.request.headers)),
                    req_body,
                    flow.response.status_code,
                    json.dumps(dict(flow.response.headers)),
                    resp_body,
                ),
            )

        conn.commit()
        conn.close()


addons = [DeliverooCapture()]
