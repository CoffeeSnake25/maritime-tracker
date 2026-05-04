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
const evidenceMarkers = new Map();
const satelliteLayer = L.layerGroup().addTo(map);
const anomalyLayer = L.layerGroup().addTo(map);
let allVessels = [];
let detectionResults = [];
let viewMode = "all";
let selectedEvidence = null;
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
  shell: document.querySelector(".shell"),
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
  viewModeButtons: document.querySelectorAll("[data-view-mode]"),
  evidencePanel: document.querySelector("#evidencePanelContent"),
  leftSidebarToggle: document.querySelector("#leftSidebarToggle"),
  rightSidebarToggle: document.querySelector("#rightSidebarToggle"),
};

function syncSidebarToggle(side, collapsed) {
  const isLeft = side === "left";
  const button = isLeft ? els.leftSidebarToggle : els.rightSidebarToggle;
  if (!button) {
    return;
  }
  button.textContent = collapsed ? (isLeft ? "›" : "‹") : isLeft ? "‹" : "›";
  button.setAttribute("aria-expanded", String(!collapsed));
  button.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${isLeft ? "controls" : "evidence"} panel`);
}

function setSidebarCollapsed(side, collapsed) {
  const className = `${side}-sidebar-collapsed`;
  els.shell.classList.toggle(className, collapsed);
  syncSidebarToggle(side, collapsed);
  setTimeout(() => map.invalidateSize(), 210);
}

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

function detectionId(result) {
  return result.detection && result.detection.detection_id;
}

function evidenceId(type, record) {
  return type === "ais" ? record.mmsi || vesselKey(record) : detectionId(record);
}

function evidenceMarkerKey(type, id) {
  return `${type}:${id}`;
}

function selectEvidence(type, record) {
  selectedEvidence = {
    type,
    id: evidenceId(type, record),
    record,
  };
  if (type === "ais") {
    selectedMarkerKey = vesselKey(record);
    updateMarkerFocus();
  }
  renderEvidencePanel();
}

function evidencePoint(evidence) {
  if (!evidence) {
    return null;
  }
  return evidence.type === "ais" ? evidence.record : evidence.record.detection;
}

function evidenceRow(labelText, rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    return "";
  }
  return `<div class="evidence-row"><dt>${labelText}</dt><dd>${rawValue}</dd></div>`;
}

function evidenceSection(title, rows) {
  const content = rows.filter(Boolean).join("");
  if (!content) {
    return "";
  }
  return `<section class="evidence-section"><h4>${title}</h4><dl>${content}</dl></section>`;
}

function evidenceBadge(text, tone = "neutral") {
  return `<span class="evidence-badge evidence-badge-${tone}">${text}</span>`;
}

function ruleBlock(text) {
  return `<div class="evidence-rule"><strong>Rule</strong><span>${text}</span></div>`;
}

function emptyEvidencePanel() {
  return `<p class="evidence-empty">Select an AIS vessel, satellite detection, or anomaly candidate to inspect evidence.</p>`;
}

function formatCoords(point) {
  return hasPointCoords(point) ? `${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}` : null;
}

function formatConfidence(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : null;
}

function vesselEvidenceLabel(vessel) {
  return vessel ? label(vessel) : null;
}

function detectionRuleText(result) {
  return result.is_anomaly_candidate
    ? "No AIS vessel matched within 2.0 km and +/-30 minutes."
    : "AIS match found within 2.0 km and +/-30 minutes.";
}

function popupHtml(vessel) {
  return `
    <div class="popup-card">
      <p class="popup-kicker">AIS Vessel</p>
      <h2 class="popup-title">${label(vessel)}</h2>
      <p class="popup-status">${value(vessel.nav_status) !== "Unknown" ? vessel.nav_status : "Navigation status unknown"}</p>
      <p class="popup-note">Details shown in Evidence Panel.</p>
    </div>
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

function modeShows(category) {
  return viewMode === "all" || viewMode === category;
}

function visibleVessels() {
  return modeShows("ais") ? filteredVessels() : [];
}

function satelliteResults() {
  return detectionResults.filter((result) => !result.is_anomaly_candidate);
}

function anomalyResults() {
  return detectionResults.filter((result) => result.is_anomaly_candidate);
}

function filterResultsByBox(results) {
  return boxFilterActive ? results.filter((result) => isPointInBox(result.detection, currentBox)) : results;
}

function visibleSatelliteResults() {
  return modeShows("satellite") ? filterResultsByBox(satelliteResults()) : [];
}

function visibleAnomalyResults() {
  return modeShows("anomalies") ? filterResultsByBox(anomalyResults()) : [];
}

function countSummary(visibleCounts) {
  return [
    `AIS: ${visibleCounts.ais} / ${allVessels.length} shown`,
    `Satellite: ${visibleCounts.satellite} / ${satelliteResults().length} shown`,
    `Anomalies: ${visibleCounts.anomalies} / ${anomalyResults().length} shown`,
  ].join(" · ");
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
  return hasPointCoords(vessel);
}

function hasPointCoords(point) {
  return Number.isFinite(point.lat) && Number.isFinite(point.lon);
}

function isPointInBox(point, box) {
  if (!box || !hasPointCoords(point)) {
    return false;
  }
  return point.lat >= box.min_lat && point.lat <= box.max_lat && point.lon >= box.min_lon && point.lon <= box.max_lon;
}

function isVesselInBox(vessel, box) {
  return isPointInBox(vessel, box);
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
    radius: selected ? 8 : 5,
    color: selected ? "#063f42" : "#0c6b70",
    fillColor: vessel.nav_status === "At anchor" ? "#d89526" : "#1d9a8a",
    fillOpacity: selected ? 0.92 : dimmed ? 0.34 : 0.62,
    opacity: selected ? 1 : dimmed ? 0.5 : 0.82,
    weight: selected ? 3 : 1.5,
  };
}

function detectionMarkerStyle(isAnomaly) {
  return {
    radius: isAnomaly ? 8 : 6,
    color: isAnomaly ? "#8f1d2c" : "#b56b00",
    fillColor: isAnomaly ? "#ffefe9" : "#fff8e6",
    fillOpacity: isAnomaly ? 0.38 : 0.12,
    opacity: 1,
    weight: isAnomaly ? 3 : 2,
    dashArray: isAnomaly ? null : "2 4",
  };
}

function detectionPopupHtml(result) {
  const detection = result.detection;
  if (result.is_anomaly_candidate) {
    return `
      <div class="popup-card">
        <p class="popup-kicker">Potential Dark Vessel Candidate</p>
        <h2 class="popup-title">${value(detection.detection_id)}</h2>
        <p class="popup-status">No AIS match within 2.0 km / ±30 min.</p>
        <p class="popup-note">Details shown in Evidence Panel.</p>
      </div>
    `;
  }

  return `
    <div class="popup-card">
      <p class="popup-kicker">Satellite Detection</p>
      <h2 class="popup-title">${value(detection.detection_id)}</h2>
      <p class="popup-status">${result.matched_vessel ? "Matched AIS vessel within threshold." : "Review match details."}</p>
      <p class="popup-note">Details shown in Evidence Panel.</p>
    </div>
  `;
}

function selectedEvidenceVisible() {
  if (!selectedEvidence) {
    return false;
  }
  if (selectedEvidence.type === "ais") {
    return visibleVessels().some((vessel) => evidenceId("ais", vessel) === selectedEvidence.id);
  }
  if (selectedEvidence.type === "satellite") {
    return visibleSatelliteResults().some((result) => detectionId(result) === selectedEvidence.id);
  }
  return visibleAnomalyResults().some((result) => detectionId(result) === selectedEvidence.id);
}

function hiddenEvidenceNotice() {
  if (!selectedEvidence || selectedEvidenceVisible()) {
    return "";
  }
  return `
    <div class="evidence-hidden-note">
      <span>This selected item is hidden by the current view or area filter.</span>
      <button id="showSelectedEvidence" type="button">Show on map</button>
    </div>
  `;
}

function renderAisEvidence(vessel) {
  return `
    <div class="evidence-heading">
      ${evidenceBadge("AIS Vessel")}
      <h3>${label(vessel)}</h3>
    </div>
    ${hiddenEvidenceNotice()}
    ${evidenceSection("Vessel", [
      evidenceRow("MMSI", vessel.mmsi),
      evidenceRow("Last seen", vessel.last_seen),
      evidenceRow("Coordinates", formatCoords(vessel)),
      evidenceRow("Navigation", vessel.nav_status),
      evidenceRow("SOG", Number.isFinite(vessel.sog) ? `${vessel.sog} kn` : null),
      evidenceRow("COG", Number.isFinite(vessel.cog) ? `${vessel.cog} deg` : null),
      evidenceRow("Heading", Number.isFinite(vessel.heading) ? `${vessel.heading} deg` : null),
      evidenceRow("Cargo", vessel.cargo_type),
      evidenceRow("Destination", vessel.destination),
      evidenceRow("Source", vessel.source),
    ])}
  `;
}

function resultMetricRows(result) {
  return [
    evidenceRow("Matched AIS", vesselEvidenceLabel(result.matched_vessel)),
    evidenceRow("Nearest AIS", vesselEvidenceLabel(result.nearest_vessel)),
    evidenceRow("Distance", result.distance_km !== null ? `${formatNumber(result.distance_km, 2)} km` : null),
    evidenceRow("Time delta", result.time_delta_minutes !== null ? `${formatNumber(result.time_delta_minutes, 1)} min` : null),
    evidenceRow("Reason", result.reason),
  ];
}

function renderSatelliteEvidence(result) {
  const detection = result.detection;
  return `
    <div class="evidence-heading">
      ${evidenceBadge("Satellite Detection")}
      <h3>${value(detection.detection_id)}</h3>
    </div>
    ${hiddenEvidenceNotice()}
    ${ruleBlock(detectionRuleText(result))}
    ${evidenceSection("Detection", [
      evidenceRow("Detection ID", detection.detection_id),
      evidenceRow("Timestamp", detection.detected_at),
      evidenceRow("Coordinates", formatCoords(detection)),
      evidenceRow("Confidence", formatConfidence(detection.confidence)),
      evidenceRow("Match status", result.matched_vessel ? "Matched AIS vessel" : "No AIS match"),
    ])}
    ${evidenceSection("Match Evidence", resultMetricRows(result))}
  `;
}

function renderAnomalyEvidence(result) {
  const detection = result.detection;
  return `
    <div class="evidence-heading">
      ${evidenceBadge("Rule-based anomaly candidate", "danger")}
      <h3>Potential Dark Vessel Candidate</h3>
    </div>
    ${hiddenEvidenceNotice()}
    ${ruleBlock("No AIS vessel matched within 2.0 km and +/-30 minutes.")}
    <p class="evidence-caution">This is an indicator for review, not a confirmed dark vessel.</p>
    ${evidenceSection("Detection", [
      evidenceRow("Detection ID", detection.detection_id),
      evidenceRow("Timestamp", detection.detected_at),
      evidenceRow("Coordinates", formatCoords(detection)),
      evidenceRow("Confidence", formatConfidence(detection.confidence)),
    ])}
    ${evidenceSection("Anomaly Evidence", resultMetricRows(result))}
  `;
}

function renderEvidencePanel() {
  if (!els.evidencePanel) {
    return;
  }
  if (!selectedEvidence) {
    els.evidencePanel.innerHTML = emptyEvidencePanel();
    return;
  }
  if (selectedEvidence.type === "ais") {
    els.evidencePanel.innerHTML = renderAisEvidence(selectedEvidence.record);
    return;
  }
  if (selectedEvidence.type === "satellite") {
    els.evidencePanel.innerHTML = renderSatelliteEvidence(selectedEvidence.record);
    return;
  }
  els.evidencePanel.innerHTML = renderAnomalyEvidence(selectedEvidence.record);
}

function resolveSelectedEvidence() {
  if (!selectedEvidence) {
    return;
  }
  if (selectedEvidence.type === "ais") {
    const vessel = allVessels.find((item) => evidenceId("ais", item) === selectedEvidence.id);
    selectedEvidence = vessel ? { ...selectedEvidence, record: vessel } : null;
    return;
  }
  const result = detectionResults.find((item) => detectionId(item) === selectedEvidence.id);
  selectedEvidence = result ? { ...selectedEvidence, record: result } : null;
}

function showSelectedEvidenceOnMap() {
  if (!selectedEvidence) {
    return;
  }
  const point = evidencePoint(selectedEvidence);
  viewMode = "all";
  if (boxFilterActive && point && !isPointInBox(point, currentBox)) {
    clearBox();
  } else {
    render();
  }
  if (!hasPointCoords(point)) {
    return;
  }
  map.setView([point.lat, point.lon], Math.max(map.getZoom(), 8));
  const marker =
    selectedEvidence.type === "ais"
      ? markers.get(selectedEvidence.id)
      : evidenceMarkers.get(evidenceMarkerKey(selectedEvidence.type, selectedEvidence.id));
  if (marker) {
    marker.openPopup();
  }
}

function renderDetectionLayers() {
  satelliteLayer.clearLayers();
  anomalyLayer.clearLayers();
  evidenceMarkers.clear();

  for (const result of visibleSatelliteResults()) {
    const detection = result.detection;
    if (!Number.isFinite(detection.lat) || !Number.isFinite(detection.lon)) {
      continue;
    }
    const marker = L.circleMarker([detection.lat, detection.lon], detectionMarkerStyle(false))
      .bindPopup(detectionPopupHtml(result), {
        offset: L.point(0, -10),
        autoPanPadding: L.point(18, 18),
        maxWidth: 320,
      })
      .addTo(satelliteLayer);
    marker.on("click", () => selectEvidence("satellite", result));
    evidenceMarkers.set(evidenceMarkerKey("satellite", detectionId(result)), marker);
  }

  for (const result of visibleAnomalyResults()) {
    const detection = result.detection;
    if (!Number.isFinite(detection.lat) || !Number.isFinite(detection.lon)) {
      continue;
    }
    const marker = L.circleMarker([detection.lat, detection.lon], detectionMarkerStyle(true))
      .bindPopup(detectionPopupHtml(result), {
        offset: L.point(0, -10),
        autoPanPadding: L.point(18, 18),
        maxWidth: 320,
      })
      .addTo(anomalyLayer)
      .bringToFront();
    marker.on("click", () => selectEvidence("anomaly", result));
    evidenceMarkers.set(evidenceMarkerKey("anomaly", detectionId(result)), marker);
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
  const vessels = visibleVessels();
  const visibleSatellites = visibleSatelliteResults();
  const visibleAnomalies = visibleAnomalyResults();

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
      selectEvidence("ais", vessel);
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
      selectEvidence("ais", vessel);
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
  updateViewModeControls();
  renderEvidencePanel();

  els.summary.textContent = countSummary({
    ais: vessels.length,
    satellite: visibleSatellites.length,
    anomalies: visibleAnomalies.length,
  });
  map.invalidateSize();
}

function updateViewModeControls() {
  for (const button of els.viewModeButtons) {
    const active = button.dataset.viewMode === viewMode;
    button.classList.toggle("view-mode-button-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
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
    resolveSelectedEvidence();
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
els.evidencePanel.addEventListener("click", (event) => {
  if (event.target.id === "showSelectedEvidence") {
    showSelectedEvidenceOnMap();
  }
});
els.leftSidebarToggle.addEventListener("click", () => {
  setSidebarCollapsed("left", !els.shell.classList.contains("left-sidebar-collapsed"));
});
els.rightSidebarToggle.addEventListener("click", () => {
  setSidebarCollapsed("right", !els.shell.classList.contains("right-sidebar-collapsed"));
});
for (const button of els.viewModeButtons) {
  button.addEventListener("click", () => {
    viewMode = button.dataset.viewMode;
    render();
  });
}
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
renderEvidencePanel();
loadVessels();
setInterval(loadVessels, 10000);

window.addEventListener("resize", () => map.invalidateSize());
setTimeout(() => map.invalidateSize(), 100);
setTimeout(() => map.invalidateSize(), 500);
