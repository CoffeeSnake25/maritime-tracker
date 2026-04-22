# Hormuz Vessel Tracker POC

A lightweight proof-of-concept vessel-tracking web app for the Strait of Hormuz region. It uses Flask for a tiny backend, Leaflet for the map, no database, and a mock provider so it works offline.

## What It Shows

- Interactive Leaflet map with vessel markers
- Clickable vessel detail popups
- Side-panel vessel list
- Search by ship name or MMSI
- Basic cargo type and navigation status filters
- Last refresh time
- Graceful `Unknown` values for missing AIS fields
- Backend normalization into one vessel schema
- Bounding-box filtering for the Persian Gulf, Strait of Hormuz, Gulf of Oman, and nearby Arabian Sea waters

## Project Structure

```text
.
├── app.py
├── data/
│   └── mock_vessels.json
├── requirements.txt
├── static/
│   ├── app.js
│   └── styles.css
└── templates/
    └── index.html
```

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
flask --app app run --debug
```

Open `http://127.0.0.1:5000`.

The default provider is the offline mock dataset in `data/mock_vessels.json`.

## AISStream Live Provider

AISStream provides live AIS messages over a websocket. Their documentation says browser connections are not supported and API keys should not be exposed client-side, so this app consumes AISStream on the Flask backend and keeps the latest messages in memory.

Install dependencies, set your key, and run:

```bash
source .venv/bin/activate
pip install -r requirements.txt
export HORMUZ_AIS_PROVIDER=aisstream
export AISSTREAM_API_KEY="your_key_here"
flask --app app run --debug --no-reload --port 5001
```

The AISStream provider subscribes to this app's bounding box and position-capable messages by default:

```text
PositionReport, StandardClassBPositionReport, ExtendedClassBPositionReport
```

Position messages and static-data messages arrive separately. The default live mode focuses on positions so the map populates first. Some fields may remain `Unknown` until static-data messages are enabled and received for the same MMSI.

To experiment with extra AISStream message types:

```bash
export AISSTREAM_MESSAGE_TYPES="PositionReport,StandardClassBPositionReport,ExtendedClassBPositionReport,ShipStaticData,StaticDataReport"
```

If `AISSTREAM_API_KEY` is missing, the websocket is unavailable, or no live messages have arrived for the region yet, the app falls back to mock data and shows a warning.

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
export HORMUZ_AIS_PROVIDER=live
export HORMUZ_LIVE_AIS_URL="https://example.org/vessels.json"
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

If the live provider is unavailable, returns no records, or is not configured, the app falls back to mock data and shows a warning in the UI.

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

This is intentionally broad for a POC and covers the Persian Gulf, Strait of Hormuz, Gulf of Oman, and nearby Arabian Sea approaches.

## Swapping In A Future Provider

Keep the UI unchanged and add a new provider function in `app.py` that:

1. Fetches or reads source records.
2. Calls `normalize(record, "your_source_name")` for each record.
3. Returns `(vessels, warning)` like `mock_provider()` and `live_json_provider()`.
4. Add a branch in `load_vessels()` for the new provider name.

Avoid adding fields unless the upstream provider actually supplies them.
