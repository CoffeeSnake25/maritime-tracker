# Dark Vessel Anomaly POC

A lightweight proof-of-concept for rule-based dark vessel anomaly detection. It
uses Flask for a tiny backend, Leaflet for the map, no database, and deterministic
mock data so the UI and anomaly rules can be reviewed offline.

The v1 anomaly rule compares mock satellite-derived vessel detections against
mock AIS vessel records. A satellite detection is flagged as an anomaly candidate
when no AIS vessel is within both `2.0 km` and `+/-30 minutes`.

## What It Shows

- Interactive Leaflet map with vessel markers
- Mock satellite detection markers
- Highlighted anomaly candidate markers
- Evidence view modes for all data, AIS only, satellite only, or anomalies only
- Visible/total counts for AIS, satellite detections, and anomalies
- Compact marker legend
- Clickable vessel detail popups
- Explanatory anomaly popups with distance and time-window details
- Side-panel vessel list
- Search by ship name or MMSI
- Basic cargo type and navigation status filters
- Last refresh time
- Graceful `Unknown` values for missing AIS fields
- Backend normalization into one vessel schema
- Bounding-box filtering for the current proof-of-concept map region
- Provider selection for static mock demos, local AISStream development, and compatible JSON feeds
- Deterministic mock-only anomaly endpoints for the v1 POC

## Project Structure

```text
.
├── app.py
├── dark_vessel_matching.py
├── data/
│   ├── mock_satellite_detections.json
│   └── mock_vessels.json
├── docs/
│   ├── app.js
│   ├── index.html
│   ├── mock_anomalies.json
│   ├── mock_detection_results.json
│   ├── mock_satellite_detections.json
│   ├── mock_vessels.json
│   └── styles.css
├── requirements.txt
├── static/
│   ├── app.js
│   └── styles.css
├── tests/
│   └── test_dark_vessel_matching.py
└── templates/
    └── index.html
```

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Demo Mode

```bash
flask --app app run --debug
```

Open `http://127.0.0.1:5000`.

The default behavior is demo mode. It uses the offline mock dataset in
`data/mock_vessels.json` plus `data/mock_satellite_detections.json`, so the app
is stable for UI feedback and does not need AISStream credentials or network
access.

You can also make the default explicit:

```bash
export MARITIME_AIS_PROVIDER=mock
flask --app app run --debug
```

## Provider Selection

The Flask backend is the source of truth for provider selection. It accepts:

```text
mock       Demo mode with local mock data
aisstream  Local AISStream websocket mode
live       Generic live JSON endpoint mode
```

Provider selection order:

1. `?provider=...` query parameter
2. `MARITIME_AIS_PROVIDER`
3. `mock`

Examples:

```text
http://127.0.0.1:5000/?provider=mock
http://127.0.0.1:5000/?provider=aisstream
http://127.0.0.1:5000/api/vessels?provider=aisstream
```

Live providers do not fall back to mock data. If a live provider is missing
configuration, unavailable, or has no in-region records yet, the API returns
that provider with a warning so live-data bugs stay visible.

The anomaly endpoints are intentionally different in v1: they always use
deterministic mock AIS and mock satellite detections, regardless of selected
live provider. This keeps rule review stable while AISStream integration evolves.

## Dark Vessel API

The matching rule is:

```text
distance_km <= 2.0 AND abs(satellite_detected_at - ais_last_seen) <= 30 minutes
```

If no AIS record passes both thresholds, the satellite detection is returned as
an anomaly candidate.

### `GET /api/satellite-detections`

Returns the mock satellite detections used by the v1 matcher.

```json
{
  "thresholds": {"distance_km": 2.0, "time_window_minutes": 30},
  "last_refresh": "2026-05-01T12:00:00+00:00",
  "count": 4,
  "detections": [
    {
      "detection_id": "SAT-001",
      "lat": 26.5485,
      "lon": 56.2847,
      "detected_at": "2026-04-21T13:23:00Z",
      "confidence": 0.91,
      "source": "mock_satellite",
      "notes": "Matched detection near GULF TRADER"
    }
  ]
}
```

### `GET /api/detection-results`

Returns every satellite detection with match/anomaly metadata.

```json
{
  "thresholds": {"distance_km": 2.0, "time_window_minutes": 30},
  "last_refresh": "2026-05-01T12:00:00+00:00",
  "count": 4,
  "anomaly_count": 3,
  "results": [
    {
      "detection": {"detection_id": "SAT-001"},
      "is_anomaly_candidate": false,
      "matched_vessel": {"mmsi": "636018124", "ship_name": "GULF TRADER"},
      "nearest_vessel": {"mmsi": "636018124", "ship_name": "GULF TRADER"},
      "distance_km": 0.089,
      "time_delta_minutes": 3.0,
      "passes_distance": true,
      "passes_time": true,
      "reason": "Matched AIS vessel GULF TRADER: 0.089 km away and 3.0 minutes apart."
    }
  ]
}
```

### `GET /api/anomalies`

Returns only detection results where no AIS vessel passed both thresholds.

```json
{
  "thresholds": {"distance_km": 2.0, "time_window_minutes": 30},
  "last_refresh": "2026-05-01T12:00:00+00:00",
  "count": 3,
  "anomalies": [
    {
      "detection": {"detection_id": "SAT-002"},
      "is_anomaly_candidate": true,
      "matched_vessel": null,
      "nearest_vessel": {"mmsi": "636018124", "ship_name": "GULF TRADER"},
      "distance_km": 4.576,
      "time_delta_minutes": 1.0,
      "passes_distance": false,
      "passes_time": true,
      "reason": "No AIS vessel passed both thresholds. Nearest AIS vessel was 4.576 km away and 1.0 minutes apart."
    }
  ]
}
```

## Tests

```bash
python -m unittest
```

Manual Flask verification:

1. Run `flask --app app run --debug`.
2. Open `http://127.0.0.1:5000`.
3. Confirm AIS vessel markers, satellite detection markers, and anomaly markers render.
4. Confirm `All Evidence`, `AIS Only`, `Satellite Only`, and `Anomalies Only` show the expected layers.
5. Confirm AIS, satellite, and anomaly counts update when view modes or bounding-box filters change.
6. Confirm popups explain the `2.0 km` and `+/-30 minutes` rule result.
7. Confirm search, cargo/status filters, refresh, cursor coordinates, and bounding-box controls still work.

Manual static docs verification:

1. Run `python3 -m http.server 8000 -d docs` or open the GitHub Pages demo.
2. Confirm it loads `docs/mock_vessels.json` and `docs/mock_detection_results.json`.
3. Confirm AIS, satellite detection, anomaly markers, view modes, counts, and legend render without Flask.

## AISStream Live Provider

AISStream provides live AIS messages over a websocket. Their documentation says browser connections are not supported and API keys should not be exposed client-side, so this app consumes AISStream on the Flask backend and keeps the latest messages in memory.

Install dependencies, set your key, and run:

```bash
source .venv/bin/activate
pip install -r requirements.txt
export MARITIME_AIS_PROVIDER=aisstream
export AISSTREAM_API_KEY="your_key_here"
flask --app app run --debug --no-reload --port 5001
```

Open `http://127.0.0.1:5001`.

Alternatively, keep the environment default as mock and request live mode only
for a browser session:

```bash
export AISSTREAM_API_KEY="your_key_here"
flask --app app run --debug --no-reload --port 5001
```

Open `http://127.0.0.1:5001/?provider=aisstream`.

The AISStream provider subscribes to this app's bounding box and position-capable messages by default:

```text
PositionReport, StandardClassBPositionReport, ExtendedClassBPositionReport
```

Position messages and static-data messages arrive separately. The default live mode focuses on positions so the map populates first. Some fields may remain `Unknown` until static-data messages are enabled and received for the same MMSI.

To experiment with extra AISStream message types:

```bash
export AISSTREAM_MESSAGE_TYPES="PositionReport,StandardClassBPositionReport,ExtendedClassBPositionReport,ShipStaticData,StaticDataReport"
```

If `AISSTREAM_API_KEY` is missing, the websocket is unavailable, or no live
messages have arrived for the region yet, the app shows a warning and returns
the current AISStream live cache without substituting mock records.

Debug endpoints:

```text
http://127.0.0.1:5001/api/aisstream/status
http://127.0.0.1:5001/api/debug/cache-stats
```

AISStream documentation: `https://aisstream.io/documentation`

## Generic Live JSON Provider

Truly open, free, live global AIS data is limited. Many common maritime APIs either require paid access, contributor status, API approval, or do not permit redistribution. This POC also includes a generic pluggable JSON provider without inventing unavailable fields.

To try a compatible live/open JSON endpoint instead of AISStream:

```bash
export MARITIME_AIS_PROVIDER=live
export MARITIME_LIVE_AIS_URL="https://example.org/vessels.json"
flask --app app run --debug
```

The live endpoint should return either:

```json
[
  {"mmsi": "123456789", "ship_name": "EXAMPLE", "lat": 26.5, "lon": 56.3}
]
```

or:

```json
{
  "vessels": [
    {"mmsi": "123456789", "ship_name": "EXAMPLE", "lat": 26.5, "lon": 56.3}
  ]
}
```

If the live provider is unavailable, returns no records, or is not configured,
the app shows a warning and does not substitute mock records.

## Normalized Vessel Schema

Every provider is normalized to:

```text
mmsi, ship_name, call_sign, imo, lat, lon, sog, cog, heading,
nav_status, destination, eta, draft, cargo_type, last_seen, source
```

Unavailable fields are returned as `null` by the backend and displayed as `Unknown` in the UI.

## Region Filter

The backend filters vessels to this bounding box:

```json
{
  "min_lat": 20.0,
  "max_lat": 31.0,
  "min_lon": 47.0,
  "max_lon": 65.0
}
```

This is intentionally broad for the current POC map region. You can change the
bounding box in `app.py` when experimenting with other maritime regions.

## Swapping In A Future Provider

Keep the UI unchanged and add a new provider function in `app.py` that:

1. Fetches or reads source records.
2. Calls `normalize(record, "your_source_name")` for each record.
3. Returns `(vessels, warning)` like `mock_provider()` and `live_json_provider()`.
4. Add a branch in `load_vessels()` for the new provider name.

Avoid adding fields unless the upstream provider actually supplies them.
