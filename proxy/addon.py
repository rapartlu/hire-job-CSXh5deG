"""
mitmproxy addon for CSXh5deG -- Deliveroo API traffic capture + rule engine.

Intercepts HTTPS traffic from Deliveroo API hosts:
  - capture: stores request/response bodies in SQLite for analysis
  - rules: modifies requests/responses in flight based on user-configured rules

Rules are managed via the dashboard's /api/rules endpoints and stored in the
same SQLite database. Changes take effect on the next proxied request.
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

# Seed rules inserted on first DB init (all inactive by default).
# Based on analysis of Deliveroo's getHomeFeed GraphQL variable schema
# from captured payloads (customer's Biggin Hill session, 2026-06-09).
_SEED_RULES = [
    {
        "name": "Include Collection",
        "description": (
            "Adds COLLECTION to fulfillment_methods. "
            "Default Deliveroo web app sends DELIVERY only -- enabling this "
            "surfaces pickup/collection venues that are hidden in the standard "
            "delivery search, often with no delivery fee."
        ),
        "scope": "request",
        "match_url": "/consumer/graphql",
        "target": "fulfillment_methods",
        "action": "set",
        "value": '["DELIVERY","COLLECTION"]',
    },
    {
        "name": "Collection Only",
        "description": (
            "Restricts results to venues offering click-and-collect/pickup only. "
            "Useful for browsing collection options without a delivery fee. "
            "Combine with a location geohash to compare what's nearby for pickup."
        ),
        "scope": "request",
        "match_url": "/consumer/graphql",
        "target": "fulfillment_methods",
        "action": "set",
        "value": '["COLLECTION"]',
    },
    {
        "name": "Remove Result Cap",
        "description": (
            "Drops LIMIT_QUERY_RESULTS from ui_features. "
            "Deliveroo includes this flag in default web requests -- removing it "
            "may increase the number of restaurants returned per search. "
            "Effect depends on Deliveroo server-side interpretation of this flag."
        ),
        "scope": "request",
        "match_url": "/consumer/graphql",
        "target": "ui_features",
        "action": "set",
        "value": (
            '["UNAVAILABLE_RESTAURANTS","UI_CARD_BORDER","UI_CAROUSEL_COLOR",'
            '"UI_PROMOTION_TAG","UI_BACKGROUND","SCHEDULED_RANGES","UI_SPAN_TAGS",'
            '"UI_CARD_BADGES","TEXT_SEARCH_COMBINED_VIEW"]'
        ),
    },
    {
        "name": "Cuisine Filter",
        "description": (
            "Injects a cuisine keyword into options.query. "
            "Change the value to any cuisine (e.g. \"sushi\", \"pizza\", \"thai\") "
            "to filter results to matching restaurants. "
            "Set to \"\" (empty string) to clear. "
            "This overrides whatever is typed in the Deliveroo search box."
        ),
        "scope": "request",
        "match_url": "/consumer/graphql",
        "target": "options.query",
        "action": "set",
        "value": '"sushi"',
    },
]


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
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS rules (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT    NOT NULL,
            description TEXT    NOT NULL DEFAULT '',
            scope       TEXT    NOT NULL DEFAULT 'request',
            match_url   TEXT    NOT NULL DEFAULT '',
            target      TEXT    NOT NULL,
            action      TEXT    NOT NULL DEFAULT 'set',
            value       TEXT    NOT NULL DEFAULT 'null',
            active      INTEGER NOT NULL DEFAULT 1,
            created_at  TEXT    NOT NULL
        )
        """
    )
    conn.commit()

    # Seed example rules on first init (only if table is empty).
    count = conn.execute("SELECT COUNT(*) FROM rules").fetchone()[0]
    if count == 0:
        now = datetime.now(timezone.utc).isoformat()
        for rule in _SEED_RULES:
            conn.execute(
                """
                INSERT INTO rules
                    (name, description, scope, match_url, target, action, value, active, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
                """,
                (
                    rule["name"],
                    rule["description"],
                    rule["scope"],
                    rule["match_url"],
                    rule["target"],
                    rule["action"],
                    rule["value"],
                    now,
                ),
            )
        conn.commit()

    conn.close()


def _get_active_rules(scope: str) -> list:
    """Return all active rules for the given scope, ordered by id."""
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM rules WHERE scope = ? AND active = 1 ORDER BY id ASC",
            (scope,),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]
    except Exception:
        return []


def _apply_dot_path(obj, path: str, action: str, value_json: str) -> None:
    """Mutate obj in-place via a dot-separated path.

    Numeric path segments are treated as list indices.
    action: 'set' replaces/inserts the value; 'delete' removes it.
    value_json: JSON-encoded value string (used only for 'set').

    Examples:
      path="fulfillment_methods"          → obj["fulfillment_methods"]
      path="options.query"                → obj["options"]["query"]
      path="data.results.layoutGroups.0"  → obj["data"]["results"]["layoutGroups"][0]
    """
    parts = path.split(".")
    cursor = obj

    for part in parts[:-1]:
        if isinstance(cursor, list):
            cursor = cursor[int(part)]
        else:
            cursor = cursor[part]

    last = parts[-1]

    if action == "delete":
        if isinstance(cursor, list):
            del cursor[int(last)]
        else:
            cursor.pop(last, None)
    else:  # "set"
        value = json.loads(value_json)
        if isinstance(cursor, list):
            idx = int(last)
            if idx < len(cursor):
                cursor[idx] = value
            else:
                cursor.append(value)
        else:
            cursor[last] = value


class DeliverooCapture:
    def __init__(self):
        _ensure_db()

    def request(self, flow):
        """Apply active request rules to outbound Deliveroo GraphQL calls.

        Reads active 'request' rules from SQLite and applies each one to the
        outbound request's GraphQL variables before the request leaves the
        machine. If no rules are active, this is a no-op.
        """
        if not _is_deliveroo_api(flow.request.pretty_host):
            return
        if flow.request.method != "POST":
            return

        rules = _get_active_rules("request")
        if not rules:
            return

        try:
            body = json.loads(flow.request.content.decode("utf-8", errors="replace"))
        except Exception:
            return

        if not isinstance(body.get("variables"), dict):
            return

        changed = False
        for rule in rules:
            match_url = rule.get("match_url", "")
            if match_url and match_url not in flow.request.url:
                continue
            try:
                _apply_dot_path(
                    body["variables"],
                    rule["target"],
                    rule["action"],
                    rule.get("value", "null"),
                )
                changed = True
            except Exception:
                pass

        if changed:
            new_body = json.dumps(body).encode("utf-8")
            flow.request.content = new_body
            flow.request.headers["content-length"] = str(len(new_body))

    def response(self, flow):
        """Record Deliveroo traffic to SQLite; apply active response rules."""
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

        # Apply response rules (modify response in flight after capture)
        if is_api and flow.request.method == "POST":
            rules = _get_active_rules("response")
            if not rules:
                return
            try:
                resp_obj = json.loads(
                    flow.response.content.decode("utf-8", errors="replace")
                )
            except Exception:
                return

            changed = False
            for rule in rules:
                match_url = rule.get("match_url", "")
                if match_url and match_url not in flow.request.url:
                    continue
                try:
                    _apply_dot_path(
                        resp_obj,
                        rule["target"],
                        rule["action"],
                        rule.get("value", "null"),
                    )
                    changed = True
                except Exception:
                    pass

            if changed:
                new_body = json.dumps(resp_obj).encode("utf-8")
                flow.response.content = new_body
                flow.response.headers["content-length"] = str(len(new_body))


addons = [DeliverooCapture()]
