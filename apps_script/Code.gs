/**
 * Milestone 1: resident denominator builder (PA + SZ) and JSON endpoint.
 *
 * Input mode: Drive CSV file with headers PA,SZ,Age,Sex,Pop,Time
 */

const CONFIG = {
  OUTPUT_FOLDER_ID: '1a-Uzpe68ygqhhrEH8QDnTtda3gXXgx1L',
  // Milestone 3 placeholders: paste deployed public GeoJSON URLs here.
  SUBZONE_GEOJSON_URL: 'REPLACE_WITH_PUBLIC_SUBZONE_GEOJSON_URL',
  // Fallback only if subzone features do not include planning area names.
  PLANNING_AREA_GEOJSON_URL: 'REPLACE_WITH_PUBLIC_PLANNING_AREA_GEOJSON_URL',
  OVERPASS_ENDPOINT: 'https://overpass-api.de/api/interpreter',
  QUARTERLY_CHECK_MONTHS: [1, 4, 7, 10],
  AMENITY_INDEX_FILE: 'amenities_index.json',
  AMENITY_SZ_PREFIX: 'amenities_sz_',
  AMENITY_PA_PREFIX: 'amenities_pa_',
  AMENITY_DEBUG_PREFIX: 'amenities_debug_',
  RESIDENT_SOURCE: {
    mode: 'drive_csv',
    csvFileId: 'REPLACE_WITH_RESIDENT_CSV_FILE_ID',
    label: 'Drive CSV: PA,SZ,Age,Sex,Pop,Time'
  }
};

const AMENITY_CATEGORIES = [
  'gp_clinics',
  'dental',
  'childcare_preschool',
  'secondary_schools',
  'supermarkets',
  'eldercare'
];

const AGE_GROUPS = [
  'ALL',
  'CHILD_0_6',
  'CHILD_7_12',
  'TEEN_13_18',
  'YOUNG_ADULT_19_34',
  'ADULT_35_54',
  'YOUNG_SENIOR_55_64',
  'SENIOR_65_PLUS'
];

const BOUNDED_AGE_GROUPS = AGE_GROUPS.filter((group) => group !== 'ALL');



function buildAmenitySnapshot_(snapshotQuarter) {
  validateSnapshotQuarter_(snapshotQuarter);
  const folder = DriveApp.getFolderById(CONFIG.OUTPUT_FOLDER_ID);
  const polygons = loadSubzonePolygons_();

  const szCounts = {};
  const categoryStats = {
    total_points_by_category: {},
    assigned_points_by_category: {},
    unassigned_points_by_category: {}
  };
  const sampleAssignedPoints = {};

  AMENITY_CATEGORIES.forEach((category) => {
    const points = fetchAmenityPointsFromOverpass_(category);
    categoryStats.total_points_by_category[category] = points.length;
    categoryStats.assigned_points_by_category[category] = 0;
    categoryStats.unassigned_points_by_category[category] = 0;
    sampleAssignedPoints[category] = [];

    points.forEach((point) => {
      const match = findContainingSubzone_(point.lon, point.lat, polygons);
      if (!match) {
        categoryStats.unassigned_points_by_category[category] += 1;
        return;
      }

      if (!match.pa_name) {
        categoryStats.unassigned_points_by_category[category] += 1;
        return;
      }

      categoryStats.assigned_points_by_category[category] += 1;
      const key = [match.pa_name, match.sz_name, category].join('||');
      szCounts[key] = (szCounts[key] || 0) + 1;

      if (sampleAssignedPoints[category].length < 50) {
        sampleAssignedPoints[category].push({
          osm_type: point.osm_type,
          osm_id: point.osm_id,
          lon: point.lon,
          lat: point.lat,
          pa: match.pa_name,
          sz: match.sz_name
        });
      }
    });
  });

  const missingPaNames = polygons.some((p) => !p.pa_name);
  if (missingPaNames) {
    Logger.log('WARNING: Some subzone polygons are missing planning area names. PA output will include assigned rows only.');
  }

  const szRows = Object.keys(szCounts).map((key) => {
    const parts = key.split('||');
    return {
      snapshot: snapshotQuarter,
      pa: parts[0],
      sz: parts[1],
      category: parts[2],
      count: szCounts[key]
    };
  });

  szRows.sort((a, b) => a.pa.localeCompare(b.pa) || a.sz.localeCompare(b.sz) || a.category.localeCompare(b.category));

  const paCounts = {};
  szRows.forEach((row) => {
    const key = [row.pa, row.category].join('||');
    paCounts[key] = (paCounts[key] || 0) + row.count;
  });

  const paRows = Object.keys(paCounts).map((key) => {
    const parts = key.split('||');
    return {
      snapshot: snapshotQuarter,
      pa: parts[0],
      category: parts[1],
      count: paCounts[key]
    };
  });

  paRows.sort((a, b) => a.pa.localeCompare(b.pa) || a.category.localeCompare(b.category));

  const szFile = CONFIG.AMENITY_SZ_PREFIX + snapshotQuarter + '.json';
  const paFile = CONFIG.AMENITY_PA_PREFIX + snapshotQuarter + '.json';
  upsertJsonFile(folder, szFile, szRows);
  upsertJsonFile(folder, paFile, paRows);

  const debugPayload = {
    snapshot: snapshotQuarter,
    stats: categoryStats,
    sample_assigned_points: sampleAssignedPoints
  };
  upsertJsonFile(folder, CONFIG.AMENITY_DEBUG_PREFIX + snapshotQuarter + '.json', debugPayload);

  const index = readAmenityIndex_(folder);
  const snapshots = index.snapshots || [];
  if (snapshots.indexOf(snapshotQuarter) === -1) {
    snapshots.push(snapshotQuarter);
  }
  snapshots.sort(compareSnapshotQuarter_);

  const indexPayload = {
    updated_at: new Date().toISOString(),
    source: 'overpass',
    overpass_endpoint: CONFIG.OVERPASS_ENDPOINT,
    snapshots,
    categories: AMENITY_CATEGORIES.slice(),
    geos: ['pa', 'sz']
  };

  upsertJsonFile(folder, CONFIG.AMENITY_INDEX_FILE, indexPayload);
  return {
    snapshot: snapshotQuarter,
    sz_rows: szRows.length,
    pa_rows: paRows.length,
    debug: debugPayload
  };
}

function fetchAmenityPointsFromOverpass_(categoryKey) {
  const query = buildAmenityOverpassQuery_(categoryKey);
  const resp = UrlFetchApp.fetch(CONFIG.OVERPASS_ENDPOINT, {
    method: 'post',
    payload: { data: query },
    muteHttpExceptions: true
  });

  if (resp.getResponseCode() !== 200) {
    throw new Error('Overpass request failed for ' + categoryKey + ' status=' + resp.getResponseCode() + ' body=' + resp.getContentText().slice(0, 300));
  }

  const parsed = JSON.parse(resp.getContentText());
  const elements = parsed.elements || [];
  const seen = {};
  const out = [];

  elements.forEach((el) => {
    const lon = Number(el.lon !== undefined ? el.lon : el.center && el.center.lon);
    const lat = Number(el.lat !== undefined ? el.lat : el.center && el.center.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      return;
    }

    const osmType = el.type;
    const osmId = Number(el.id);
    if (!osmType || !Number.isFinite(osmId)) {
      return;
    }

    const key = osmType + '/' + osmId;
    if (seen[key]) return;
    seen[key] = true;

    out.push({
      osm_type: osmType,
      osm_id: osmId,
      lon,
      lat
    });
  });

  return out;
}

function buildAmenityOverpassQuery_(categoryKey) {
  const filters = overpassCategoryFilters_()[categoryKey];
  if (!filters) {
    throw new Error('Unsupported amenity category: ' + categoryKey);
  }

  return [
    '[out:json][timeout:90];',
    'area["ISO3166-1"="SG"]["admin_level"="2"]->.sg;',
    '(',
    filters,
    ');',
    'out center;'
  ].join('\n');
}

function overpassCategoryFilters_() {
  return {
    gp_clinics: [
      'node(area.sg)["amenity"="doctors"]["amenity"!="hospital"];',
      'way(area.sg)["amenity"="doctors"]["amenity"!="hospital"];',
      'relation(area.sg)["amenity"="doctors"]["amenity"!="hospital"];',
      'node(area.sg)["amenity"="clinic"]["amenity"!="hospital"];',
      'way(area.sg)["amenity"="clinic"]["amenity"!="hospital"];',
      'relation(area.sg)["amenity"="clinic"]["amenity"!="hospital"];',
      'node(area.sg)["healthcare"="doctor"];',
      'way(area.sg)["healthcare"="doctor"];',
      'relation(area.sg)["healthcare"="doctor"];',
      'node(area.sg)["healthcare"="clinic"];',
      'way(area.sg)["healthcare"="clinic"];',
      'relation(area.sg)["healthcare"="clinic"];'
    ].join('\n'),
    dental: [
      'node(area.sg)["amenity"="dentist"];',
      'way(area.sg)["amenity"="dentist"];',
      'relation(area.sg)["amenity"="dentist"];',
      'node(area.sg)["healthcare"="dentist"];',
      'way(area.sg)["healthcare"="dentist"];',
      'relation(area.sg)["healthcare"="dentist"];'
    ].join('\n'),
    childcare_preschool: [
      'node(area.sg)["amenity"="childcare"];',
      'way(area.sg)["amenity"="childcare"];',
      'relation(area.sg)["amenity"="childcare"];',
      'node(area.sg)["amenity"="kindergarten"];',
      'way(area.sg)["amenity"="kindergarten"];',
      'relation(area.sg)["amenity"="kindergarten"];',
      'node(area.sg)["childcare"="yes"];',
      'way(area.sg)["childcare"="yes"];',
      'relation(area.sg)["childcare"="yes"];'
    ].join('\n'),
    secondary_schools: [
      'node(area.sg)["amenity"="school"]["school:level"~"secondary",i];',
      'way(area.sg)["amenity"="school"]["school:level"~"secondary",i];',
      'relation(area.sg)["amenity"="school"]["school:level"~"secondary",i];',
      'node(area.sg)["amenity"="school"]["isced:level"~"(^|;|,)(2|3)($|;|,)"];',
      'way(area.sg)["amenity"="school"]["isced:level"~"(^|;|,)(2|3)($|;|,)"];',
      'relation(area.sg)["amenity"="school"]["isced:level"~"(^|;|,)(2|3)($|;|,)"];',
      'node(area.sg)["amenity"="school"]["grades"~"(7|8|9|10|11|12)"];',
      'way(area.sg)["amenity"="school"]["grades"~"(7|8|9|10|11|12)"];',
      'relation(area.sg)["amenity"="school"]["grades"~"(7|8|9|10|11|12)"];'
    ].join('\n'),
    supermarkets: [
      'node(area.sg)["shop"="supermarket"];',
      'way(area.sg)["shop"="supermarket"];',
      'relation(area.sg)["shop"="supermarket"];'
    ].join('\n'),
    eldercare: [
      'node(area.sg)["amenity"="social_facility"]["social_facility"~"^(nursing_home|assisted_living|group_home|day_care|retirement_home)$"];',
      'way(area.sg)["amenity"="social_facility"]["social_facility"~"^(nursing_home|assisted_living|group_home|day_care|retirement_home)$"];',
      'relation(area.sg)["amenity"="social_facility"]["social_facility"~"^(nursing_home|assisted_living|group_home|day_care|retirement_home)$"];',
      'node(area.sg)["healthcare"="nursing_home"];',
      'way(area.sg)["healthcare"="nursing_home"];',
      'relation(area.sg)["healthcare"="nursing_home"];'
    ].join('\n')
  };
}

function loadSubzonePolygons_() {
  const cache = CacheService.getScriptCache();
  const key = 'subzone_polygons_v1';
  const cached = cache.get(key);
  if (cached) {
    return JSON.parse(cached);
  }

  if (!CONFIG.SUBZONE_GEOJSON_URL || CONFIG.SUBZONE_GEOJSON_URL.indexOf('REPLACE_') === 0) {
    throw new Error('CONFIG.SUBZONE_GEOJSON_URL is not configured. Paste a public URL to subzone.geojson.');
  }

  const geojson = fetchGeoJson_(CONFIG.SUBZONE_GEOJSON_URL);
  const polygons = normalizeSubzonePolygons_(geojson);
  if (!polygons.length) {
    throw new Error('No subzone polygons parsed from GeoJSON.');
  }

  cache.put(key, JSON.stringify(polygons), 21600);
  return polygons;
}

function fetchGeoJson_(url) {
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) {
    throw new Error('GeoJSON fetch failed: ' + url + ' status=' + resp.getResponseCode());
  }
  return JSON.parse(resp.getContentText());
}

function normalizeSubzonePolygons_(geojson) {
  const features = (geojson && geojson.features) || [];
  const out = [];

  features.forEach((feature) => {
    const props = feature.properties || {};
    const szName = pickFirstProperty_(props, ['SUBZONE_N', 'SUBZONE_NAME', 'SZ', 'name']);
    if (!szName) return;

    const paName = pickFirstProperty_(props, ['PLN_AREA_N', 'PLN_AREA_NAME', 'PA', 'planning_area', 'name_1']);
    const geom = feature.geometry || {};
    const polySets = geometryToPolygonSets_(geom);

    polySets.forEach((rings) => {
      const bbox = computeBboxFromRings_(rings);
      out.push({
        pa_name: paName ? normalizeText(paName) : null,
        sz_name: normalizeText(szName),
        bbox,
        rings
      });
    });
  });

  return out;
}

function geometryToPolygonSets_(geometry) {
  if (!geometry || !geometry.type || !geometry.coordinates) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

function computeBboxFromRings_(rings) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  rings.forEach((ring) => {
    ring.forEach((pt) => {
      const lon = Number(pt[0]);
      const lat = Number(pt[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
      minLon = Math.min(minLon, lon);
      minLat = Math.min(minLat, lat);
      maxLon = Math.max(maxLon, lon);
      maxLat = Math.max(maxLat, lat);
    });
  });

  return [minLon, minLat, maxLon, maxLat];
}

function pickFirstProperty_(props, keys) {
  for (let i = 0; i < keys.length; i += 1) {
    const val = props[keys[i]];
    if (!isBlank(val)) return String(val).trim();
  }
  return '';
}

function findContainingSubzone_(lon, lat, polygons) {
  for (let i = 0; i < polygons.length; i += 1) {
    const poly = polygons[i];
    if (!isInBbox_(lon, lat, poly.bbox)) continue;
    if (pointInPolygon_(lon, lat, poly.rings)) {
      return {
        pa_name: poly.pa_name,
        sz_name: poly.sz_name
      };
    }
  }
  return null;
}

function isInBbox_(lon, lat, bbox) {
  return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

function pointInPolygon_(lon, lat, rings) {
  if (!rings || !rings.length) return false;
  const outerInside = isPointInRing_(lon, lat, rings[0]);
  if (!outerInside) return false;
  for (let i = 1; i < rings.length; i += 1) {
    if (isPointInRing_(lon, lat, rings[i])) return false;
  }
  return true;
}

function isPointInRing_(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = Number(ring[i][0]);
    const yi = Number(ring[i][1]);
    const xj = Number(ring[j][0]);
    const yj = Number(ring[j][1]);

    const intersects = ((yi > lat) !== (yj > lat)) &&
      (lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function readAmenityIndex_(folder) {
  const existing = readJsonByFileName(folder, CONFIG.AMENITY_INDEX_FILE, true);
  if (!existing) {
    return {
      snapshots: []
    };
  }
  if (!Array.isArray(existing.snapshots)) {
    existing.snapshots = [];
  }
  return existing;
}

function getCurrentSnapshotQuarter_() {
  const now = new Date();
  const year = now.getFullYear();
  const quarter = Math.floor(now.getMonth() / 3) + 1;
  return year + 'Q' + quarter;
}

function validateSnapshotQuarter_(snapshotQuarter) {
  if (!/^\d{4}Q[1-4]$/.test(String(snapshotQuarter || ''))) {
    throw new Error('snapshotQuarter must be in format YYYYQn (n=1..4).');
  }
}

function compareSnapshotQuarter_(a, b) {
  const ay = parseInt(a.slice(0, 4), 10);
  const by = parseInt(b.slice(0, 4), 10);
  const aq = parseInt(a.slice(5), 10);
  const bq = parseInt(b.slice(5), 10);
  if (ay !== by) return ay - by;
  return aq - bq;
}

function ensureQuarterlyAmenityTrigger_() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach((trigger) => {
    if (trigger.getHandlerFunction() === 'scheduledAmenityCheck') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('scheduledAmenityCheck')
    .timeBased()
    .onMonthDay(1)
    .atHour(6)
    .create();
}

function scheduledAmenityCheck() {
  const now = new Date();
  const month = now.getMonth() + 1;
  if (CONFIG.QUARTERLY_CHECK_MONTHS.indexOf(month) === -1) {
    Logger.log('scheduledAmenityCheck skipped for month=' + month);
    return;
  }

  const snapshotQuarter = getCurrentSnapshotQuarter_();
  const folder = DriveApp.getFolderById(CONFIG.OUTPUT_FOLDER_ID);
  const index = readAmenityIndex_(folder);
  if ((index.snapshots || []).indexOf(snapshotQuarter) !== -1) {
    Logger.log('scheduledAmenityCheck skipped, snapshot exists=' + snapshotQuarter);
    return;
  }

  buildAmenitySnapshot_(snapshotQuarter);
}

function runAmenityNow() {
  return buildAmenitySnapshot_(getCurrentSnapshotQuarter_());
}

function rebuildAmenitySnapshot(snapshotQuarter) {
  return buildAmenitySnapshot_(snapshotQuarter);
}

function runAmenityTests(snapshotQuarter) {
  validateSnapshotQuarter_(snapshotQuarter);
  const perCategoryPoints = {};
  const coverageWarnings = [];

  AMENITY_CATEGORIES.forEach((category) => {
    const points = fetchAmenityPointsFromOverpass_(category);
    perCategoryPoints[category] = points.length;
    Logger.log('Amenity test overpass count category=%s count=%s', category, points.length);
  });

  if (perCategoryPoints.supermarkets > 5000) {
    throw new Error('Sanity check failed: supermarkets points > 5000 (' + perCategoryPoints.supermarkets + ')');
  }

  const buildResult = buildAmenitySnapshot_(snapshotQuarter);
  const debug = buildResult.debug;

  AMENITY_CATEGORIES.forEach((category) => {
    const total = debug.stats.total_points_by_category[category] || 0;
    const assigned = debug.stats.assigned_points_by_category[category] || 0;
    const ratio = total > 0 ? assigned / total : 1;
    if (ratio < 0.8) {
      coverageWarnings.push({ category, ratio, assigned, total });
      Logger.log('WARNING coverage below 0.80 category=%s ratio=%s assigned=%s total=%s', category, ratio, assigned, total);
    }
  });

  const folder = DriveApp.getFolderById(CONFIG.OUTPUT_FOLDER_ID);
  const szRows = readJsonByFileName(folder, CONFIG.AMENITY_SZ_PREFIX + snapshotQuarter + '.json');
  const allowedKeys = ['snapshot', 'pa', 'sz', 'category', 'count'];
  szRows.forEach((row) => {
    const keys = Object.keys(row).sort();
    if (JSON.stringify(keys) !== JSON.stringify(allowedKeys.slice().sort())) {
      throw new Error('Output compactness failed: unexpected keys=' + JSON.stringify(keys));
    }
  });

  const beforeIndex = readJsonByFileName(folder, CONFIG.AMENITY_INDEX_FILE);
  buildAmenitySnapshot_(snapshotQuarter);
  const afterIndex = readJsonByFileName(folder, CONFIG.AMENITY_INDEX_FILE);
  const beforeCount = beforeIndex.snapshots.filter((s) => s === snapshotQuarter).length;
  const afterCount = afterIndex.snapshots.filter((s) => s === snapshotQuarter).length;
  if (beforeCount !== 1 || afterCount !== 1) {
    throw new Error('Idempotency failed: snapshot appears multiple times in index. before=' + beforeCount + ', after=' + afterCount);
  }

  Logger.log('runAmenityTests completed. coverageWarnings=%s', JSON.stringify(coverageWarnings));
  Logger.log('Note: secondary_schools may undercount because many OSM schools omit level tags.');

  return {
    snapshot: snapshotQuarter,
    counts: perCategoryPoints,
    coverage_warnings: coverageWarnings
  };
}
function buildDenomsAllYears() {
  const rawRows = loadResidentInputRows();
  const parsed = parseResidentRows(rawRows);
  const computed = computeDenoms(parsed.rows, parsed.meta);

  runDenominatorChecks(computed);
  writeDenomsToDrive(computed.byYear, computed.meta);

  logBuildSummary(parsed, computed);
}

function loadResidentInputRows() {
  if (CONFIG.RESIDENT_SOURCE.mode !== 'drive_csv') {
    throw new Error('Unsupported RESIDENT_SOURCE mode. Use drive_csv for this milestone.');
  }

  if (!CONFIG.RESIDENT_SOURCE.csvFileId || CONFIG.RESIDENT_SOURCE.csvFileId.indexOf('REPLACE_') === 0) {
    throw new Error('CONFIG.RESIDENT_SOURCE.csvFileId is not configured.');
  }

  const file = DriveApp.getFileById(CONFIG.RESIDENT_SOURCE.csvFileId);
  const csvText = file.getBlob().getDataAsString('UTF-8');
  return Utilities.parseCsv(csvText);
}

function parseResidentRows(input) {
  if (!input || !input.length) {
    throw new Error('Input is empty.');
  }

  const header = input[0].map((h) => String(h || '').trim());
  const idx = indexColumns(header);

  const rows = [];
  const dropped = {
    missing_pa: 0,
    missing_sz: 0,
    missing_year: 0,
    invalid_year: 0,
    missing_pop: 0,
    invalid_pop: 0,
    negative_pop: 0
  };

  const meta = {
    input_rows: Math.max(0, input.length - 1),
    parsed_rows: 0,
    dropped,
    non_numeric_age_rows: 0
  };

  for (let i = 1; i < input.length; i += 1) {
    const r = input[i];

    const pa = normalizeText(r[idx.PA]);
    const sz = normalizeText(r[idx.SZ]);
    const sex = normalizeText(r[idx.Sex]);

    if (!pa) {
      dropped.missing_pa += 1;
      continue;
    }

    if (!sz) {
      dropped.missing_sz += 1;
      continue;
    }

    const yearRaw = r[idx.Time];
    if (isBlank(yearRaw)) {
      dropped.missing_year += 1;
      continue;
    }
    const year = parseInt(String(yearRaw).trim(), 10);
    if (!Number.isFinite(year)) {
      dropped.invalid_year += 1;
      continue;
    }

    const popRaw = r[idx.Pop];
    if (isBlank(popRaw)) {
      dropped.missing_pop += 1;
      continue;
    }
    const pop = parseInt(String(popRaw).replace(/,/g, '').trim(), 10);
    if (!Number.isFinite(pop)) {
      dropped.invalid_pop += 1;
      continue;
    }
    if (pop < 0) {
      dropped.negative_pop += 1;
      continue;
    }

    const ageParsed = parseAge(r[idx.Age]);
    if (!Number.isFinite(ageParsed)) {
      meta.non_numeric_age_rows += 1;
    }

    rows.push({
      pa,
      sz,
      sex,
      age: ageParsed,
      pop,
      year
    });
  }

  meta.parsed_rows = rows.length;
  return { rows, meta };
}

function computeDenoms(rows, parseMeta) {
  const byYear = {};
  const byYearPaSets = {};
  const byYearSzSets = {};

  rows.forEach((row) => {
    const year = row.year;
    if (!byYear[year]) {
      byYear[year] = {
        szAgg: {},
        paAgg: {}
      };
      byYearPaSets[year] = {};
      byYearSzSets[year] = {};
    }

    byYearPaSets[year][row.pa] = true;
    byYearSzSets[year][row.pa + '||' + row.sz] = true;

    const groups = determineAgeGroups(row.age);
    groups.forEach((ageGroup) => {
      const szKey = [row.pa, row.sz, ageGroup].join('||');
      byYear[year].szAgg[szKey] = (byYear[year].szAgg[szKey] || 0) + row.pop;

      const paKey = [row.pa, ageGroup].join('||');
      byYear[year].paAgg[paKey] = (byYear[year].paAgg[paKey] || 0) + row.pop;
    });
  });

  const out = {};
  Object.keys(byYear).forEach((yearKey) => {
    const year = parseInt(yearKey, 10);
    const yr = byYear[yearKey];

    const szRows = Object.keys(yr.szAgg).map((key) => {
      const parts = key.split('||');
      return {
        year,
        pa: parts[0],
        sz: parts[1],
        age_group: parts[2],
        residents: yr.szAgg[key]
      };
    });

    const paRows = Object.keys(yr.paAgg).map((key) => {
      const parts = key.split('||');
      return {
        year,
        pa: parts[0],
        age_group: parts[1],
        residents: yr.paAgg[key]
      };
    });

    szRows.sort(sortSzRows);
    paRows.sort(sortPaRows);

    out[year] = {
      sz: szRows,
      pa: paRows,
      stats: {
        unique_pa_count: Object.keys(byYearPaSets[year]).length,
        unique_sz_count: Object.keys(byYearSzSets[year]).length
      }
    };
  });

  return {
    byYear: out,
    meta: {
      source: CONFIG.RESIDENT_SOURCE.label,
      parse: parseMeta,
      generated_at: new Date().toISOString()
    }
  };
}

function writeDenomsToDrive(byYear, meta) {
  if (!CONFIG.OUTPUT_FOLDER_ID || CONFIG.OUTPUT_FOLDER_ID.indexOf('REPLACE_') === 0) {
    throw new Error('CONFIG.OUTPUT_FOLDER_ID is not configured.');
  }

  const folder = DriveApp.getFolderById(CONFIG.OUTPUT_FOLDER_ID);
  const years = Object.keys(byYear).map((y) => parseInt(y, 10)).sort();

  years.forEach((year) => {
    upsertJsonFile(folder, 'denoms_sz_' + year + '.json', byYear[year].sz);
    upsertJsonFile(folder, 'denoms_pa_' + year + '.json', byYear[year].pa);
  });

  const indexPayload = {
    updated_at: new Date().toISOString(),
    source: meta.source,
    vintages: years,
    age_groups: AGE_GROUPS,
    geos: ['pa', 'sz']
  };

  upsertJsonFile(folder, 'denoms_index.json', indexPayload);
}

function runDenominatorChecks(computed) {
  const years = Object.keys(computed.byYear).map((y) => parseInt(y, 10)).sort();
  if (!years.length) {
    throw new Error('No years found after aggregation.');
  }

  years.forEach((year) => {
    const paRows = computed.byYear[year].pa;
    const szRows = computed.byYear[year].sz;

    // 1) Sanity totals
    const paAllTotal = paRows
      .filter((r) => r.age_group === 'ALL')
      .reduce((acc, r) => acc + r.residents, 0);
    if (paAllTotal <= 3000000) {
      throw new Error('Sanity check failed for ' + year + ': PA ALL total <= 3,000,000 (' + paAllTotal + ')');
    }

    // 2) Internal consistency checks
    const paGrouped = groupPaRows(paRows);
    const mismatches = [];
    Object.keys(paGrouped).forEach((pa) => {
      const rec = paGrouped[pa];
      const allVal = rec.ALL || 0;
      const maxBand = Math.max.apply(null, BOUNDED_AGE_GROUPS.map((g) => rec[g] || 0));
      const sumBands = BOUNDED_AGE_GROUPS.reduce((acc, g) => acc + (rec[g] || 0), 0);

      if (allVal < maxBand) {
        throw new Error('ALL < max band for year=' + year + ', pa=' + pa);
      }
      if (allVal < sumBands) {
        mismatches.push({ pa, allVal, sumBands });
      }
    });
    if (mismatches.length) {
      Logger.log('Internal consistency mismatch year=%s count=%s. Non-numeric ages may explain this.', year, mismatches.length);
      Logger.log(JSON.stringify(mismatches.slice(0, 20)));
    }

    // 3) No invalids
    validateOutputRows(paRows, ['pa']);
    validateOutputRows(szRows, ['pa', 'sz']);

    // 4) Shape checks
    shapeCheckPa(year, paRows);
    shapeCheckSz(year, szRows);
  });

  // 5) Endpoint checks
  testEndpointResponses(years[0]);
}

function testDenomsOutputs() {
  const folder = DriveApp.getFolderById(CONFIG.OUTPUT_FOLDER_ID);
  const index = readJsonByFileName(folder, 'denoms_index.json');
  if (!index.vintages || !index.vintages.length) {
    throw new Error('denoms_index.json has no vintages.');
  }
  if (JSON.stringify(index.age_groups) !== JSON.stringify(AGE_GROUPS)) {
    throw new Error('denoms_index.json age_groups mismatch.');
  }

  const year = index.vintages[index.vintages.length - 1];
  const sz = readJsonByFileName(folder, 'denoms_sz_' + year + '.json');
  const pa = readJsonByFileName(folder, 'denoms_pa_' + year + '.json');
  if (!Array.isArray(sz) || !sz.length || !Array.isArray(pa) || !pa.length) {
    throw new Error('Year payload missing rows for ' + year);
  }

  Logger.log('testDenomsOutputs passed for year=%s (sz rows=%s, pa rows=%s)', year, sz.length, pa.length);
}

function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    const path = params.path;

    if (path === 'denoms/index') {
      const index = loadJsonFromOutputFolder('denoms_index.json');
      return jsonResponse(index, 200);
    }

    if (path === 'denoms') {
      const geo = String(params.geo || '').toLowerCase();
      const year = parseInt(String(params.year || ''), 10);

      if (!geo || !Number.isFinite(year)) {
        return jsonError('Missing required query params: geo and year', 400);
      }
      if (geo !== 'pa' && geo !== 'sz') {
        return jsonError('geo must be one of: pa, sz', 400);
      }

      const fileName = 'denoms_' + geo + '_' + year + '.json';
      const payload = loadJsonFromOutputFolder(fileName, true);
      if (!payload) {
        return jsonError('year not found', 404);
      }
      return jsonResponse(payload, 200);
    }

    if (path === 'amenities/index') {
      const index = loadJsonFromOutputFolder(CONFIG.AMENITY_INDEX_FILE, true);
      if (!index) {
        return jsonError('amenities index not found', 404);
      }
      return jsonResponse(index, 200);
    }

    if (path === 'amenities') {
      const geo = String(params.geo || '').toLowerCase();
      const snapshot = String(params.snapshot || '');

      if (!geo || !snapshot) {
        return jsonError('Missing required query params: geo and snapshot', 400);
      }
      if (geo !== 'pa' && geo !== 'sz') {
        return jsonError('geo must be one of: pa, sz', 400);
      }
      if (!/^\d{4}Q[1-4]$/.test(snapshot)) {
        return jsonError('snapshot must be in format YYYYQn', 400);
      }

      const fileName = (geo === 'sz' ? CONFIG.AMENITY_SZ_PREFIX : CONFIG.AMENITY_PA_PREFIX) + snapshot + '.json';
      const payload = loadJsonFromOutputFolder(fileName, true);
      if (!payload) {
        return jsonError('snapshot not found', 404);
      }
      return jsonResponse(payload, 200);
    }

    return jsonError('Unknown path', 404);
  } catch (err) {
    return jsonError(err.message || String(err), 500);
  }
}

function determineAgeGroups(age) {
  if (!Number.isFinite(age)) {
    return ['ALL', 'SENIOR_65_PLUS'];
  }

  if (age >= 0 && age <= 6) return ['ALL', 'CHILD_0_6'];
  if (age >= 7 && age <= 12) return ['ALL', 'CHILD_7_12'];
  if (age >= 13 && age <= 18) return ['ALL', 'TEEN_13_18'];
  if (age >= 19 && age <= 34) return ['ALL', 'YOUNG_ADULT_19_34'];
  if (age >= 35 && age <= 54) return ['ALL', 'ADULT_35_54'];
  if (age >= 55 && age <= 64) return ['ALL', 'YOUNG_SENIOR_55_64'];
  if (age >= 65) return ['ALL', 'SENIOR_65_PLUS'];

  return ['ALL'];
}

function parseAge(rawAge) {
  if (isBlank(rawAge)) return NaN;
  const cleaned = String(rawAge).trim();
  if (/^\d+$/.test(cleaned)) return parseInt(cleaned, 10);
  return NaN;
}

function indexColumns(header) {
  const map = {};
  header.forEach((h, i) => {
    map[h.toLowerCase()] = i;
  });

  const required = ['pa', 'sz', 'age', 'sex', 'pop', 'time'];
  required.forEach((name) => {
    if (map[name] === undefined) {
      throw new Error('Missing required column: ' + name);
    }
  });

  return {
    PA: map.pa,
    SZ: map.sz,
    Age: map.age,
    Sex: map.sex,
    Pop: map.pop,
    Time: map.time
  };
}

function normalizeText(value) {
  if (isBlank(value)) return '';
  return String(value).trim().toUpperCase();
}

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

function upsertJsonFile(folder, fileName, payload) {
  const existing = folder.getFilesByName(fileName);
  while (existing.hasNext()) {
    existing.next().setTrashed(true);
  }

  const blob = Utilities.newBlob(JSON.stringify(payload), 'application/json', fileName);
  folder.createFile(blob);
}

function loadJsonFromOutputFolder(fileName, allowMissing) {
  const folder = DriveApp.getFolderById(CONFIG.OUTPUT_FOLDER_ID);
  return readJsonByFileName(folder, fileName, allowMissing);
}

function readJsonByFileName(folder, fileName, allowMissing) {
  const files = folder.getFilesByName(fileName);
  if (!files.hasNext()) {
    if (allowMissing) return null;
    throw new Error('File not found: ' + fileName);
  }
  const content = files.next().getBlob().getDataAsString('UTF-8');
  return JSON.parse(content);
}

function jsonResponse(payload, statusCode) {
  // Apps Script TextOutput cannot set HTTP status codes.
  const out = {
    status: statusCode,
    data: payload
  };
  return ContentService
    .createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonError(message, statusCode) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: statusCode, error: message }))
    .setMimeType(ContentService.MimeType.JSON);
}

function sortPaRows(a, b) {
  return a.pa.localeCompare(b.pa) || a.age_group.localeCompare(b.age_group);
}

function sortSzRows(a, b) {
  return a.pa.localeCompare(b.pa) || a.sz.localeCompare(b.sz) || a.age_group.localeCompare(b.age_group);
}

function groupPaRows(rows) {
  const out = {};
  rows.forEach((r) => {
    if (!out[r.pa]) out[r.pa] = {};
    out[r.pa][r.age_group] = r.residents;
  });
  return out;
}

function validateOutputRows(rows, requiredStrings) {
  rows.forEach((row) => {
    requiredStrings.forEach((key) => {
      if (!row[key] || !String(row[key]).trim()) {
        throw new Error('Blank value in output field: ' + key);
      }
    });

    if (!Number.isInteger(row.residents) || row.residents < 0) {
      throw new Error('Invalid residents value: ' + row.residents);
    }
  });
}

function shapeCheckPa(year, paRows) {
  const paMap = {};
  paRows.forEach((r) => {
    if (!paMap[r.pa]) paMap[r.pa] = {};
    paMap[r.pa][r.age_group] = true;
  });

  const uniquePaCount = Object.keys(paMap).length;
  const expected = uniquePaCount * AGE_GROUPS.length;
  const actual = paRows.length;

  if (actual !== expected) {
    const missing = [];
    Object.keys(paMap).forEach((pa) => {
      AGE_GROUPS.forEach((ageGroup) => {
        if (!paMap[pa][ageGroup]) {
          missing.push(pa + ':' + ageGroup);
        }
      });
    });
    Logger.log('PA shape mismatch year=%s expected=%s actual=%s missing=%s', year, expected, actual, JSON.stringify(missing.slice(0, 100)));
  }
}

function shapeCheckSz(year, szRows) {
  const szMap = {};
  szRows.forEach((r) => {
    const key = r.pa + '||' + r.sz;
    if (!szMap[key]) szMap[key] = {};
    szMap[key][r.age_group] = true;
  });

  const uniqueSzCount = Object.keys(szMap).length;
  const expected = uniqueSzCount * AGE_GROUPS.length;
  const actual = szRows.length;

  if (actual !== expected) {
    const missing = [];
    Object.keys(szMap).forEach((key) => {
      AGE_GROUPS.forEach((ageGroup) => {
        if (!szMap[key][ageGroup]) {
          missing.push(key + ':' + ageGroup);
        }
      });
    });
    Logger.log('SZ shape mismatch year=%s expected=%s actual=%s missing=%s', year, expected, actual, JSON.stringify(missing.slice(0, 100)));
  }
}

function testEndpointResponses(knownYear) {
  const idx = doGet({ parameter: { path: 'denoms/index' } });
  const idxObj = JSON.parse(idx.getContent());

  if (!idxObj.data || !Array.isArray(idxObj.data.vintages)) {
    throw new Error('Endpoint test failed: index missing vintages array.');
  }
  if (JSON.stringify(idxObj.data.age_groups) !== JSON.stringify(AGE_GROUPS)) {
    throw new Error('Endpoint test failed: index age_groups mismatch.');
  }

  const den = doGet({ parameter: { path: 'denoms', geo: 'pa', year: String(knownYear) } });
  const denObj = JSON.parse(den.getContent());
  if (!Array.isArray(denObj.data) || denObj.data.length === 0) {
    throw new Error('Endpoint test failed: denominator payload empty for year ' + knownYear);
  }
}

function logBuildSummary(parsed, computed) {
  const years = Object.keys(computed.byYear).map((y) => parseInt(y, 10)).sort();
  Logger.log('Denominator build complete. years=%s', JSON.stringify(years));
  Logger.log('Rows input=%s parsed=%s dropped=%s non_numeric_age=%s',
    parsed.meta.input_rows,
    parsed.meta.parsed_rows,
    JSON.stringify(parsed.meta.dropped),
    parsed.meta.non_numeric_age_rows
  );

  years.forEach((year) => {
    const stats = computed.byYear[year].stats;
    Logger.log('Year=%s planning_areas=%s subzones=%s pa_rows=%s sz_rows=%s',
      year,
      stats.unique_pa_count,
      stats.unique_sz_count,
      computed.byYear[year].pa.length,
      computed.byYear[year].sz.length
    );
  });
}
