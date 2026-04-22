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
let allVessels = [];
let loading = false;

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
};

function value(v) {
  return v === null || v === undefined || v === "" ? "Unknown" : v;
}

function label(vessel) {
  return value(vessel.ship_name) !== "Unknown" ? vessel.ship_name : `MMSI ${value(vessel.mmsi)}`;
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
  return allVessels.filter((vessel) => {
    const matchesSearch =
      !query ||
      String(vessel.ship_name || "").toLowerCase().includes(query) ||
      String(vessel.mmsi || "").includes(query);
    const matchesCargo = !els.cargo.value || vessel.cargo_type === els.cargo.value;
    const matchesStatus = !els.status.value || vessel.nav_status === els.status.value;
    return matchesSearch && matchesCargo && matchesStatus;
  });
}

function render() {
  const vessels = filteredVessels();

  for (const marker of markers.values()) {
    marker.remove();
  }
  markers.clear();
  els.list.innerHTML = "";

  for (const vessel of vessels) {
    const marker = L.circleMarker([vessel.lat, vessel.lon], {
      radius: 7,
      color: "#0c6b70",
      fillColor: vessel.nav_status === "At anchor" ? "#d89526" : "#1d9a8a",
      fillOpacity: 0.85,
      weight: 2,
    }).addTo(map);
    marker.bindPopup(popupHtml(vessel));
    markers.set(vessel.mmsi || `${vessel.lat},${vessel.lon}`, marker);

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

  els.summary.textContent = `${vessels.length} of ${allVessels.length} vessels in region`;
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
    const response = await fetch("/api/vessels");
    const data = await response.json();
    allVessels = data.vessels;
    setOptions(els.cargo, allVessels, "cargo_type", "All cargo types");
    setOptions(els.status, allVessels, "nav_status", "All navigation statuses");
    els.provider.textContent = `Provider: ${data.provider}`;
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

loadVessels();
setInterval(loadVessels, 10000);

window.addEventListener("resize", () => map.invalidateSize());
setTimeout(() => map.invalidateSize(), 100);
setTimeout(() => map.invalidateSize(), 500);
