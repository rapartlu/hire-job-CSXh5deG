"""
mitmproxy addon for CSXh5deG -- Deliveroo API traffic capture.

Intercepts HTTPS responses from api.deliveroo.com and
consumer-api.deliveroo.com, storing them in SQLite for analysis.

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

DELIVEROO_HOSTS = {
    "api.deliveroo.com",
    "consumer-api.deliveroo.com",
}


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
        if not any(
            host == h or host.endswith("." + h) for h in DELIVEROO_HOSTS
        ):
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
