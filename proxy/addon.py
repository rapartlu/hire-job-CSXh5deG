"""
mitmproxy addon for CSXh5deG -- Deliveroo API traffic capture.

Intercepts HTTPS responses from api.deliveroo.com and
consumer-api.deliveroo.com, storing them in SQLite for analysis.
Copies the CA cert to the shared data volume so the dashboard
can serve it for browser installation.
"""
import json
import os
import shutil
import sqlite3
from datetime import datetime, timezone

DB_PATH = os.environ.get("DB_PATH", "/data/captures.db")
CERT_SRC = "/root/.mitmproxy/mitmproxy-ca-cert.pem"
CERT_DST = os.path.join(os.path.dirname(DB_PATH), "mitmproxy-ca-cert.pem")

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

    def running(self):
        """Copy CA cert to shared data volume once mitmproxy is ready."""
        if os.path.exists(CERT_SRC):
            shutil.copy(CERT_SRC, CERT_DST)

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
