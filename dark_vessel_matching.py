from datetime import datetime, timezone
from math import asin, cos, radians, sin, sqrt


MATCH_DISTANCE_KM = 2.0
MATCH_TIME_WINDOW_MINUTES = 30
EARTH_RADIUS_KM = 6371.0


def parse_iso_datetime(value):
    if not value:
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def as_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def haversine_km(lat_a, lon_a, lat_b, lon_b):
    lat_a = as_float(lat_a)
    lon_a = as_float(lon_a)
    lat_b = as_float(lat_b)
    lon_b = as_float(lon_b)
    if None in (lat_a, lon_a, lat_b, lon_b):
        return None

    d_lat = radians(lat_b - lat_a)
    d_lon = radians(lon_b - lon_a)
    a = (
        sin(d_lat / 2) ** 2
        + cos(radians(lat_a)) * cos(radians(lat_b)) * sin(d_lon / 2) ** 2
    )
    return EARTH_RADIUS_KM * 2 * asin(sqrt(a))


def time_delta_minutes(a, b):
    parsed_a = parse_iso_datetime(a)
    parsed_b = parse_iso_datetime(b)
    if not parsed_a or not parsed_b:
        return None
    return abs((parsed_a - parsed_b).total_seconds()) / 60


def vessel_label(vessel):
    return vessel.get("ship_name") or f"MMSI {vessel.get('mmsi') or 'Unknown'}"


def compact_vessel(vessel):
    if not vessel:
        return None
    return {
        "mmsi": vessel.get("mmsi"),
        "ship_name": vessel.get("ship_name"),
        "lat": vessel.get("lat"),
        "lon": vessel.get("lon"),
        "last_seen": vessel.get("last_seen"),
        "source": vessel.get("source"),
    }


def compare_detection_to_vessel(detection, vessel):
    distance_km = haversine_km(
        detection.get("lat"),
        detection.get("lon"),
        vessel.get("lat"),
        vessel.get("lon"),
    )
    delta_minutes = time_delta_minutes(detection.get("detected_at"), vessel.get("last_seen"))
    passes_distance = distance_km is not None and distance_km <= MATCH_DISTANCE_KM
    passes_time = delta_minutes is not None and delta_minutes <= MATCH_TIME_WINDOW_MINUTES
    return {
        "vessel": vessel,
        "distance_km": round(distance_km, 3) if distance_km is not None else None,
        "time_delta_minutes": round(delta_minutes, 1) if delta_minutes is not None else None,
        "passes_distance": passes_distance,
        "passes_time": passes_time,
        "passes_match": passes_distance and passes_time,
    }


def detection_result(detection, vessels):
    comparisons = [compare_detection_to_vessel(detection, vessel) for vessel in vessels]
    valid_distance = [item for item in comparisons if item["distance_km"] is not None]
    nearest = min(valid_distance, key=lambda item: item["distance_km"], default=None)
    matches = [item for item in comparisons if item["passes_match"]]
    match = min(
        matches,
        key=lambda item: (item["distance_km"], item["time_delta_minutes"]),
        default=None,
    )
    nearest_within_distance = min(
        [item for item in comparisons if item["passes_distance"] and item["time_delta_minutes"] is not None],
        key=lambda item: item["time_delta_minutes"],
        default=None,
    )

    if match:
        reason = (
            f"Matched AIS vessel {vessel_label(match['vessel'])}: "
            f"{match['distance_km']} km away and {match['time_delta_minutes']} minutes apart."
        )
    elif nearest_within_distance and not nearest_within_distance["passes_time"]:
        reason = (
            "No AIS vessel passed both thresholds. Nearest spatial AIS vessel was "
            f"{nearest_within_distance['distance_km']} km away but "
            f"{nearest_within_distance['time_delta_minutes']} minutes apart."
        )
    elif nearest:
        reason = (
            "No AIS vessel passed both thresholds. Nearest AIS vessel was "
            f"{nearest['distance_km']} km away and "
            f"{nearest['time_delta_minutes']} minutes apart."
        )
    else:
        reason = "No AIS vessel could be compared because coordinates or timestamps were missing."

    return {
        "detection": detection,
        "is_anomaly_candidate": match is None,
        "matched_vessel": compact_vessel(match["vessel"]) if match else None,
        "nearest_vessel": compact_vessel(nearest["vessel"]) if nearest else None,
        "distance_km": match["distance_km"] if match else nearest["distance_km"] if nearest else None,
        "time_delta_minutes": (
            match["time_delta_minutes"] if match else nearest["time_delta_minutes"] if nearest else None
        ),
        "passes_distance": match["passes_distance"] if match else nearest["passes_distance"] if nearest else False,
        "passes_time": match["passes_time"] if match else nearest["passes_time"] if nearest else False,
        "reason": reason,
    }


def detection_results(detections, vessels):
    return [detection_result(detection, vessels) for detection in detections]


def anomaly_candidates(detections, vessels):
    return [result for result in detection_results(detections, vessels) if result["is_anomaly_candidate"]]


def threshold_metadata():
    return {
        "distance_km": MATCH_DISTANCE_KM,
        "time_window_minutes": MATCH_TIME_WINDOW_MINUTES,
    }
