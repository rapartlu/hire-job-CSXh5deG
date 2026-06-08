"""
mitmproxy addon for CSXh5deG -- Deliveroo API traffic capture.

Records API-shaped responses from any Deliveroo domain (both the .com
and .co.uk regions, and their subdomains) to SQLite for analysis. The
UK web app (deliveroo.co.uk) calls .co.uk API hosts, so matching only
api.deliveroo.com would miss a UK customer's traffic entirely.

To keep the capture useful for discovery without flooding it with HTML
page loads and static assets, a response is recorded when it comes from
a dedicated api/consumer host OR carries a JSON content-type.

The CA cert is written directly into the shared data volume by
mitmproxy itself (the proxy runs with --set confdir=/data/mitmproxy),
so the dashboard can serve it for browser installation. No copy step
is needed here -- that earlier approach depended on the container's
home directory, which broke because the mitmproxy image does not run
as root.
"""
import json
import os
import sqlite3
from datetime import datetime, timezone

DB_PATH = os.environ.get("DB_PATH", "/data/captures.db")

# Both Deliveroo regions. Matching is host == domain or host endswith
# "." + domain, so every subdomain (api., consumer-api., orderapp., etc.)
# of either region is in scope.
DELIVEROO_DOMAINS = (
    "deliveroo.com",
    "deliveroo.co.uk",
)


def _is_deliveroo_host(host: str) -> bool:
    return any(
        host == d or host.endswith("." + d) for d in DELIVEROO_DOMAINS
    )


def _looks_like_api(host: str, content_type: str) -> bool:
    """True for API-shaped responses worth recording.

    Dedicated api/consumer hosts are always captured; anything else on a
    Deliveroo domain is captured only when it returns JSON, which keeps
    HTML page loads and static assets out of the feed.
    """
    if host.startswith("api.") or host.startswith("consumer"):
        return True
    return "json" in content_type.lower()


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
    conn.commit()
    conn.close()


class DeliverooCapture:
    def __init__(self):
        _ensure_db()

    def response(self, flow):
        """Record Deliveroo API responses to SQLite."""
        host = flow.request.pretty_host
        if not _is_deliveroo_host(host):
            return
        content_type = flow.response.headers.get("content-type", "")
        if not _looks_like_api(host, content_type):
            return

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

        conn = sqlite3.connect(DB_PATH)
        conn.execute(
            """
            INSERT INTO captures
                (ts, method, url, req_headers, req_body,
                 resp_status, resp_headers, resp_body)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                datetime.now(timezone.utc).isoformat(),
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
