"""
mitmproxy addon for CSXh5deG -- Deliveroo API traffic capture + rule engine.

Milestone 1-2: Intercepts HTTPS responses from Deliveroo API hosts and stores
them in SQLite for analysis.

Milestone 3: Applies active MITM rules (stored in the same SQLite DB) to
outgoing requests and incoming responses. Rules are managed through the
dashboard control plane at localhost:3000/rules.

Rule types:
  - request: modifies outgoing GraphQL variables before the request reaches
    Deliveroo. Use to inject parameters not exposed in the UI.
  - response: modifies incoming API responses before they reach the browser.
    Use to surface or transform data the app hides.

CA cert setup: the proxy runs with --set confdir=/data/mitmproxy, so the cert
is written to the shared volume at /data/mitmproxy/mitmproxy-ca-cert.pem.
"""
import json
import os
import sqlite3
from datetime import datetime, timezone

DB_PATH = os.environ.get("DB_PATH", "/data/captures.db")

# Primary API hosts to capture and intercept.
DELIVEROO_API_HOSTS = {
    "api.deliveroo.com",
    "consumer-api.deliveroo.com",
    "api.uk.deliveroo.com",
    "consumer-api.uk.deliveroo.com",
    "api.eu.deliveroo.com",
    "consumer-api.eu.deliveroo.com",
    "graphql.deliveroo.com",
}

# Broader match for the seen_hosts diagnostic log.
DELIVEROO_ROOT_DOMAINS = {
    "deliveroo.com",
    "deliveroo.co.uk",
}


def _is_deliveroo_api(host: str) -> bool:
    return any(
        host == h or host.endswith("." + h) for h in DELIVEROO_API_HOSTS
    )


def _is_deliveroo_any(host: str) -> bool:
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
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS seen_hosts (
            host          TEXT    PRIMARY KEY,
            first_seen    TEXT    NOT NULL,
            last_seen     TEXT    NOT NULL,
            request_count INTEGER NOT NULL DEFAULT 1,
            is_captured   INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    # Milestone 3: rule engine table.
    # scope: 'request' - applied before the request reaches Deliveroo.
    #        'response' - applied after Deliveroo's response, before the browser sees it.
    # target: dot-path into the JSON body.
    #   For request rules: path into the 'variables' object, e.g. 'fulfillment_methods'
    #     or 'options.query'. The proxy resolves this relative to the 'variables' key.
    #   For response rules: absolute dot-path, e.g. 'data.results.meta.restaurantCount'.
    # action: 'set' - set the target field to value (JSON-serialised).
    #         'delete' - remove the target field.
    # value: JSON string. For 'set' action only; ignored for 'delete'.
    # match_url: URL substring filter. Empty string means apply to all Deliveroo API calls.
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
    # Pre-seed rules derived from inspecting the captured getHomeFeed GraphQL request
    # variables (fulfillment_methods, options.*, ui_features arrays seen in the cURL
    # shared on the job issue). Checks by name so restarting the proxy never
    # duplicates existing rules - new rules are added, already-present ones are kept.
    #
    # Rules are grouped:
    #   1. Fulfillment method overrides (confirmed vars from captured payload)
    #   2. Response visibility (ui_features from captured payload)
    #   3. Sort order   (SearchOptionsInput - from SORT ui_control in captured payload)
    #   4. Filters      (SearchOptionsInput - from FILTER ui_control in captured payload)
    #   5. Dietary      (SearchOptionsInput - Deliveroo UK dietary IDs)
    #
    # All seeded rules start disabled (active=0). Enable from the Rules tab.
    now = datetime.now(timezone.utc).isoformat()
    examples = [
        # ── 1. Fulfillment methods ──────────────────────────────────────────────
        (
            "Include Collection",
            "Add COLLECTION to fulfillment_methods so collection-only restaurants appear. "
            "Default is DELIVERY only. Confirmed field from captured getHomeFeed variables.",
            "request",
            "",
            "fulfillment_methods",
            "set",
            '["DELIVERY","COLLECTION"]',
            0,
            now,
        ),
        (
            "Include all modes (+ Pickup)",
            "Expand fulfillment_methods to DELIVERY, COLLECTION and PICKUP. "
            "Useful if Deliveroo runs a pickup tier in your area.",
            "request",
            "",
            "fulfillment_methods",
            "set",
            '["DELIVERY","COLLECTION","PICKUP"]',
            0,
            now,
        ),
        # ── 2. Response visibility ──────────────────────────────────────────────
        (
            "Empty search query",
            "Set options.query to empty string so you see ALL restaurants for the area "
            "rather than the current search term. Confirmed field from captured payload.",
            "request",
            "",
            "options.query",
            "set",
            '""',
            0,
            now,
        ),
        (
            "Increase column count",
            "Raise web_column_count from 4 to 6. More columns may cause Deliveroo to "
            "return more restaurants per page. Confirmed field from captured payload.",
            "request",
            "",
            "options.web_column_count",
            "set",
            "6",
            0,
            now,
        ),
        (
            "Hide closed restaurants",
            "Remove UNAVAILABLE_RESTAURANTS from the ui_features list. This tells "
            "Deliveroo not to include closed restaurants in results. Field confirmed "
            "from ui_features array in captured getHomeFeed request.",
            "request",
            "",
            "ui_features",
            "set",
            '["LIMIT_QUERY_RESULTS","UI_CARD_BORDER","UI_CAROUSEL_COLOR","UI_PROMOTION_TAG",'
            '"UI_BACKGROUND","SCHEDULED_RANGES","UI_SPAN_TAGS","UI_CARD_BADGES",'
            '"TEXT_SEARCH_COMBINED_VIEW"]',
            0,
            now,
        ),
        # ── 3. Sort order ───────────────────────────────────────────────────────
        (
            "Sort: highest rated first",
            "Pass options.sort_by=RATING. The SORT ui_control appears in the captured "
            "payload, so the backend accepts sort_by - but the exact value string may "
            "need adjusting. Try RATING or rating.",
            "request",
            "consumer/graphql",
            "options.sort_by",
            "set",
            '"RATING"',
            0,
            now,
        ),
        (
            "Sort: fastest delivery first",
            "Pass options.sort_by=DELIVERY_TIME to see closest/fastest restaurants first. "
            "Sourced from SORT ui_control in captured payload; exact value may vary.",
            "request",
            "consumer/graphql",
            "options.sort_by",
            "set",
            '"DELIVERY_TIME"',
            0,
            now,
        ),
        # ── 4. Filters ──────────────────────────────────────────────────────────
        (
            "Only 4.5+ star restaurants",
            "Pass options.minimum_rating_threshold=4.5. The FILTER ui_control in the "
            "captured payload suggests the backend supports rating thresholds.",
            "request",
            "consumer/graphql",
            "options.minimum_rating_threshold",
            "set",
            "4.5",
            0,
            now,
        ),
        (
            "Delivery under 30 min",
            "Pass options.maximum_delivery_time=30 to filter out slow restaurants. "
            "Field sourced from FILTER ui_control in captured payload.",
            "request",
            "consumer/graphql",
            "options.maximum_delivery_time",
            "set",
            "30",
            0,
            now,
        ),
        (
            "Promotions only",
            "Pass options.offers_only=true (or options.offers=true - try both) to show "
            "only restaurants currently running deals. Sourced from FILTER ui_control.",
            "request",
            "consumer/graphql",
            "options.offers_only",
            "set",
            "true",
            0,
            now,
        ),
        # ── 5. Dietary filters ──────────────────────────────────────────────────
        (
            "Dietary: vegetarian",
            "Pass options.dietary_type_ids=[3] - Deliveroo UK ID 3 is Vegetarian. "
            "Sourced from FILTER ui_control in captured payload. Disable to revert.",
            "request",
            "consumer/graphql",
            "options.dietary_type_ids",
            "set",
            "[3]",
            0,
            now,
        ),
        (
            "Dietary: vegan",
            "Pass options.dietary_type_ids=[1] - Deliveroo UK ID 1 is Vegan.",
            "request",
            "consumer/graphql",
            "options.dietary_type_ids",
            "set",
            "[1]",
            0,
            now,
        ),
        (
            "Dietary: halal",
            "Pass options.dietary_type_ids=[2] - Deliveroo UK ID 2 is Halal.",
            "request",
            "consumer/graphql",
            "options.dietary_type_ids",
            "set",
            "[2]",
            0,
            now,
        ),
        (
            "Dietary: gluten-free",
            "Pass options.dietary_type_ids=[4] - Deliveroo UK ID 4 is Gluten-free.",
            "request",
            "consumer/graphql",
            "options.dietary_type_ids",
            "set",
            "[4]",
            0,
            now,
        ),
        # ── 6. Feed cleanup from payload inspection ─────────────────────────────
        # Rules below are seeded ENABLED (active=1). They remove advertising
        # artefacts that the Deliveroo web client requests but does not expose
        # as UI options.
        #
        # Evidence per rule:
        #   ui_blocks: the June 2026 captured cURL included the response header
        #     X-ROO-CLIENT-CACHED-COMPONENTS listing
        #     "sponsored-merchandising-card-v1-c44c035f", confirming
        #     MERCHANDISING_CARD maps to embedded sponsored restaurant slots.
        #     BANNER = the top-of-feed promotional strip (unrelated to deals).
        #   ui_targets/EDITORIAL_CONTENT: present in the default variables the
        #     web app sends; serves curated promotional groupings rather than
        #     organic restaurant results.
        #   ui_layouts/CAROUSEL: carousel groups surface sponsored/editorial
        #     collections (e.g. "Trending near you" branded rows).
        #   ui_features/UI_PROMOTION_TAG: renders deal/offer badge overlays on
        #     restaurant cards. Removing it does not filter restaurants - it
        #     just strips the badge from the card layout.
        (
            "Strip ads and promo banners",
            "Remove BANNER and MERCHANDISING_CARD from ui_blocks. BANNER = "
            "top-of-feed promotional strip. MERCHANDISING_CARD = embedded "
            "sponsored restaurant slots (confirmed via "
            "sponsored-merchandising-card-v1 component seen in captured "
            "request headers). Leaves CARD, SHORTCUT, BUTTON, ROO_BLOCK. "
            "Enabled by default - purely subtractive.",
            "request",
            "",
            "ui_blocks",
            "set",
            '["CARD","SHORTCUT","BUTTON","ROO_BLOCK"]',
            1,
            now,
        ),
        (
            "Strip editorial targets",
            "Remove EDITORIAL_CONTENT from ui_targets. Editorial content is "
            "Deliveroo-curated promotional groupings separate from organic "
            "restaurant results. Removing it narrows the feed to restaurants "
            "matching your location and filters only. Enabled by default.",
            "request",
            "",
            "ui_targets",
            "set",
            '["PARAMS","RESTAURANT","MENU_ITEM","WEB_PAGE","DEEP_LINK"]',
            1,
            now,
        ),
        (
            "List view only (no carousels)",
            "Set ui_layouts to LIST only, removing CAROUSEL. Carousel groups "
            "are used for branded or editorial collections - typically sponsored "
            "Explore sections. Switching to list-only gives a flat, "
            "uninterrupted restaurant feed. Enabled by default.",
            "request",
            "",
            "ui_layouts",
            "set",
            '["LIST"]',
            1,
            now,
        ),
        (
            "Strip promotion badges",
            "Remove UI_PROMOTION_TAG from ui_features. This flag tells "
            "Deliveroo to render deal/offer badges on restaurant cards. "
            "Stripping it gives a cleaner card layout without affecting "
            "whether deals actually exist at the restaurant. Enabled by default.",
            "request",
            "",
            "ui_features",
            "set",
            '["UNAVAILABLE_RESTAURANTS","LIMIT_QUERY_RESULTS","UI_CARD_BORDER",'
            '"UI_CAROUSEL_COLOR","UI_BACKGROUND","SCHEDULED_RANGES","UI_SPAN_TAGS",'
            '"UI_CARD_BADGES","TEXT_SEARCH_COMBINED_VIEW"]',
            1,
            now,
        ),
        # ── 7. Scheduling behaviour ─────────────────────────────────────────────
        (
            "ASAP delivery only",
            "Set options.fulfillment_include_asap_days=false. The default "
            "(true) includes restaurants that only do scheduled/next-day "
            "delivery, making them appear even when they cannot deliver now. "
            "Setting this to false shows only restaurants open for immediate "
            "delivery. May noticeably reduce result count in some areas.",
            "request",
            "consumer/graphql",
            "options.fulfillment_include_asap_days",
            "set",
            "false",
            0,
            now,
        ),
        # ── 8. Response mutations from captured basket payload ──────────────────
        (
            "Disable basket discovery",
            "Set data.get_basket_page_summary.isBasketDiscoveryEnabled=false "
            "in basket GraphQL responses. isBasketDiscoveryEnabled=true was "
            "observed in a captured basket payload. This flag controls a UI "
            "feature that suggests items from other restaurants inside your "
            "basket view. Disable if you prefer a plain basket without "
            "cross-sell suggestions.",
            "response",
            "consumer/graphql",
            "data.get_basket_page_summary.isBasketDiscoveryEnabled",
            "set",
            "false",
            0,
            now,
        ),
    ]
    for rule in examples:
        exists = conn.execute(
            "SELECT 1 FROM rules WHERE name = ?", (rule[0],)
        ).fetchone()
        if not exists:
            conn.execute(
                """
                INSERT INTO rules
                    (name, description, scope, match_url, target, action, value, active, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rule,
            )
    conn.commit()
    conn.close()


def _get_active_rules(scope: str) -> list:
    """Return active rules for the given scope, ordered by id."""
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM rules WHERE active = 1 AND scope = ? ORDER BY id",
            (scope,),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]
    except Exception:
        return []


def _set_path(obj: dict, path: str, value) -> bool:
    """Set obj at dot-path, creating intermediate dicts as needed. Returns True on success."""
    if not path:
        return False
    keys = path.split(".")
    for key in keys[:-1]:
        if isinstance(obj, dict):
            if key not in obj or not isinstance(obj[key], dict):
                obj[key] = {}
            obj = obj[key]
        else:
            return False
    if isinstance(obj, dict):
        obj[keys[-1]] = value
        return True
    return False


def _del_path(obj: dict, path: str) -> bool:
    """Delete key at dot-path. Returns True if the key existed."""
    if not path:
        return False
    keys = path.split(".")
    for key in keys[:-1]:
        if isinstance(obj, dict) and key in obj:
            obj = obj[key]
        else:
            return False
    if isinstance(obj, dict) and keys[-1] in obj:
        del obj[keys[-1]]
        return True
    return False


class DeliverooCapture:
    def __init__(self):
        _ensure_db()

    # ── Milestone 3: request modification ────────────────────────────────────

    def request(self, flow):
        """Apply active request rules to outgoing Deliveroo API requests."""
        if not _is_deliveroo_api(flow.request.pretty_host):
            return
        if flow.request.method != "POST":
            return

        rules = _get_active_rules("request")
        if not rules:
            return

        try:
            body = json.loads(flow.request.content.decode("utf-8"))
        except Exception:
            return

        if "variables" not in body or not isinstance(body["variables"], dict):
            return

        changed = False
        for rule in rules:
            match_url = rule.get("match_url", "")
            if match_url and match_url not in flow.request.url:
                continue

            target = rule.get("target", "")
            action = rule.get("action", "set")

            try:
                if action == "set":
                    value = json.loads(rule.get("value", "null"))
                    # Resolve target relative to 'variables'
                    if _set_path(body["variables"], target, value):
                        changed = True
                elif action == "delete":
                    if _del_path(body["variables"], target):
                        changed = True
            except Exception:
                pass

        if changed:
            new_body = json.dumps(body, ensure_ascii=False).encode("utf-8")
            flow.request.content = new_body
            flow.request.headers["content-length"] = str(len(new_body))

    # ── Milestone 1-2: capture + Milestone 3: response modification ──────────

    def response(self, flow):
        """Record Deliveroo traffic and apply active response rules."""
        host = flow.request.pretty_host
        is_api = _is_deliveroo_api(host)
        is_deliveroo = is_api or _is_deliveroo_any(host)

        if not is_deliveroo:
            return

        now = datetime.now(timezone.utc).isoformat()

        # ── Capture to SQLite ──
        conn = sqlite3.connect(DB_PATH)

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

        req_body = ""
        resp_body = ""

        if is_api:
            try:
                req_body = flow.request.content.decode("utf-8", errors="replace")
            except Exception:
                pass

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

        # ── Milestone 3: response rule application ──
        if not is_api or flow.response.status_code != 200:
            return

        rules = _get_active_rules("response")
        if not rules:
            return

        try:
            resp_json = json.loads(flow.response.content.decode("utf-8"))
        except Exception:
            return

        changed = False
        for rule in rules:
            match_url = rule.get("match_url", "")
            if match_url and match_url not in flow.request.url:
                continue

            target = rule.get("target", "")
            action = rule.get("action", "set")

            try:
                if action == "set":
                    value = json.loads(rule.get("value", "null"))
                    if _set_path(resp_json, target, value):
                        changed = True
                elif action == "delete":
                    if _del_path(resp_json, target):
                        changed = True
            except Exception:
                pass

        if changed:
            new_body = json.dumps(resp_json, ensure_ascii=False).encode("utf-8")
            flow.response.content = new_body
            if "content-length" in flow.response.headers:
                flow.response.headers["content-length"] = str(len(new_body))


addons = [DeliverooCapture()]
