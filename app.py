import asyncio
import json
import os
import threading
from datetime import datetime, timezone
from urllib.error import URLError
from urllib.request import Request, urlopen

from flask import Flask, jsonify, render_template, request, url_for


app = Flask(__name__)

# Broad proof-of-concept maritime demo box for the current map region.

# REGION_BBOX = {
#     "min_lat": 20.0,
#     "max_lat": 31.0,
#     "min_lon": 47.0,
#     "max_lon": 65.0,
# }

# East Asia box for testing
# REGION_BBOX = {
#     "min_lat": 0.0,
#     "max_lat": 45.0,
#     "min_lon": 115.0,
#     "max_lon": 150.0,
# }

# Mediterranean box for testing
REGION_BBOX = {
    "min_lat": 30.0,
    "max_lat": 46.0,
    "min_lon": -6.0,
    "max_lon": 37.0,
}


FIELDS = [
    "mmsi",
    "ship_name",
    "call_sign",
    "imo",
    "lat",
    "lon",
    "sog",
    "cog",
    "heading",
    "nav_status",
    "destination",
    "eta",
    "draft",
    "cargo_type",
    "last_seen",
    "source",
]

PROVIDERS = {
    "mock": "Demo mode (mock data)",
    "aisstream": "Local AISStream live mode",
    "live": "Generic live JSON mode",
}

AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream"
AISSTREAM_DEFAULT_MESSAGE_TYPES = [
    "PositionReport",
    "StandardClassBPositionReport",
    "ExtendedClassBPositionReport",
]
AISSTREAM_CACHE = {}
AISSTREAM_LOCK = threading.Lock()
AISSTREAM_THREAD = None
AISSTREAM_WARNING = None
AISSTREAM_STATUS = {
    "connected": False,
    "last_message_at": None,
    "last_error": None,
    "messages_received": 0,
    "parsed_messages": 0,
    "dropped_messages": 0,
    "cached_vessels": 0,
    "cached_in_region": 0,
    "last_message_type": None,
    "last_close_code": None,
    "last_close_reason": None,
    "subscription": None,
}
AISSTREAM_SAMPLES = []

NAV_STATUS = {
    0: "Under way using engine",
    1: "At anchor",
    2: "Not under command",
    3: "Restricted manoeuverability",
    4: "Constrained by draught",
    5: "Moored",
    6: "Aground",
    7: "Engaged in fishing",
    8: "Under way sailing",
    15: "Undefined",
}


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def aisstream_message_types():
    configured = os.getenv("AISSTREAM_MESSAGE_TYPES")
    if not configured:
        return AISSTREAM_DEFAULT_MESSAGE_TYPES
    return [item.strip() for item in configured.split(",") if item.strip()]


def first_value(record, *names):
    for name in names:
        if name in record and record[name] not in ("", None):
            return record[name]
    return None


def as_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def clean_ais_text(value):
    if value in ("", None):
        return None
    cleaned = str(value).replace("@", "").strip()
    return cleaned or None


def ship_type_label(value):
    try:
        code = int(value)
    except (TypeError, ValueError):
        return value
    if 60 <= code <= 69:
        return "Passenger"
    if 70 <= code <= 79:
        return "Cargo"
    if 80 <= code <= 89:
        return "Tanker"
    known = {
        30: "Fishing",
        31: "Towing",
        32: "Towing",
        36: "Sailing",
        37: "Pleasure craft",
        50: "Pilot vessel",
        51: "Search and rescue",
        52: "Tug",
        53: "Port tender",
        55: "Law enforcement",
    }
    return known.get(code, f"AIS type {code}")


def format_ais_eta(eta):
    if not isinstance(eta, dict):
        return None
    month = eta.get("Month")
    day = eta.get("Day")
    hour = eta.get("Hour")
    minute = eta.get("Minute")
    if not any([month, day, hour, minute]):
        return None
    return f"{int(month):02d}-{int(day):02d} {int(hour):02d}{int(minute):02d}"


def normalize(record, source):
    vessel = {
        "mmsi": first_value(record, "mmsi", "MMSI"),
        "ship_name": first_value(record, "ship_name", "name", "vessel_name", "VesselName"),
        "call_sign": first_value(record, "call_sign", "callsign", "CallSign"),
        "imo": first_value(record, "imo", "IMO"),
        "lat": as_float(first_value(record, "lat", "latitude", "LAT", "BaseDateTimeLat")),
        "lon": as_float(first_value(record, "lon", "lng", "longitude", "LON", "BaseDateTimeLon")),
        "sog": as_float(first_value(record, "sog", "speed", "SOG")),
        "cog": as_float(first_value(record, "cog", "course", "COG")),
        "heading": as_float(first_value(record, "heading", "true_heading", "Heading", "TrueHeading")),
        "nav_status": first_value(record, "nav_status", "navigation_status", "status", "Status"),
        "destination": first_value(record, "destination", "dest", "Destination"),
        "eta": first_value(record, "eta", "ETA"),
        "draft": as_float(first_value(record, "draft", "draught", "Draft")),
        "cargo_type": first_value(record, "cargo_type", "ship_type", "vessel_type", "VesselType"),
        "last_seen": first_value(record, "last_seen", "timestamp", "BaseDateTime", "time"),
        "source": source,
    }
    return {field: vessel.get(field) for field in FIELDS}


def in_region(vessel):
    lat = vessel.get("lat")
    lon = vessel.get("lon")
    return (
        lat is not None
        and lon is not None
        and REGION_BBOX["min_lat"] <= lat <= REGION_BBOX["max_lat"]
        and REGION_BBOX["min_lon"] <= lon <= REGION_BBOX["max_lon"]
    )


def read_mock_records():
    with open("data/mock_vessels.json", encoding="utf-8") as file:
        return json.load(file)


def mock_provider():
    return [normalize(record, "mock") for record in read_mock_records()], None


def requested_provider_name():
    raw_provider = request.args.get("provider") or os.getenv("MARITIME_AIS_PROVIDER", "mock")
    provider_name = raw_provider.strip().lower()
    if provider_name in PROVIDERS:
        return provider_name, None
    return "mock", f"Unknown provider '{raw_provider}'; using demo mock data."


def live_json_provider():
    url = os.getenv("MARITIME_LIVE_AIS_URL")
    if not url:
        return [], "Set MARITIME_LIVE_AIS_URL to use a compatible live/open AIS JSON endpoint."

    try:
        req = Request(url, headers={"User-Agent": "maritime-vessel-tracker-poc/0.1"})
        with urlopen(req, timeout=8) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, URLError, json.JSONDecodeError) as exc:
        return [], f"Live provider unavailable: {exc}"

    records = payload.get("vessels", payload) if isinstance(payload, dict) else payload
    if not isinstance(records, list):
        return [], "Live provider response must be a JSON list or an object with a 'vessels' list."
    return [normalize(record, "live_json") for record in records if isinstance(record, dict)], None


def normalize_aisstream_message(envelope):
    message_type = envelope.get("MessageType")
    metadata = envelope.get("MetaData") or envelope.get("Metadata") or {}
    message = envelope.get("Message") or {}

    body = {}
    if isinstance(message, dict):
        body = message.get(message_type) or {}
        if not body and len(message) == 1:
            body = next(iter(message.values()))

    if not isinstance(metadata, dict):
        metadata = {}

    if not isinstance(body, dict) or not body:
        return None

    mmsi = first_value(body, "UserID") or first_value(metadata, "MMSI")
    if not mmsi:
        return None

    lat = as_float(first_value(body, "Latitude") or first_value(metadata, "Latitude", "latitude"))
    lon = as_float(first_value(body, "Longitude") or first_value(metadata, "Longitude", "longitude"))
    partial = {
        "mmsi": str(mmsi),
        "ship_name": clean_ais_text(first_value(metadata, "ShipName", "ship_name")),
        "lat": lat,
        "lon": lon,
        "sog": as_float(first_value(body, "Sog")),
        "cog": as_float(first_value(body, "Cog")),
        "heading": as_float(first_value(body, "TrueHeading")),
        "last_seen": first_value(metadata, "time_utc") or now_iso(),
        "source": "aisstream",
    }

    nav_status = first_value(body, "NavigationalStatus")
    if nav_status is not None:
        try:
            nav_status = int(nav_status)
        except (TypeError, ValueError):
            pass
        partial["nav_status"] = NAV_STATUS.get(nav_status, f"AIS nav status {nav_status}")

    if message_type == "ExtendedClassBPositionReport":
        partial["ship_name"] = clean_ais_text(first_value(body, "Name")) or partial["ship_name"]
        partial["cargo_type"] = ship_type_label(first_value(body, "Type"))

    if message_type == "ShipStaticData":
        partial.update(
            {
                "ship_name": clean_ais_text(first_value(body, "Name")),
                "call_sign": clean_ais_text(first_value(body, "CallSign")),
                "imo": first_value(body, "ImoNumber"),
                "destination": clean_ais_text(first_value(body, "Destination")),
                "eta": format_ais_eta(body.get("Eta")),
                "draft": as_float(first_value(body, "MaximumStaticDraught")),
                "cargo_type": ship_type_label(first_value(body, "Type")),
            }
        )

    if message_type == "StaticDataReport":
        report_a = body.get("ReportA") or {}
        report_b = body.get("ReportB") or {}
        partial.update(
            {
                "ship_name": clean_ais_text(first_value(report_a, "Name")),
                "call_sign": clean_ais_text(first_value(report_b, "CallSign")),
                "cargo_type": ship_type_label(first_value(report_b, "ShipType")),
            }
        )

    return {key: value for key, value in partial.items() if value not in ("", None)}


def merge_aisstream_vessel(partial):
    with AISSTREAM_LOCK:
        existing = AISSTREAM_CACHE.get(partial["mmsi"], normalize({}, "aisstream"))
        merged = {**existing, **partial}
        AISSTREAM_CACHE[partial["mmsi"]] = {field: merged.get(field) for field in FIELDS}
        AISSTREAM_STATUS["cached_vessels"] = len(AISSTREAM_CACHE)
        AISSTREAM_STATUS["cached_in_region"] = sum(1 for vessel in AISSTREAM_CACHE.values() if in_region(vessel))


def update_aisstream_status(**changes):
    with AISSTREAM_LOCK:
        AISSTREAM_STATUS.update(changes)


def increment_aisstream_status(key):
    with AISSTREAM_LOCK:
        AISSTREAM_STATUS[key] += 1


def aisstream_heartbeat_every():
    try:
        return int(os.getenv("AISSTREAM_HEARTBEAT_EVERY", "100"))
    except ValueError:
        return 100


def print_aisstream_heartbeat():
    interval = aisstream_heartbeat_every()
    if interval <= 0:
        return

    with AISSTREAM_LOCK:
        status = dict(AISSTREAM_STATUS)

    if status["messages_received"] and status["messages_received"] % interval == 0:
        print(
            "AIS heartbeat:",
            f"received={status['messages_received']}",
            f"parsed={status['parsed_messages']}",
            f"dropped={status['dropped_messages']}",
            f"cached={status['cached_vessels']}",
            f"in_region={status['cached_in_region']}",
            f"last_type={status['last_message_type']}",
            flush=True,
        )


def remember_aisstream_sample(envelope, partial):
    sample = {
        "received_at": now_iso(),
        "message_type": envelope.get("MessageType"),
        "parsed": bool(partial),
        "mmsi": partial.get("mmsi") if partial else None,
        "ship_name": partial.get("ship_name") if partial else None,
        "lat": partial.get("lat") if partial else None,
        "lon": partial.get("lon") if partial else None,
        "in_region": in_region(partial) if partial else False,
    }
    with AISSTREAM_LOCK:
        AISSTREAM_SAMPLES.append(sample)
        del AISSTREAM_SAMPLES[:-12]


def aisstream_subscription(api_key):
    subscription = {
        "APIKey": api_key,
        "BoundingBoxes": [
            [
                [REGION_BBOX["min_lat"], REGION_BBOX["min_lon"]],
                [REGION_BBOX["max_lat"], REGION_BBOX["max_lon"]],
            ]
        ],
        "FilterMessageTypes": aisstream_message_types(),
    }
    safe_subscription = {**subscription, "APIKey": "***"}
    return subscription, safe_subscription


async def aisstream_loop(api_key):
    global AISSTREAM_WARNING
    import websockets

    subscription, safe_subscription = aisstream_subscription(api_key)

    while True:
        try:
            update_aisstream_status(connected=False, subscription=safe_subscription)
            async with websockets.connect(AISSTREAM_URL, ping_interval=20, ping_timeout=20) as websocket:
                await websocket.send(json.dumps(subscription))
                AISSTREAM_WARNING = None
                update_aisstream_status(
                    connected=True,
                    last_error=None,
                    last_close_code=None,
                    last_close_reason=None,
                )
                async for raw_message in websocket:
                    increment_aisstream_status("messages_received")
                    envelope = json.loads(raw_message)
                    message_type = envelope.get("MessageType")
                    update_aisstream_status(last_message_at=now_iso(), last_message_type=message_type)

                    if "error" in envelope:
                        AISSTREAM_WARNING = f"AISStream error: {envelope['error']}"
                        update_aisstream_status(last_error=AISSTREAM_WARNING)
                        continue

                    partial = normalize_aisstream_message(envelope)
                    remember_aisstream_sample(envelope, partial)
                    if partial:
                        merge_aisstream_vessel(partial)
                        increment_aisstream_status("parsed_messages")
                    else:
                        increment_aisstream_status("dropped_messages")
                    print_aisstream_heartbeat()
        except websockets.exceptions.ConnectionClosed as exc:
            close_code = getattr(exc, "code", None)
            close_reason = getattr(exc, "reason", None)
            AISSTREAM_WARNING = f"AISStream closed the websocket. code={close_code} reason={close_reason or 'none'}"
            update_aisstream_status(
                connected=False,
                last_error=AISSTREAM_WARNING,
                last_close_code=close_code,
                last_close_reason=close_reason,
            )
            await asyncio.sleep(10)
        except Exception as exc:
            AISSTREAM_WARNING = f"AISStream connection unavailable: {exc}"
            update_aisstream_status(connected=False, last_error=AISSTREAM_WARNING)
            await asyncio.sleep(10)


def start_aisstream_thread(api_key):
    global AISSTREAM_THREAD
    if AISSTREAM_THREAD and AISSTREAM_THREAD.is_alive():
        return

    def run():
        asyncio.run(aisstream_loop(api_key))

    AISSTREAM_THREAD = threading.Thread(target=run, daemon=True)
    AISSTREAM_THREAD.start()


def aisstream_provider():
    api_key = os.getenv("AISSTREAM_API_KEY")
    if not api_key:
        return [], "Set AISSTREAM_API_KEY to use AISStream live websocket data."

    try:
        import websockets  # noqa: F401
    except ImportError:
        return [], "Install dependencies with: pip install -r requirements.txt"

    start_aisstream_thread(api_key)
    with AISSTREAM_LOCK:
        vessels = [
            v for v in AISSTREAM_CACHE.values()
            if v.get("lat") is not None and v.get("lon") is not None and in_region(v)
        ]
        status = dict(AISSTREAM_STATUS)
    warning = AISSTREAM_WARNING
    if not vessels:
        if status["connected"]:
            warning = "AISStream is connected, but no in-region live vessel positions are cached yet."
        else:
            warning = warning or "AISStream is starting; waiting for the websocket connection."
    return vessels, warning


def load_vessels(provider_name):
    if provider_name == "aisstream":
        vessels, warning = aisstream_provider()
        return vessels, warning, "aisstream"
    if provider_name == "live":
        vessels, warning = live_json_provider()
        return vessels, warning, "live"
    vessels, warning = mock_provider()
    return vessels, warning, "mock"


@app.get("/")
def index():
    requested_provider, _ = requested_provider_name()
    app_config = {
        "apiVesselsUrl": url_for("vessels", provider=requested_provider),
    }
    return render_template("index.html", app_config=app_config)


@app.get("/api/vessels")
def vessels():
    requested_provider, provider_warning = requested_provider_name()
    records, warning, active_provider = load_vessels(requested_provider)
    if active_provider != "aisstream":
        records = [record for record in records if in_region(record)]
    warnings = [message for message in (provider_warning, warning) if message]
    return jsonify(
        {
            "bbox": REGION_BBOX,
            "provider": active_provider,
            "provider_label": PROVIDERS[active_provider],
            "requested_provider": requested_provider,
            "warning": " ".join(warnings) or None,
            "last_refresh": now_iso(),
            "count": len(records),
            "vessels": records,
        }
    )


@app.get("/api/aisstream/status")
def aisstream_status():
    api_key = os.getenv("AISSTREAM_API_KEY")
    if api_key:
        start_aisstream_thread(api_key)
    with AISSTREAM_LOCK:
        return jsonify(
            {
                **AISSTREAM_STATUS,
                "cached_vessels": len(AISSTREAM_CACHE),
                "thread_alive": bool(AISSTREAM_THREAD and AISSTREAM_THREAD.is_alive()),
                "has_api_key": bool(api_key),
                "bbox": REGION_BBOX,
                "message_types": aisstream_message_types(),
                "recent_samples": list(AISSTREAM_SAMPLES),
                "warning": AISSTREAM_WARNING,
            }
        )

@app.get("/api/debug/cache-stats")
def cache_stats():
    with AISSTREAM_LOCK:
        vessels = list(AISSTREAM_CACHE.values())

    with_coords = [v for v in vessels if v.get("lat") is not None and v.get("lon") is not None]
    in_box = [v for v in with_coords if in_region(v)]

    return jsonify({
        "cached_total": len(vessels),
        "with_coords": len(with_coords),
        "in_region": len(in_box),
        "sample_with_coords": with_coords[:5],
        "sample_in_region": in_box[:5],
    })

if __name__ == "__main__":
    app.run(debug=True, use_reloader=False)
