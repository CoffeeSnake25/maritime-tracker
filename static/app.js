const map = L.map("map", { preferCanvas: true }).setView([25.9, 56.3], 6);

const basemaps = [
  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
  }),
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap contributors",
  }),
];

let activeBasemap = 0;
basemaps[activeBasemap].addTo(map);
basemaps[activeBasemap].on("tileerror", () => {
  if (activeBasemap === 0) {
    map.removeLayer(basemaps[0]);
    activeBasemap = 1;
    basemaps[1].addTo(map);
  }
});

const markers = new Map();
const satelliteLayer = L.layerGroup().addTo(map);
const anomalyLayer = L.layerGroup().addTo(map);
let allVessels = [];
let detectionResults = [];
let loading = false;
let selectedMarkerKey = null;
let drawModeActive = false;
let boxFilterActive = false;
let currentBox = null;
let boxLayer = null;
let drawStartLatLng = null;
let isDrawingBox = false;
const config = window.MARITIME_TRACKER_CONFIG || {};
const apiVesselsUrl = config.apiVesselsUrl || "/api/vessels";
const apiDetectionResultsUrl = config.apiDetectionResultsUrl || "/api/detection-results";

const els = {
  search: document.querySelector("#search"),
  cargo: document.querySelector("#cargoFilter"),
  status: document.querySelector("#statusFilter"),
  refresh: document.querySelector("#refresh"),
  list: document.querySelector("#vesselList"),
  summary: document.querySelector("#summary"),
  provider: document.querySelector("#provider"),
  lastRefresh: document.querySelector("#lastRefresh"),
  warning: document.querySelector("#warning"),
  coordsToggle: document.querySelector("#coordsToggle"),
  cursorCoords: document.querySelector("#cursorCoords"),
  drawBox: document.querySelector("#drawBox"),
  applyBox: document.querySelector("#applyBox"),
  clearBox: document.querySelector("#clearBox"),
  boxSummary: document.querySelector("#boxSummary"),
  drawHint: document.querySelector("#drawHint"),
};

function value(v) {
  return v === null || v === undefined || v === "" ? "Unknown" : v;
}

function formatNumber(v, digits = 1) {
  return Number.isFinite(v) ? v.toFixed(digits) : value(v);
}

function label(vessel) {
  return value(vessel.ship_name) !== "Unknown" ? vessel.ship_name : `MMSI ${value(vessel.mmsi)}`;
}

function vesselKey(vessel) {
  return vessel.mmsi || `${vessel.lat},${vessel.lon}`;
}

function popupHtml(vessel) {
  const rows = [
    ["MMSI", vessel.mmsi],
    ["Call sign", vessel.call_sign],
    ["IMO", vessel.imo],
    ["Position", vessel.lat !== null && vessel.lon !== null ? `${vessel.lat.toFixed(4)}, ${vessel.lon.toFixed(4)}` : null],
    ["SOG", vessel.sog !== null ? `${vessel.sog} kn` : null],
    ["COG", vessel.cog !== null ? `${vessel.cog} deg` : null],
    ["Heading", vessel.heading !== null ? `${vessel.heading} deg` : null],
    ["Status", vessel.nav_status],
    ["Destination", vessel.destination],
    ["ETA", vessel.eta],
    ["Draft", vessel.draft !== null ? `${vessel.draft} m` : null],
    ["Cargo", vessel.cargo_type],
  ];
  return `
    <h2 class="popup-title">${label(vessel)}</h2>
    <dl class="popup-grid">
      ${rows.map(([key, val]) => `<dt>${key}</dt><dd>${value(val)}</dd>`).join("")}
    </dl>
  `;
}

function setOptions(select, vessels, key, allLabel) {
  const current = select.value;
  const values = [...new Set(vessels.map((v) => v[key]).filter(Boolean))].sort();
  select.innerHTML = `<option value="">${allLabel}</option>`;
  for (const item of values) {
    const option = document.createElement("option");
    option.value = item;
    option.textContent = item;
    select.append(option);
  }
  select.value = values.includes(current) ? current : "";
}

function filteredVessels() {
  const query = els.search.value.trim().toLowerCase();
  const vessels = boxFilterActive ? allVessels.filter((vessel) => isVesselInBox(vessel, currentBox)) : allVessels;
  return vessels.filter((vessel) => {
    const matchesSearch =
      !query ||
      String(vessel.ship_name || "").toLowerCase().includes(query) ||
      String(vessel.mmsi || "").includes(query);
    const matchesCargo = !els.cargo.value || vessel.cargo_type === els.cargo.value;
    const matchesStatus = !els.status.value || vessel.nav_status === els.status.value;
    return matchesSearch && matchesCargo && matchesStatus;
  });
}

function areaVesselCount() {
  return currentBox ? allVessels.filter((vessel) => isVesselInBox(vessel, currentBox)).length : allVessels.length;
}

function hasActiveListFilters() {
  return Boolean(els.search.value.trim() || els.cargo.value || els.status.value);
}

function vesselWord(count) {
  return count === 1 ? "vessel" : "vessels";
}

function countSummary(visibleCount, totalCount) {
  const anomalyCount = detectionResults.filter((result) => result.is_anomaly_candidate).length;
  const anomalyText = detectionResults.length ? ` · ${anomalyCount} anomaly candidates` : "";
  if (boxFilterActive) {
    const text = visibleCount === totalCount && !hasActiveListFilters()
      ? `${visibleCount} ${vesselWord(visibleCount)} in selected area`
      : `${visibleCount} of ${totalCount} vessels in selected area`;
    return `${text}${anomalyText}`;
  }
  const text = visibleCount === totalCount && !hasActiveListFilters()
    ? `${visibleCount} ${vesselWord(visibleCount)} in region`
    : `${visibleCount} of ${totalCount} vessels`;
  return `${text}${anomalyText}`;
}

function formatLatLng(latlng) {
  return `Lat ${latlng.lat.toFixed(4)}, Lon ${latlng.lng.toFixed(4)}`;
}

function formatBox(box) {
  return `${box.min_lat.toFixed(4)}-${box.max_lat.toFixed(4)} N, ${box.min_lon.toFixed(4)}-${box.max_lon.toFixed(4)} E`;
}

function boxFromLatLngs(a, b) {
  return {
    min_lat: Math.min(a.lat, b.lat),
    max_lat: Math.max(a.lat, b.lat),
    min_lon: Math.min(a.lng, b.lng),
    max_lon: Math.max(a.lng, b.lng),
  };
}

function boxBounds(box) {
  return [
    [box.min_lat, box.min_lon],
    [box.max_lat, box.max_lon],
  ];
}

function hasMeaningfulBox(a, b) {
  return map.latLngToContainerPoint(a).distanceTo(map.latLngToContainerPoint(b)) >= 8;
}

function hasVesselCoords(vessel) {
  return Number.isFinite(vessel.lat) && Number.isFinite(vessel.lon);
}

function isVesselInBox(vessel, box) {
  if (!box || !hasVesselCoords(vessel)) {
    return false;
  }
  return vessel.lat >= box.min_lat && vessel.lat <= box.max_lat && vessel.lon >= box.min_lon && vessel.lon <= box.max_lon;
}

function createBoxLayer(bounds) {
  return L.rectangle(bounds, {
    color: "#0b7b87",
    fillColor: "#179bb0",
    fillOpacity: 0.08,
    opacity: 0.72,
    weight: 2,
    dashArray: "7 6",
    interactive: false,
  }).addTo(map);
}

function removeBoxLayer() {
  if (boxLayer) {
    boxLayer.remove();
    boxLayer = null;
  }
}

function updateBoxControls() {
  const hasBox = Boolean(currentBox);
  els.drawBox.classList.toggle("map-tool-button-active", drawModeActive);
  els.drawBox.setAttribute("aria-pressed", String(drawModeActive));
  els.applyBox.hidden = !hasBox;
  els.applyBox.disabled = !hasBox;
  els.clearBox.hidden = !hasBox;
  els.clearBox.disabled = !hasBox;
  els.boxSummary.hidden = !hasBox;
  els.boxSummary.textContent = hasBox ? formatBox(currentBox) : "";
  els.drawHint.hidden = !drawModeActive;
}

function setDrawMode(active) {
  drawModeActive = active;
  isDrawingBox = false;
  drawStartLatLng = null;
  map.getContainer().classList.toggle("map-drawing-box", active);
  if (active) {
    map.closePopup();
    map.dragging.disable();
  } else {
    map.dragging.enable();
  }
  updateBoxControls();
}

function startBoxDrawing(event) {
  if (!drawModeActive) {
    return;
  }
  L.DomEvent.preventDefault(event.originalEvent);
  map.closePopup();
  removeBoxLayer();
  currentBox = null;
  boxFilterActive = false;
  isDrawingBox = true;
  drawStartLatLng = event.latlng;
  boxLayer = createBoxLayer([drawStartLatLng, drawStartLatLng]);
  updateBoxControls();
  render();
}

function updateBoxDrawing(event) {
  if (!drawModeActive || !isDrawingBox || !boxLayer) {
    return;
  }
  boxLayer.setBounds([drawStartLatLng, event.latlng]);
}

function finishBoxDrawing(event) {
  if (!drawModeActive || !isDrawingBox) {
    return;
  }
  if (!hasMeaningfulBox(drawStartLatLng, event.latlng)) {
    removeBoxLayer();
    currentBox = null;
    boxFilterActive = false;
    setDrawMode(false);
    render();
    return;
  }
  currentBox = boxFromLatLngs(drawStartLatLng, event.latlng);
  boxLayer.setBounds(boxBounds(currentBox));
  boxFilterActive = false;
  setDrawMode(false);
  render();
}

function cancelBoxDrawing() {
  if (!drawModeActive) {
    return;
  }
  if (isDrawingBox) {
    removeBoxLayer();
    currentBox = null;
    boxFilterActive = false;
    render();
  }
  setDrawMode(false);
}

function clearBox() {
  removeBoxLayer();
  currentBox = null;
  boxFilterActive = false;
  setDrawMode(false);
  render();
}

function applyBoxFilter() {
  if (!currentBox) {
    return;
  }
  boxFilterActive = true;
  updateBoxControls();
  render();
}

function updateCursorCoords(latlng) {
  if (!els.coordsToggle.checked) {
    return;
  }
  els.cursorCoords.textContent = formatLatLng(latlng);
}

function setCursorCoordsVisibility() {
  els.cursorCoords.hidden = !els.coordsToggle.checked;
  if (els.coordsToggle.checked && !els.cursorCoords.textContent) {
    els.cursorCoords.textContent = "Lat --, Lon --";
  }
}

function clearCursorCoords() {
  if (els.coordsToggle.checked) {
    els.cursorCoords.textContent = "Lat --, Lon --";
  }
}

function markerStyle(vessel, selected = false, dimmed = false) {
  return {
    radius: selected ? 9 : 7,
    color: selected ? "#063f42" : "#0c6b70",
    fillColor: vessel.nav_status === "At anchor" ? "#d89526" : "#1d9a8a",
    fillOpacity: selected ? 0.96 : dimmed ? 0.5 : 0.85,
    opacity: selected ? 1 : dimmed ? 0.58 : 1,
    weight: selected ? 3 : 2,
  };
}

function detectionMarkerStyle(isAnomaly) {
  return {
    radius: isAnomaly ? 10 : 6,
    color: isAnomaly ? "#7a1f1f" : "#473a8f",
    fillColor: isAnomaly ? "#e24b3b" : "#7b68d8",
    fillOpacity: isAnomaly ? 0.92 : 0.72,
    opacity: 1,
    weight: isAnomaly ? 3 : 2,
    dashArray: isAnomaly ? null : "4 3",
  };
}

function detectionPopupHtml(result) {
  const detection = result.detection;
  const rows = [
    ["Detected at", detection.detected_at],
    ["Position", Number.isFinite(detection.lat) && Number.isFinite(detection.lon) ? `${detection.lat.toFixed(4)}, ${detection.lon.toFixed(4)}` : null],
    ["Confidence", Number.isFinite(detection.confidence) ? `${Math.round(detection.confidence * 100)}%` : null],
    ["Nearest AIS", result.nearest_vessel ? label(result.nearest_vessel) : null],
    ["Matched AIS", result.matched_vessel ? label(result.matched_vessel) : null],
    ["Distance", result.distance_km !== null ? `${formatNumber(result.distance_km, 2)} km` : null],
    ["Time delta", result.time_delta_minutes !== null ? `${formatNumber(result.time_delta_minutes, 1)} min` : null],
    ["Thresholds", "2.0 km and +/-30 min"],
  ];
  return `
    <h2 class="popup-title">${result.is_anomaly_candidate ? "Anomaly candidate" : "Satellite detection"} ${value(detection.detection_id)}</h2>
    <p class="popup-reason">${value(result.reason)}</p>
    <dl class="popup-grid">
      ${rows.map(([key, val]) => `<dt>${key}</dt><dd>${value(val)}</dd>`).join("")}
    </dl>
  `;
}

function renderDetectionLayers() {
  satelliteLayer.clearLayers();
  anomalyLayer.clearLayers();
  for (const result of detectionResults) {
    const detection = result.detection;
    if (!Number.isFinite(detection.lat) || !Number.isFinite(detection.lon)) {
      continue;
    }
    const layer = result.is_anomaly_candidate ? anomalyLayer : satelliteLayer;
    L.circleMarker([detection.lat, detection.lon], detectionMarkerStyle(result.is_anomaly_candidate))
      .bindPopup(detectionPopupHtml(result), {
        offset: L.point(0, -10),
        autoPanPadding: L.point(18, 18),
        maxWidth: 320,
      })
      .addTo(layer);
  }
}

function updateMarkerFocus() {
  for (const [key, marker] of markers) {
    const selected = key === selectedMarkerKey;
    marker.setStyle(markerStyle(marker.vessel, selected, Boolean(selectedMarkerKey && !selected)));
    if (selected) {
      marker.bringToFront();
    }
  }
}

function render() {
  const vessels = filteredVessels();
  const total = boxFilterActive ? areaVesselCount() : allVessels.length;

  for (const marker of markers.values()) {
    marker.remove();
  }
  markers.clear();
  els.list.innerHTML = "";

  for (const vessel of vessels) {
    const key = vesselKey(vessel);
    const marker = L.circleMarker([vessel.lat, vessel.lon], markerStyle(vessel)).addTo(map);
    marker.vessel = vessel;
    marker.bindPopup(popupHtml(vessel), {
      offset: L.point(0, -10),
      autoPanPadding: L.point(18, 18),
      maxWidth: 320,
    });
    marker.on("popupopen", () => {
      selectedMarkerKey = key;
      updateMarkerFocus();
    });
    marker.on("popupclose", () => {
      if (selectedMarkerKey === key) {
        selectedMarkerKey = null;
        updateMarkerFocus();
      }
    });
    markers.set(key, marker);

    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.innerHTML = `
      <div class="vessel-title"><span>${label(vessel)}</span><span>${value(vessel.mmsi)}</span></div>
      <div class="vessel-subtitle">${value(vessel.cargo_type)} · ${value(vessel.nav_status)}</div>
    `;
    button.addEventListener("click", () => {
      map.setView([vessel.lat, vessel.lon], Math.max(map.getZoom(), 8));
      marker.openPopup();
    });
    item.append(button);
    els.list.append(item);
  }

  if (selectedMarkerKey && !markers.has(selectedMarkerKey)) {
    selectedMarkerKey = null;
  }
  updateMarkerFocus();
  renderDetectionLayers();

  els.summary.textContent = countSummary(vessels.length, total);
  map.invalidateSize();
}

async function loadVessels() {
  if (loading) {
    return;
  }
  loading = true;
  els.refresh.disabled = true;
  els.summary.textContent = "Loading vessels...";
  try {
    const response = await fetch(apiVesselsUrl);
    const data = await response.json();
    const detectionResponse = await fetch(apiDetectionResultsUrl);
    const detectionData = await detectionResponse.json();
    allVessels = data.vessels;
    detectionResults = detectionData.results || [];
    setOptions(els.cargo, allVessels, "cargo_type", "All cargo types");
    setOptions(els.status, allVessels, "nav_status", "All navigation statuses");
    els.provider.textContent = data.provider_label || `Provider: ${data.provider}`;
    els.lastRefresh.textContent = `Last refresh: ${new Date(data.last_refresh).toLocaleString()}`;
    els.warning.hidden = !data.warning;
    els.warning.textContent = data.warning || "";
    render();
  } catch (error) {
    els.summary.textContent = "Unable to load vessels";
    els.warning.hidden = false;
    els.warning.textContent = error.message;
  } finally {
    els.refresh.disabled = false;
    loading = false;
  }
}

els.search.addEventListener("input", render);
els.cargo.addEventListener("change", render);
els.status.addEventListener("change", render);
els.refresh.addEventListener("click", loadVessels);
els.coordsToggle.addEventListener("change", setCursorCoordsVisibility);
els.drawBox.addEventListener("click", () => {
  if (drawModeActive) {
    cancelBoxDrawing();
    return;
  }
  setDrawMode(true);
});
els.applyBox.addEventListener("click", applyBoxFilter);
els.clearBox.addEventListener("click", clearBox);
map.on("mousemove", (event) => updateCursorCoords(event.latlng));
map.on("mouseout", clearCursorCoords);
map.on("mousedown", startBoxDrawing);
map.on("mousemove", updateBoxDrawing);
map.on("mouseup", finishBoxDrawing);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    cancelBoxDrawing();
  }
});

updateBoxControls();
loadVessels();
setInterval(loadVessels, 10000);

window.addEventListener("resize", () => map.invalidateSize());
setTimeout(() => map.invalidateSize(), 100);
setTimeout(() => map.invalidateSize(), 500);
