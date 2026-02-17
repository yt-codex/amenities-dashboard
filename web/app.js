import { CONFIG } from "./config.js";

const map = L.map("map").setView([1.3521, 103.8198], 11);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const ui = {
  geoLayer: document.getElementById("geoLayer"),
  geoMeta: document.getElementById("geoMeta"),
  featureProps: document.getElementById("featureProps"),
  configWarning: document.getElementById("configWarning"),
  denomStatus: document.getElementById("denomStatus"),
  loadDenomIndexBtn: document.getElementById("loadDenomIndexBtn"),
  denomIndexOutput: document.getElementById("denomIndexOutput"),
  denomGeo: document.getElementById("denomGeo"),
  denomYear: document.getElementById("denomYear"),
  fetchDenomSampleBtn: document.getElementById("fetchDenomSampleBtn"),
  denomSampleOutput: document.getElementById("denomSampleOutput"),
};

const state = {
  activeLayer: null,
  geoJsonCache: {},
  denomIndex: null,
};

const GEO_CONFIG = {
  pa: {
    path: "./assets/planning_area.geojson",
    label: "Planning Area",
    nameCandidates: ["PLN_AREA_N", "planning_area", "name", "Name"],
  },
  sz: {
    path: "./assets/subzone.geojson",
    label: "Subzone",
    nameCandidates: ["SUBZONE_N", "subzone", "name", "Name"],
  },
};

function setStatus(element, text, type = "info") {
  element.textContent = text;
  element.className = `status ${type}`;
}

function isConfigValid() {
  return Boolean(CONFIG.APPS_SCRIPT_URL && CONFIG.APPS_SCRIPT_URL.startsWith("http"));
}

function buildApiUrl(path, params = {}) {
  const url = new URL(path, CONFIG.APPS_SCRIPT_URL);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  });
  return url.toString();
}

function findNamePropertyKey(properties, candidates) {
  return candidates.find((key) => properties[key] !== undefined) || null;
}

async function loadGeoJson(geoKey) {
  if (state.geoJsonCache[geoKey]) {
    return state.geoJsonCache[geoKey];
  }

  const response = await fetch(GEO_CONFIG[geoKey].path);
  if (!response.ok) {
    throw new Error(`Failed to load ${GEO_CONFIG[geoKey].label} GeoJSON (${response.status})`);
  }

  const data = await response.json();
  state.geoJsonCache[geoKey] = data;
  return data;
}

async function renderGeoLayer(geoKey) {
  try {
    const geoData = await loadGeoJson(geoKey);

    if (state.activeLayer) {
      map.removeLayer(state.activeLayer);
    }

    let selectedNameKey = null;
    state.activeLayer = L.geoJSON(geoData, {
      style: {
        color: "#1d6fa5",
        weight: 1,
        fillColor: "#74add1",
        fillOpacity: 0.2,
      },
      onEachFeature: (feature, layer) => {
        const properties = feature.properties || {};
        const nameKey = findNamePropertyKey(properties, GEO_CONFIG[geoKey].nameCandidates);
        if (!selectedNameKey && nameKey) {
          selectedNameKey = nameKey;
        }
        const nameValue = nameKey ? properties[nameKey] : "Unknown";

        layer.on("mouseover", () => {
          layer.bindTooltip(String(nameValue), { sticky: true }).openTooltip();
          layer.setStyle({ fillOpacity: 0.35 });
        });
        layer.on("mouseout", () => {
          layer.setStyle({ fillOpacity: 0.2 });
        });
        layer.on("click", () => {
          ui.featureProps.textContent = JSON.stringify(properties, null, 2);
        });
      },
    }).addTo(map);

    const bounds = state.activeLayer.getBounds();
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [20, 20] });
    }

    setStatus(
      ui.geoMeta,
      `${GEO_CONFIG[geoKey].label} loaded. Tooltip name property key: ${selectedNameKey || "(not found)"}`,
      selectedNameKey ? "info" : "warn",
    );
  } catch (error) {
    setStatus(ui.geoMeta, error.message, "error");
  }
}

function populateYears(years = []) {
  ui.denomYear.innerHTML = "";
  years.forEach((year) => {
    const option = document.createElement("option");
    option.value = year;
    option.textContent = year;
    ui.denomYear.appendChild(option);
  });
}

async function loadDenominatorIndex() {
  if (!isConfigValid()) {
    ui.configWarning.hidden = false;
    ui.configWarning.textContent = "CONFIG.APPS_SCRIPT_URL is missing or invalid. Update web/config.js.";
    setStatus(ui.denomStatus, "Cannot load index without APPS_SCRIPT_URL.", "error");
    return;
  }

  ui.configWarning.hidden = true;

  if (state.denomIndex) {
    setStatus(ui.denomStatus, "Using cached denominator index.", "info");
    return state.denomIndex;
  }

  try {
    setStatus(ui.denomStatus, "Loading denominator index...", "info");
    const url = buildApiUrl("?route=index");
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Index fetch failed (${response.status})`);
    }

    const index = await response.json();
    state.denomIndex = index;

    const summary = {
      vintages: index.vintages || [],
      age_groups: index.age_groups || [],
      geos: index.geos || [],
      updated_at: index.updated_at || null,
    };

    ui.denomIndexOutput.textContent = JSON.stringify(summary, null, 2);
    populateYears(summary.vintages);
    setStatus(ui.denomStatus, "Denominator index loaded.", "info");
    return index;
  } catch (error) {
    setStatus(ui.denomStatus, `Index error: ${error.message}`, "error");
    throw error;
  }
}

async function fetchDenominatorSample() {
  if (!isConfigValid()) {
    ui.configWarning.hidden = false;
    ui.configWarning.textContent = "CONFIG.APPS_SCRIPT_URL is missing or invalid. Update web/config.js.";
    setStatus(ui.denomStatus, "Cannot fetch sample without APPS_SCRIPT_URL.", "error");
    return;
  }

  const geo = ui.denomGeo.value;
  const year = ui.denomYear.value;

  if (!year) {
    setStatus(ui.denomStatus, "Choose a denom_year first (load index).", "warn");
    return;
  }

  try {
    setStatus(ui.denomStatus, "Loading denominator sample...", "info");
    const url = buildApiUrl("?route=denoms", { geo, year });
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Denominator sample fetch failed (${response.status})`);
    }

    const payload = await response.json();
    const rows = Array.isArray(payload.rows) ? payload.rows : payload;
    const output = {
      rows_count: rows.length,
      first_5_rows: rows.slice(0, 5),
    };
    ui.denomSampleOutput.textContent = JSON.stringify(output, null, 2);
    setStatus(ui.denomStatus, "Denominator sample loaded.", "info");
  } catch (error) {
    setStatus(ui.denomStatus, `Sample error: ${error.message}`, "error");
  }
}

ui.geoLayer.addEventListener("change", (event) => {
  renderGeoLayer(event.target.value);
});
ui.loadDenomIndexBtn.addEventListener("click", () => {
  loadDenominatorIndex().catch(() => {});
});
ui.fetchDenomSampleBtn.addEventListener("click", fetchDenominatorSample);

if (!isConfigValid()) {
  ui.configWarning.hidden = false;
  ui.configWarning.textContent = "CONFIG.APPS_SCRIPT_URL is not configured. Denominator fetches are disabled.";
}

renderGeoLayer("pa");
