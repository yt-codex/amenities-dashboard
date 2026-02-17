import { CONFIG } from "./config.js";

const CATEGORIES = {
  gp_clinics: "GP Clinics",
  dental: "Dental",
  childcare_preschool: "Childcare & Preschool",
  secondary_schools: "Secondary Schools",
  supermarkets: "Supermarkets",
  eldercare: "Eldercare",
};

const AGE_GROUPS = [
  "ALL",
  "CHILD_0_6",
  "CHILD_7_12",
  "TEEN_13_18",
  "YOUNG_ADULT_19_34",
  "ADULT_35_54",
  "YOUNG_SENIOR_55_64",
  "SENIOR_65_PLUS",
];

const GEO_CONFIG = {
  pa: {
    label: "Planning Area",
    path: "./assets/planning_area.geojson",
    nameCandidates: ["PLN_AREA_N", "PLN_AREA_NAME", "PA", "name", "NAME"],
  },
  sz: {
    label: "Subzone",
    path: "./assets/subzone.geojson",
    nameCandidates: ["SUBZONE_N", "SUBZONE_NAME", "SZ", "name", "NAME"],
  },
};

const COLORS = ["#e8f1fb", "#bdd7ef", "#82b8df", "#3f8fc9", "#0f5c99"];
const MISSING_COLOR = "#d5d8dc";

const ui = {
  geoSelect: document.getElementById("geoSelect"),
  categorySelect: document.getElementById("categorySelect"),
  snapshotSelect: document.getElementById("snapshotSelect"),
  metricSelect: document.getElementById("metricSelect"),
  ageGroupSelect: document.getElementById("ageGroupSelect"),
  configWarning: document.getElementById("configWarning"),
  statusLine: document.getElementById("statusLine"),
  contextLine: document.getElementById("contextLine"),
  errorLine: document.getElementById("errorLine"),
  legendTitle: document.getElementById("legendTitle"),
  legendBins: document.getElementById("legendBins"),
  joinHealthSummary: document.getElementById("joinHealthSummary"),
  joinHealthList: document.getElementById("joinHealthList"),
};

const map = L.map("map").setView([1.3521, 103.8198], 11);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const state = {
  activeLayer: null,
  cache: {
    // Cache keys are explicit to avoid duplicate requests when selectors are toggled quickly.
    // amenitiesIndexKey: 'amenities/index'
    // amenitiesDataKey: `amenities:${geo}:${snapshot}`
    // denomsIndexKey: 'denoms/index'
    // denomsDataKey: `denoms:${geo}:${year}`
    geojson: {},
    amenitiesIndex: null,
    denomsIndex: null,
    amenitiesData: new Map(),
    denomsData: new Map(),
  },
  controllers: {
    render: null,
  },
  selection: {
    geo: "pa",
    category: "gp_clinics",
    snapshot: "",
    metric: "COUNT",
    ageGroup: "ALL",
  },
};

function setStatus(text, type = "info") {
  ui.statusLine.textContent = text;
  ui.statusLine.className = `status ${type}`;
}

function setError(text = "") {
  ui.errorLine.hidden = !text;
  ui.errorLine.textContent = text;
}

function isConfigValid() {
  return Boolean(CONFIG.APPS_SCRIPT_URL && CONFIG.APPS_SCRIPT_URL.startsWith("http"));
}

function buildApiUrl(path, params = {}) {
  const url = new URL(CONFIG.APPS_SCRIPT_URL);
  url.searchParams.set("path", path);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  });
  return url.toString();
}

function asRows(payload) {
  const data = payload?.data ?? payload;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

function normalizeName(value) {
  // Shared join-key normalizer for both polygons and API rows.
  // Rules: null-safe -> trim -> uppercase -> normalize apostrophes -> remove punctuation ->
  // collapse non-alphanumeric to single spaces -> collapse spaces -> trim.
  if (value === null || value === undefined) return "";
  return String(value)
    .trim()
    .toUpperCase()
    .replace(/[‘’`´]/g, "'")
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getGeoNameFromFeature(feature, geo) {
  const props = feature?.properties || {};
  const key = GEO_CONFIG[geo].nameCandidates.find((candidate) => props[candidate] !== undefined);
  return { key, value: key ? String(props[key]) : "Unknown" };
}

function getGeoNameFromRow(row, geo) {
  const candidates = geo === "sz" ? ["sz", "subzone", "subzone_name", "SUBZONE_N"] : ["pa", "planning_area", "planning_area_name", "PLN_AREA_N"];
  for (const key of candidates) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== "") {
      return String(row[key]);
    }
  }
  return "";
}

async function fetchJson(path, params, signal) {
  const response = await fetch(buildApiUrl(path, params), { signal });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${path}`);
  }
  const body = await response.json();
  if (body?.error || body?.status >= 400) {
    throw new Error(body.error || `API error for ${path}`);
  }
  return body;
}

async function loadGeoJson(geo) {
  if (state.cache.geojson[geo]) return state.cache.geojson[geo];
  const response = await fetch(GEO_CONFIG[geo].path);
  if (!response.ok) throw new Error(`Failed to load ${geo} polygons (${response.status})`);
  const geojson = await response.json();

  geojson.features.forEach((feature) => {
    const { value } = getGeoNameFromFeature(feature, geo);
    feature.__displayName = value;
    feature.__joinKey = normalizeName(value);
  });

  state.cache.geojson[geo] = geojson;
  return geojson;
}

async function loadAmenitiesIndex(signal) {
  if (state.cache.amenitiesIndex) return state.cache.amenitiesIndex;
  state.cache.amenitiesIndex = await fetchJson("amenities/index", {}, signal);
  return state.cache.amenitiesIndex;
}

async function loadDenomsIndex(signal) {
  if (state.cache.denomsIndex) return state.cache.denomsIndex;
  state.cache.denomsIndex = await fetchJson("denoms/index", {}, signal);
  return state.cache.denomsIndex;
}

async function loadAmenitiesData(geo, snapshot, signal) {
  const key = `amenities:${geo}:${snapshot}`;
  if (state.cache.amenitiesData.has(key)) return state.cache.amenitiesData.get(key);
  const payload = await fetchJson("amenities", { geo, snapshot }, signal);
  const rows = asRows(payload);
  rows.forEach((row) => {
    row.__joinKeyPa = normalizeName(getGeoNameFromRow(row, "pa"));
    row.__joinKeySz = normalizeName(getGeoNameFromRow(row, "sz"));
  });
  state.cache.amenitiesData.set(key, rows);
  return rows;
}

async function loadDenomsData(geo, year, signal) {
  const key = `denoms:${geo}:${year}`;
  if (state.cache.denomsData.has(key)) return state.cache.denomsData.get(key);
  const payload = await fetchJson("denoms", { geo, year }, signal);
  const rows = asRows(payload);
  rows.forEach((row) => {
    row.__joinKeyPa = normalizeName(getGeoNameFromRow(row, "pa"));
    row.__joinKeySz = normalizeName(getGeoNameFromRow(row, "sz"));
  });
  state.cache.denomsData.set(key, rows);
  return rows;
}

function getSnapshotsFromIndex(indexPayload) {
  const data = indexPayload?.data ?? indexPayload;
  const snapshots = data?.snapshots || data?.vintages || data?.available_snapshots || [];
  return [...new Set(snapshots)].sort();
}

function getYearsFromDenomIndex(indexPayload) {
  const data = indexPayload?.data ?? indexPayload;
  const years = data?.vintages || data?.years || [];
  return [...new Set(years.map((y) => Number(y)).filter(Number.isFinite))].sort((a, b) => a - b);
}

function chooseDenomYear(snapshot, availableYears) {
  // Denominator mapping rule:
  // - Try snapshot year directly (YYYYQn -> YYYY)
  // - Else latest year <= snapshot year
  // - Else fallback to latest available year
  const snapshotYear = Number(String(snapshot).slice(0, 4));
  if (!Number.isFinite(snapshotYear) || availableYears.length === 0) {
    return { year: null, warning: "No denominator vintages available." };
  }
  if (availableYears.includes(snapshotYear)) return { year: snapshotYear, warning: "" };
  const lte = availableYears.filter((y) => y <= snapshotYear);
  if (lte.length > 0) return { year: Math.max(...lte), warning: `Using ${Math.max(...lte)} (closest <= ${snapshotYear}).` };
  const latest = Math.max(...availableYears);
  return { year: latest, warning: `No vintage <= ${snapshotYear}; using latest ${latest}.` };
}

function buildAmenityLookup(rows, geo, category) {
  const lookup = new Map();
  rows.forEach((row) => {
    const joinKey = geo === "sz" ? row.__joinKeySz : row.__joinKeyPa;
    if (!joinKey) return;

    const rowCategory = String(row.category || row.amenity || row.key || "").toLowerCase();
    let count = null;

    if (rowCategory) {
      if (rowCategory !== category) return;
      count = Number(row.count ?? row.value ?? row.total);
    } else if (row[category] !== undefined) {
      count = Number(row[category]);
    }

    if (!Number.isFinite(count)) return;
    lookup.set(joinKey, (lookup.get(joinKey) || 0) + count);
  });
  return lookup;
}

function buildDenomLookup(rows, geo, ageGroup) {
  // Parser supports both wide and long-form denominator schemas.
  // Wide: one row per area with AGE_GROUP columns.
  // Long: one row per area+age_group with denominator value columns.
  const lookup = new Map();

  rows.forEach((row) => {
    const joinKey = geo === "sz" ? row.__joinKeySz : row.__joinKeyPa;
    if (!joinKey) return;

    const rowAge = String(row.age_group || row.ageGroup || row.group || "").toUpperCase();
    let denom = null;

    if (rowAge) {
      if (rowAge !== ageGroup) return;
      denom = Number(row.population ?? row.residents ?? row.value ?? row.count ?? row.denom);
    } else {
      denom = Number(row[ageGroup]);
    }

    if (!Number.isFinite(denom)) return;
    lookup.set(joinKey, (lookup.get(joinKey) || 0) + denom);
  });

  return lookup;
}

function computeQuantileBreaks(values, bins = 5) {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const breaks = [];
  for (let i = 1; i <= bins; i += 1) {
    const idx = Math.min(sorted.length - 1, Math.floor((i * sorted.length) / bins) - 1);
    breaks.push(sorted[Math.max(0, idx)]);
  }
  return breaks;
}

function getColor(value, breaks) {
  if (value === null || value === undefined || Number.isNaN(value)) return MISSING_COLOR;
  for (let i = 0; i < breaks.length; i += 1) {
    if (value <= breaks[i]) return COLORS[i] || COLORS[COLORS.length - 1];
  }
  return COLORS[COLORS.length - 1];
}

function formatMetric(v, metric) {
  if (v === null || v === undefined || Number.isNaN(v)) return "NA";
  return metric === "PER_1000" ? v.toFixed(2) : String(Math.round(v));
}

function updateLegend(metric, breaks) {
  ui.legendTitle.textContent = metric === "PER_1000" ? "Rate per 1,000 residents" : "Amenity count";
  ui.legendBins.innerHTML = "";

  breaks.forEach((max, i) => {
    const min = i === 0 ? 0 : breaks[i - 1];
    const row = document.createElement("div");
    row.className = "legend-row";
    row.innerHTML = `<span class="legend-swatch" style="background:${COLORS[i]}"></span><span>${min.toFixed(2)} - ${max.toFixed(2)}</span>`;
    ui.legendBins.appendChild(row);
  });

  const missing = document.createElement("div");
  missing.className = "legend-row";
  missing.innerHTML = `<span class="legend-swatch" style="background:${MISSING_COLOR}"></span><span>Missing / unmatched</span>`;
  ui.legendBins.appendChild(missing);
}

function updateJoinHealth(features, matchedKeys, unmatchedItems) {
  const total = features.length;
  const matched = matchedKeys.size;
  const unmatched = total - matched;
  ui.joinHealthSummary.textContent = `Total polygons: ${total}, Matched: ${matched}, Unmatched: ${unmatched}`;
  ui.joinHealthList.textContent = JSON.stringify(unmatchedItems.slice(0, 10), null, 2);
}

function updateLayer(geoData, valuesByJoinKey, options) {
  const numericValues = geoData.features
    .map((feature) => valuesByJoinKey.get(feature.__joinKey)?.value)
    .filter((v) => Number.isFinite(v));
  const breaks = computeQuantileBreaks(numericValues, 5);
  updateLegend(options.metric, breaks);

  if (state.activeLayer) {
    map.removeLayer(state.activeLayer);
  }

  const matchedKeys = new Set();
  const unmatchedItems = [];

  state.activeLayer = L.geoJSON(geoData, {
    style: (feature) => {
      const payload = valuesByJoinKey.get(feature.__joinKey);
      if (payload) matchedKeys.add(feature.__joinKey);
      else unmatchedItems.push({ raw: feature.__displayName, normalized: feature.__joinKey });
      return {
        color: "#2e4053",
        weight: 0.8,
        fillOpacity: 0.75,
        fillColor: getColor(payload?.value ?? null, breaks),
      };
    },
    onEachFeature: (feature, layer) => {
      const payload = valuesByJoinKey.get(feature.__joinKey);
      const lines = [
        `<strong>${feature.__displayName}</strong>`,
        `${CATEGORIES[options.category]}`,
        `Count: ${formatMetric(payload?.count ?? null, "COUNT")}`,
      ];
      if (options.metric === "PER_1000") {
        lines.push(`Residents (${options.ageGroup}): ${formatMetric(payload?.denom ?? null, "COUNT")}`);
        lines.push(`Rate per 1,000: ${formatMetric(payload?.value ?? null, "PER_1000")}`);
      }
      lines.push(`Snapshot: ${options.snapshot}`);
      lines.push(`Denom vintage: ${options.denomYear ?? "N/A"}`);

      layer.bindTooltip(lines.join("<br/>"), { sticky: true });
      layer.on("mouseover", () => layer.setStyle({ weight: 1.8 }));
      layer.on("mouseout", () => state.activeLayer.resetStyle(layer));
    },
  }).addTo(map);

  const bounds = state.activeLayer.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [20, 20] });
  updateJoinHealth(geoData.features, matchedKeys, unmatchedItems);
}

async function render() {
  if (!isConfigValid()) {
    ui.configWarning.hidden = false;
    ui.configWarning.textContent = "CONFIG.APPS_SCRIPT_URL is not configured. Update web/config.js.";
    setStatus("Cannot render without APPS_SCRIPT_URL.", "error");
    return;
  }

  ui.configWarning.hidden = true;
  setError("");

  if (state.controllers.render) state.controllers.render.abort();
  const controller = new AbortController();
  state.controllers.render = controller;

  const { geo, category, snapshot, metric, ageGroup } = state.selection;

  try {
    setStatus("Loading data...", "info");

    const [geoData, denomsIndex] = await Promise.all([
      loadGeoJson(geo),
      loadDenomsIndex(controller.signal),
    ]);

    const amenityRows = await loadAmenitiesData(geo, snapshot, controller.signal);
    const countsLookup = buildAmenityLookup(amenityRows, geo, category);

    const denomYears = getYearsFromDenomIndex(denomsIndex);
    const chosen = chooseDenomYear(snapshot, denomYears);

    const valuesByJoinKey = new Map();

    if (metric === "COUNT") {
      countsLookup.forEach((count, key) => {
        valuesByJoinKey.set(key, { count, denom: null, value: count });
      });
      ui.contextLine.textContent = `Loaded snapshot ${snapshot}. Denominator vintage: N/A (COUNT mode).`;
    } else {
      const denomRows = chosen.year ? await loadDenomsData(geo, chosen.year, controller.signal) : [];
      const denomLookup = buildDenomLookup(denomRows, geo, ageGroup);

      countsLookup.forEach((count, key) => {
        const denom = denomLookup.get(key);
        const value = Number.isFinite(denom) && denom > 0 ? (count / denom) * 1000 : null;
        valuesByJoinKey.set(key, { count, denom: Number.isFinite(denom) ? denom : null, value });
      });

      ui.contextLine.textContent = `Loaded snapshot ${snapshot}. Denominator vintage: ${chosen.year ?? "N/A"}. ${chosen.warning}`.trim();
    }

    updateLayer(geoData, valuesByJoinKey, {
      metric,
      category,
      snapshot,
      ageGroup,
      denomYear: metric === "PER_1000" ? chosen.year : null,
    });

    setStatus("Map updated.", "info");
  } catch (error) {
    if (error.name === "AbortError") return;
    setStatus("Failed to update map.", "error");
    setError(error.message);
  }
}

async function bootstrap() {
  Object.entries(CATEGORIES).forEach(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    ui.categorySelect.appendChild(option);
  });

  AGE_GROUPS.forEach((age) => {
    const option = document.createElement("option");
    option.value = age;
    option.textContent = age;
    ui.ageGroupSelect.appendChild(option);
  });

  ui.ageGroupSelect.disabled = true;

  if (!isConfigValid()) {
    ui.configWarning.hidden = false;
    ui.configWarning.textContent = "CONFIG.APPS_SCRIPT_URL is not configured. Update web/config.js.";
    return;
  }

  try {
    const amenitiesIndex = await loadAmenitiesIndex();
    const snapshots = getSnapshotsFromIndex(amenitiesIndex);
    ui.snapshotSelect.innerHTML = "";
    snapshots.forEach((snapshot) => {
      const option = document.createElement("option");
      option.value = snapshot;
      option.textContent = snapshot;
      ui.snapshotSelect.appendChild(option);
    });
    state.selection.snapshot = snapshots[snapshots.length - 1] || "";
    ui.snapshotSelect.value = state.selection.snapshot;
  } catch (error) {
    setError(`Failed to load amenities index: ${error.message}`);
  }

  await render();
}

function syncSelectionAndRender() {
  state.selection.geo = ui.geoSelect.value;
  state.selection.category = ui.categorySelect.value;
  state.selection.snapshot = ui.snapshotSelect.value;
  state.selection.metric = ui.metricSelect.value;
  state.selection.ageGroup = ui.ageGroupSelect.value;
  ui.ageGroupSelect.disabled = state.selection.metric !== "PER_1000";
  render();
}

[ui.geoSelect, ui.categorySelect, ui.snapshotSelect, ui.metricSelect, ui.ageGroupSelect].forEach((element) => {
  element.addEventListener("change", syncSelectionAndRender);
});

bootstrap();
