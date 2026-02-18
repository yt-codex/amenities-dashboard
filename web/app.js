import { CONFIG } from "./config.js";

const FALLBACK_CATEGORY_ORDER = [
  "gp_clinics",
  "dental",
  "childcare_preschool",
  "primary_schools",
  "secondary_schools",
  "supermarkets",
  "eldercare",
];

const CATEGORY_LABELS = {
  gp_clinics: "GP clinics",
  dental: "Dental",
  childcare_preschool: "Childcare / preschool",
  primary_schools: "Primary schools",
  secondary_schools: "Secondary schools",
  supermarkets: "Supermarkets",
  eldercare: "Eldercare facilities",
};

const CATEGORY_INFO = {
  gp_clinics: {
    title: "GP clinics",
    source: "Source: OpenStreetMap",
    includes: "Includes: doctor/clinic tags (GP-type outpatient clinics).",
  },
  dental: {
    title: "Dental",
    source: "Source: OpenStreetMap",
    includes: "Includes: dentist tags (dental clinics / practices).",
  },
  childcare_preschool: {
    title: "Childcare / preschool",
    source: "Source: OpenStreetMap",
    includes: "Includes: childcare + kindergarten-related tags.",
  },
  primary_schools: {
    title: "Primary schools",
    source: "Source: MOE directory + OneMap geocode",
    includes: "Includes: MOE-listed primary schools (geocoded).",
  },
  secondary_schools: {
    title: "Secondary schools",
    source: "Source: MOE directory + OneMap geocode",
    includes: "Includes: MOE-listed secondary schools (geocoded).",
  },
  supermarkets: {
    title: "Supermarkets",
    source: "Source: OpenStreetMap",
    includes: "Includes: shop=supermarket.",
  },
  eldercare: {
    title: "Eldercare facilities",
    source: "Source: OpenStreetMap",
    includes: "Includes: nursing homes / assisted living / day care type social facilities.",
  },
};


const CATEGORY_ALIASES = {
  gp_clinics: "gp_clinics",
  "gp clinics": "gp_clinics",
  gpclinic: "gp_clinics",
  dental: "dental",
  childcare_preschool: "childcare_preschool",
  "childcare / preschool": "childcare_preschool",
  "childcare & preschool": "childcare_preschool",
  childcare: "childcare_preschool",
  preschool: "childcare_preschool",
  primary_schools: "primary_schools",
  "primary schools": "primary_schools",
  primary_school: "primary_schools",
  secondary_schools: "secondary_schools",
  "secondary schools": "secondary_schools",
  secondary_school: "secondary_schools",
  supermarkets: "supermarkets",
  supermarket: "supermarkets",
  eldercare: "eldercare",
  "eldercare facilities": "eldercare",
};

function toCategoryKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const rawLower = raw.toLowerCase();
  if (CATEGORY_ALIASES[rawLower]) return CATEGORY_ALIASES[rawLower];

  const normalized = rawLower
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");

  return CATEGORY_ALIASES[normalized] || normalized;
}
const DEFAULT_CATEGORY_INFO = {
  title: "Category",
  source: "Source: —",
  includes: "No definition available.",
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
  categoryInfoButton: document.getElementById("categoryInfoButton"),
  categoryInfoTooltip: document.getElementById("categoryInfoTooltip"),
  categoryInfoTitle: document.getElementById("categoryInfoTitle"),
  categoryInfoSource: document.getElementById("categoryInfoSource"),
  categoryInfoIncludes: document.getElementById("categoryInfoIncludes"),
  snapshotSelect: document.getElementById("snapshotSelect"),
  metricSelect: document.getElementById("metricSelect"),
  ageGroupSelect: document.getElementById("ageGroupSelect"),
  configWarning: document.getElementById("configWarning"),
  statusLine: document.getElementById("statusLine"),
  contextLine: document.getElementById("contextLine"),
  errorLine: document.getElementById("errorLine"),
  legendTitle: document.getElementById("legendTitle"),
  legendBins: document.getElementById("legendBins"),
  topAreasSummary: document.getElementById("topAreasSummary"),
  topAreasList: document.getElementById("topAreasList"),
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
  availableCategories: [...FALLBACK_CATEGORY_ORDER],
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


function getCategoryLabel(key) {
  const normalizedKey = toCategoryKey(key);
  return CATEGORY_LABELS[normalizedKey] || key;
}

function getCategoryInfo(key) {
  const normalizedKey = toCategoryKey(key);
  return CATEGORY_INFO[normalizedKey] || DEFAULT_CATEGORY_INFO;
}

function getCategoriesFromIndex(indexPayload) {
  const data = indexPayload?.data ?? indexPayload;
  const categories = data?.categories || data?.amenities || data?.keys || [];
  const normalized = [...new Set(categories.map((item) => toCategoryKey(item)).filter(Boolean))];
  const sortedKnown = FALLBACK_CATEGORY_ORDER.filter((key) => normalized.includes(key));
  const remaining = normalized.filter((key) => !sortedKnown.includes(key)).sort();
  return [...sortedKnown, ...remaining];
}

function setCategoryOptions(categories) {
  ui.categorySelect.innerHTML = "";
  categories.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = getCategoryLabel(value);
    ui.categorySelect.appendChild(option);
  });
}

function updateCategoryInfoTooltip() {
  const info = getCategoryInfo(state.selection.category);
  ui.categoryInfoTitle.textContent = info.title;
  ui.categoryInfoSource.textContent = info.source;
  ui.categoryInfoIncludes.textContent = info.includes;
}

function closeCategoryInfoTooltip() {
  ui.categoryInfoTooltip.hidden = true;
  ui.categoryInfoButton.setAttribute("aria-expanded", "false");
}

function toggleCategoryInfoTooltip(forceOpen) {
  const isOpen = !ui.categoryInfoTooltip.hidden;
  const shouldOpen = typeof forceOpen === "boolean" ? forceOpen : !isOpen;
  ui.categoryInfoTooltip.hidden = !shouldOpen;
  ui.categoryInfoButton.setAttribute("aria-expanded", String(shouldOpen));
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

    const rowCategory = toCategoryKey(row.category || row.amenity || row.key || "");
    const targetCategory = toCategoryKey(category);
    let count = null;

    if (rowCategory) {
      if (rowCategory !== targetCategory) return;
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
  const rawBreaks = [];
  for (let i = 1; i <= bins; i += 1) {
    const idx = Math.min(sorted.length - 1, Math.floor((i * sorted.length) / bins) - 1);
    rawBreaks.push(sorted[Math.max(0, idx)]);
  }

  // Remove duplicate breakpoints so legend bins do not repeat (e.g. 1.00 - 1.00).
  return rawBreaks.filter((value, index) => index === 0 || value > rawBreaks[index - 1]);
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

function updateLegend(metric, breaks, category) {
  const categoryLabel = getCategoryLabel(category);
  ui.legendTitle.textContent = metric === "PER_1000" ? `${categoryLabel} per 1,000 residents` : `${categoryLabel} count`;
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

function updateTopAreas(features, valuesByJoinKey, options) {
  const rows = features
    .map((feature) => {
      const payload = valuesByJoinKey.get(feature.__joinKey);
      return {
        area: feature.__displayName,
        value: payload?.value,
        count: payload?.count,
      };
    })
    .filter((row) => Number.isFinite(row.value));

  rows.sort((a, b) => b.value - a.value || a.area.localeCompare(b.area));

  const ranked = [];
  let currentRank = 0;
  let previousValue = null;

  rows.forEach((row, index) => {
    if (previousValue === null || row.value !== previousValue) {
      currentRank = index + 1;
      previousValue = row.value;
    }
    ranked.push({ ...row, rank: currentRank });
  });

  const topRows = ranked.filter((row) => row.rank <= 5);

  const geoLabel = GEO_CONFIG[options.geo]?.label || "Area";
  if (topRows.length === 0) {
    ui.topAreasSummary.textContent = `No ${geoLabel.toLowerCase()} values available for ranking.`;
    ui.topAreasList.innerHTML = "";
    return;
  }

  const valueLabel = options.metric === "PER_1000" ? "per 1,000" : "count";
  ui.topAreasSummary.textContent = `Top ${Math.min(5, ranked.length)} ${geoLabel.toLowerCase()} by ${getCategoryLabel(options.category)} ${valueLabel} (including ties).`;

  ui.topAreasList.innerHTML = "";
  topRows.forEach((row) => {
    const item = document.createElement("li");
    const primary = options.metric === "PER_1000" ? formatMetric(row.value, "PER_1000") : formatMetric(row.value, "COUNT");
    const secondary = options.metric === "PER_1000" ? ` (count: ${formatMetric(row.count, "COUNT")})` : "";
    item.textContent = `#${row.rank} ${row.area}: ${primary}${secondary}`;
    ui.topAreasList.appendChild(item);
  });
}

function updateLayer(geoData, valuesByJoinKey, options) {
  const numericValues = geoData.features
    .map((feature) => valuesByJoinKey.get(feature.__joinKey)?.value)
    .filter((v) => Number.isFinite(v));
  const breaks = computeQuantileBreaks(numericValues, 5);
  updateLegend(options.metric, breaks, options.category);

  if (state.activeLayer) {
    map.removeLayer(state.activeLayer);
  }

  state.activeLayer = L.geoJSON(geoData, {
    style: (feature) => {
      const payload = valuesByJoinKey.get(feature.__joinKey);
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
        `${getCategoryLabel(options.category)}`,
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
  updateTopAreas(geoData.features, valuesByJoinKey, options);
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
      geo,
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
  setCategoryOptions(state.availableCategories);
  if (!state.availableCategories.includes(state.selection.category)) {
    state.selection.category = state.availableCategories[0] || "";
  }
  ui.categorySelect.value = state.selection.category;

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
    const categories = getCategoriesFromIndex(amenitiesIndex);
    if (categories.length > 0) {
      state.availableCategories = categories;
      setCategoryOptions(state.availableCategories);
      if (!state.availableCategories.includes(state.selection.category)) {
        state.selection.category = state.availableCategories[0];
      }
      ui.categorySelect.value = state.selection.category;
    }

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
    setError(`Failed to load amenities index: ${error.message}. Using fallback category list.`);
  }

  updateCategoryInfoTooltip();
  await render();
}

function syncSelectionAndRender() {
  state.selection.geo = ui.geoSelect.value;
  state.selection.category = toCategoryKey(ui.categorySelect.value);
  state.selection.snapshot = ui.snapshotSelect.value;
  state.selection.metric = ui.metricSelect.value;
  state.selection.ageGroup = ui.ageGroupSelect.value;
  ui.ageGroupSelect.disabled = state.selection.metric !== "PER_1000";
  updateCategoryInfoTooltip();
  render();
}

[ui.geoSelect, ui.categorySelect, ui.snapshotSelect, ui.metricSelect, ui.ageGroupSelect].forEach((element) => {
  element.addEventListener("change", syncSelectionAndRender);
});

ui.categoryInfoButton.addEventListener("mouseenter", () => toggleCategoryInfoTooltip(true));
ui.categoryInfoButton.addEventListener("click", (event) => {
  event.preventDefault();
  toggleCategoryInfoTooltip();
});

document.addEventListener("click", (event) => {
  if (ui.categoryInfoTooltip.hidden) return;
  if (ui.categoryInfoTooltip.contains(event.target) || ui.categoryInfoButton.contains(event.target)) return;
  closeCategoryInfoTooltip();
});

bootstrap();
