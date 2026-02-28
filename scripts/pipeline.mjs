import fs from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import { parse as parseCsv } from "csv-parse/sync";

const ROOT = process.cwd();

const CONFIG = {
  TIMEZONE: "Asia/Singapore",

  SINGSTAT_LATEST_DATA_URL:
    "https://www.singstat.gov.sg/find-data/search-by-theme/population/geographic-distribution/latest-data",
  DENOM_CHECK_MONTHS: [1, 7],
  AMENITY_CHECK_MONTHS: [1, 4, 7, 10],

  AGE_GROUPS: [
    "ALL",
    "CHILD_0_6",
    "CHILD_7_12",
    "TEEN_13_18",
    "YOUNG_ADULT_19_34",
    "ADULT_35_54",
    "YOUNG_SENIOR_55_64",
    "SENIOR_65_PLUS",
  ],

  OUTPUT_DIR: path.join(ROOT, "web", "data"),
  SUBZONE_GEOJSON_PATH: path.join(ROOT, "web", "assets", "subzone.geojson"),

  DENOMS_INDEX_FILE: "denoms_index.json",
  DENOMS_PA_PREFIX: "denoms_pa_",
  DENOMS_SZ_PREFIX: "denoms_sz_",
  ARCHIVE_RAW_CSV: true,
  RAW_DIR: path.join(ROOT, "web", "data", "raw"),
  RAW_PREFIX: "raw_respopagesex_",

  AMENITIES_INDEX_FILE: "amenities_index.json",
  AMENITIES_PA_PREFIX: "amenities_pa_",
  AMENITIES_SZ_PREFIX: "amenities_sz_",
  AMENITIES_DEBUG_PREFIX: "amenities_debug_",
  WRITE_AMENITY_DEBUG: true,

  AMENITY_CATEGORIES: {
    gp_clinics: { label: "GP clinics", source: "OSM" },
    dental: { label: "Dental", source: "OSM" },
    childcare_preschool: { label: "Childcare / preschool", source: "OSM" },
    primary_schools: { label: "Primary schools", source: "MOE_ONEMAP" },
    secondary_schools: { label: "Secondary schools", source: "MOE_ONEMAP" },
    supermarkets: { label: "Supermarkets", source: "OSM" },
    eldercare: { label: "Eldercare facilities", source: "OSM" },
  },

  OVERPASS_ENDPOINTS: [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.nchc.org.tw/api/interpreter",
  ],
  OVERPASS_TIMEOUT_SEC: 120,
  OVERPASS_RETRY_MAX: 5,
  OVERPASS_RETRY_BASE_SLEEP_MS: 1500,

  DATAGOV_DATASTORE_SEARCH: "https://data.gov.sg/api/action/datastore_search",
  MOE_GENERAL_INFO_DATASET_ID: "d_688b934f82c1059ed0a6993d2a829089",

  ONEMAP_TOKEN_URL: "https://www.onemap.gov.sg/api/auth/post/getToken",
  ONEMAP_SEARCH_URL: "https://www.onemap.gov.sg/api/common/elastic/search",
  ONEMAP_TOKEN_CACHE_FILE: path.join(ROOT, ".cache", "onemap-token.json"),
  ONEMAP_GEOCODE_CACHE_FILE: path.join(ROOT, "scripts", "cache", "onemap_geocode_cache.json"),

  NAME_OVERRIDES: {},
};

let runtimeToken = null;
let runtimeTokenExpMs = 0;

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));

  await ensureDir(CONFIG.OUTPUT_DIR);
  await ensureDir(path.dirname(CONFIG.ONEMAP_TOKEN_CACHE_FILE));
  await ensureDir(path.dirname(CONFIG.ONEMAP_GEOCODE_CACHE_FILE));
  await ensureDir(CONFIG.RAW_DIR);

  if (command === "denoms") {
    await updateDenominators({
      force: flags.force || flags.forceDenoms,
      targetYear: flags.year || null,
    });
    return;
  }

  if (command === "amenities") {
    await buildAmenitiesIfDue({
      force: flags.force || flags.forceAmenities,
      forceOverwrite: flags.force || flags.forceAmenities,
      targetSnapshot: flags.snapshot || null,
    });
    return;
  }

  if (command === "all") {
    await updateDenominators({
      force: flags.force || flags.forceDenoms,
      targetYear: flags.year || null,
    });

    await buildAmenitiesIfDue({
      force: flags.force || flags.forceAmenities,
      forceOverwrite: flags.force || flags.forceAmenities,
      targetSnapshot: flags.snapshot || null,
    });
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function parseArgs(argv) {
  const command = argv[0] || "all";
  const flags = {
    force: false,
    forceDenoms: false,
    forceAmenities: false,
    year: null,
    snapshot: null,
  };

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--force") flags.force = true;
    else if (arg === "--force-denoms") flags.forceDenoms = true;
    else if (arg === "--force-amenities") flags.forceAmenities = true;
    else if (arg === "--year") {
      flags.year = Number(argv[i + 1]);
      i += 1;
    } else if (arg === "--snapshot") {
      flags.snapshot = String(argv[i + 1] || "").trim();
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { command, flags };
}

async function updateDenominators(opts) {
  const force = !!opts.force;
  const targetYear = opts.targetYear ? Number(opts.targetYear) : null;
  const month = getMonthInTimezone(new Date(), CONFIG.TIMEZONE);
  const indexPath = path.join(CONFIG.OUTPUT_DIR, CONFIG.DENOMS_INDEX_FILE);

  const index = (await readJson(indexPath)) || emptyDenomsIndex();
  const shouldSkipMonth =
    !force &&
    !targetYear &&
    CONFIG.DENOM_CHECK_MONTHS.indexOf(month) === -1;

  if (shouldSkipMonth) {
    log(`Skip denoms: month=${month}. Runs only in ${CONFIG.DENOM_CHECK_MONTHS.join(", ")}.`);
    if (!(await fileExists(indexPath))) {
      index.updated_at = new Date().toISOString();
      await writeJson(indexPath, index);
    }
    return { status: "skipped", reason: "non_denom_month" };
  }

  const discovered = await discoverSingStatResidentCsvLinks();
  const discoveredYears = Object.keys(discovered)
    .map(Number)
    .sort((a, b) => a - b);
  const existing = new Set((index.vintages || []).map(Number));

  let yearsToProcess = [];
  if (targetYear) {
    if (!discovered[targetYear]) {
      throw new Error(`Could not find SingStat CSV link for target year ${targetYear}.`);
    }
    yearsToProcess = [targetYear];
  } else {
    yearsToProcess = discoveredYears.filter((year) => !existing.has(year));
  }

  if (yearsToProcess.length === 0) {
    log("No new denom vintages found.");
    index.updated_at = new Date().toISOString();
    await writeJson(indexPath, index);
    return { status: "skipped", reason: "no_new_vintages" };
  }

  log(`Processing denominator vintages: ${yearsToProcess.join(", ")}`);

  let lastProcessedYear = null;

  for (const year of yearsToProcess) {
    const meta = discovered[year];
    const { csvText, files, picked } = await fetchResidentCsvFromZip(meta.url, year);
    log(`Year ${year}: ZIP files=${files.length}, picked=${picked}`);

    if (CONFIG.ARCHIVE_RAW_CSV) {
      const rawPath = path.join(CONFIG.RAW_DIR, `${CONFIG.RAW_PREFIX}${year}.csv`);
      await writeText(rawPath, csvText);
    }

    const rows = parseResidentCsv(csvText, year);
    const denoms = buildDenoms(rows, year);

    await writeJson(path.join(CONFIG.OUTPUT_DIR, `${CONFIG.DENOMS_SZ_PREFIX}${year}.json`), denoms.sz);
    await writeJson(path.join(CONFIG.OUTPUT_DIR, `${CONFIG.DENOMS_PA_PREFIX}${year}.json`), denoms.pa);

    existing.add(year);
    lastProcessedYear = year;
  }

  index.vintages = Array.from(existing).sort((a, b) => a - b);
  index.updated_at = new Date().toISOString();
  index.source = CONFIG.SINGSTAT_LATEST_DATA_URL;
  index.age_groups = CONFIG.AGE_GROUPS.slice();
  index.geos = ["pa", "sz"];

  await writeJson(indexPath, index);

  if (lastProcessedYear !== null) {
    await runDenomTests(lastProcessedYear);
  }

  return { status: "updated", years: yearsToProcess };
}

async function discoverSingStatResidentCsvLinks() {
  const response = await fetch(CONFIG.SINGSTAT_LATEST_DATA_URL, {
    headers: {
      "user-agent": "amenities-dashboard-pipeline/1.0",
      accept: "text/html,*/*",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch SingStat latest data page: HTTP ${response.status}`);
  }

  const html = await response.text();
  const regex = /href="([^"]*respopagesex(\d{4})\.ashx)"/gi;
  const out = {};
  let match = null;

  while ((match = regex.exec(html)) !== null) {
    const url = absolutizeUrl(match[1], CONFIG.SINGSTAT_LATEST_DATA_URL);
    const year = Number(match[2]);
    if (year >= 2000 && year <= 2100) {
      out[year] = { url, label: `respopagesex${year}.ashx` };
    }
  }

  if (Object.keys(out).length === 0) {
    throw new Error("No respopagesexYYYY.ashx links found on SingStat page.");
  }

  log(`Discovered denominator years: ${Object.keys(out).sort().join(", ")}`);
  return out;
}

function absolutizeUrl(maybeRelative, baseUrl) {
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
  return new URL(maybeRelative, baseUrl).toString();
}

async function fetchResidentCsvFromZip(url, year) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "amenities-dashboard-pipeline/1.0",
      accept: "*/*",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch zip for year=${year}. HTTP ${response.status}. URL=${url}`);
  }

  const zipBuffer = Buffer.from(await response.arrayBuffer());
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
  const names = entries.map((entry) => entry.entryName);
  const target = `respopagesex${year}.csv`;

  const baseName = (entryName) => String(entryName).split("/").pop().toLowerCase();
  let picked = entries.find((entry) => {
    const bn = baseName(entry.entryName);
    return bn === target && !bn.startsWith("notes_");
  });

  if (!picked) {
    const re = new RegExp(`respopagesex${year}.*\\.csv$`, "i");
    picked = entries.find((entry) => {
      const bn = String(entry.entryName).split("/").pop();
      return re.test(bn) && !/^notes_/i.test(bn);
    });
  }

  if (!picked) {
    picked = entries.find((entry) => {
      const bn = String(entry.entryName).split("/").pop();
      return /^respopagesex.*\.csv$/i.test(bn) && !/^notes_/i.test(bn);
    });
  }

  if (!picked) {
    throw new Error(
      `Could not find respopagesex CSV in ZIP for year=${year}. Files: ${names.join(", ")}`
    );
  }

  const csvText = picked.getData().toString("utf8").replace(/^\uFEFF/, "");
  return { csvText, files: names, picked: picked.entryName };
}

function parseResidentCsv(csvText, defaultYear) {
  const rows = parseCsv(csvText, {
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });

  if (!rows || rows.length < 2) {
    throw new Error("Resident CSV appears empty.");
  }

  const header = rows[0].map((h) => normalizeHeader(h));
  const col = {
    pa: findCol(header, ["PA", "PLANNINGAREA"]),
    sz: findCol(header, ["SZ", "SUBZONE"]),
    age: findCol(header, ["AGE", "SINGLEYEAROFAGE"]),
    sex: findCol(header, ["SEX", "GENDER"]),
    pop: findCol(header, ["POP", "POPULATION"]),
    time: findCol(header, ["TIME", "YEAR"]),
  };

  if (col.pa < 0 || col.sz < 0 || col.age < 0 || col.sex < 0 || col.pop < 0) {
    throw new Error("Resident CSV header missing required columns (PA,SZ,Age,Sex,Pop[,Time]).");
  }

  const out = [];
  let dropped = 0;

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    const pa = normalizeName(row[col.pa]);
    const sz = normalizeName(row[col.sz]);
    const sex = safeStr(row[col.sex]).toUpperCase().trim();
    const ageRaw = safeStr(row[col.age]).trim();
    const pop = toInt(row[col.pop]);
    const year = col.time >= 0 ? toInt(row[col.time]) : defaultYear;

    if (!pa || !sz || !year || pop === null || pop < 0) {
      dropped += 1;
      continue;
    }

    const ageInt = parseAgeInt(ageRaw);
    out.push({ year, pa, sz, sex, ageRaw, ageInt, pop });
  }

  log(`Resident CSV parsed: rows=${out.length}, dropped=${dropped}`);
  return out;
}

function buildDenoms(rows, year) {
  const paMap = new Map();
  const szMap = new Map();

  for (const row of rows) {
    if (row.year !== year) continue;
    const group = ageGroup(row.ageInt);

    addToMap(paMap, `${row.pa}||${group}`, row.pop);
    addToMap(paMap, `${row.pa}||ALL`, row.pop);

    addToMap(szMap, `${row.pa}||${row.sz}||${group}`, row.pop);
    addToMap(szMap, `${row.pa}||${row.sz}||ALL`, row.pop);
  }

  const paRows = [];
  for (const [key, value] of paMap.entries()) {
    const [pa, age_group] = key.split("||");
    paRows.push({ year, pa, age_group, residents: value });
  }

  const szRows = [];
  for (const [key, value] of szMap.entries()) {
    const [pa, sz, age_group] = key.split("||");
    szRows.push({ year, pa, sz, age_group, residents: value });
  }

  return {
    pa: completePaGroups(paRows, year),
    sz: completeSzGroups(szRows, year),
  };
}

function completePaGroups(rows, year) {
  const byPa = new Map();
  for (const row of rows) {
    if (!byPa.has(row.pa)) byPa.set(row.pa, new Map());
    byPa.get(row.pa).set(row.age_group, Number(row.residents || 0));
  }

  const out = [];
  for (const [pa, groups] of byPa.entries()) {
    for (const ageGroupName of CONFIG.AGE_GROUPS) {
      out.push({
        year,
        pa,
        age_group: ageGroupName,
        residents: groups.get(ageGroupName) || 0,
      });
    }
  }

  out.sort((a, b) => {
    if (a.pa !== b.pa) return a.pa.localeCompare(b.pa);
    return a.age_group.localeCompare(b.age_group);
  });
  return out;
}

function completeSzGroups(rows, year) {
  const bySz = new Map();
  for (const row of rows) {
    const key = `${row.pa}||${row.sz}`;
    if (!bySz.has(key)) bySz.set(key, new Map());
    bySz.get(key).set(row.age_group, Number(row.residents || 0));
  }

  const out = [];
  for (const [key, groups] of bySz.entries()) {
    const [pa, sz] = key.split("||");
    for (const ageGroupName of CONFIG.AGE_GROUPS) {
      out.push({
        year,
        pa,
        sz,
        age_group: ageGroupName,
        residents: groups.get(ageGroupName) || 0,
      });
    }
  }

  out.sort((a, b) => {
    if (a.pa !== b.pa) return a.pa.localeCompare(b.pa);
    if (a.sz !== b.sz) return a.sz.localeCompare(b.sz);
    return a.age_group.localeCompare(b.age_group);
  });
  return out;
}

async function buildAmenitiesIfDue(opts) {
  const force = !!opts.force;
  const forceOverwrite = !!opts.forceOverwrite;
  const targetSnapshot = opts.targetSnapshot || null;
  const month = getMonthInTimezone(new Date(), CONFIG.TIMEZONE);
  const indexPath = path.join(CONFIG.OUTPUT_DIR, CONFIG.AMENITIES_INDEX_FILE);
  const index = (await readJson(indexPath)) || emptyAmenitiesIndex();

  const shouldSkipMonth =
    !force &&
    !targetSnapshot &&
    CONFIG.AMENITY_CHECK_MONTHS.indexOf(month) === -1;

  if (shouldSkipMonth) {
    log(`Skip amenities: month=${month}. Runs only in ${CONFIG.AMENITY_CHECK_MONTHS.join(", ")}.`);
    if (!(await fileExists(indexPath))) {
      index.updated_at = new Date().toISOString();
      await writeJson(indexPath, index);
    }
    return { status: "skipped", reason: "non_amenity_month" };
  }

  const snapshot = targetSnapshot || getCurrentSnapshotQuarter(new Date());
  if (!isValidSnapshot(snapshot)) {
    throw new Error(`Invalid snapshot format: ${snapshot}. Expected YYYYQn.`);
  }

  if (!forceOverwrite && (index.snapshots || []).includes(snapshot)) {
    log(`Skip amenities: snapshot ${snapshot} already exists.`);
    return { status: "skipped", reason: "snapshot_exists", snapshot };
  }

  await buildAmenitySnapshot(snapshot, { writeDebug: !!CONFIG.WRITE_AMENITY_DEBUG });
  await runAmenityTests(snapshot);
  return { status: "updated", snapshot };
}

function getCurrentSnapshotQuarter(date) {
  const year = getYearInTimezone(date, CONFIG.TIMEZONE);
  const month = getMonthInTimezone(date, CONFIG.TIMEZONE);
  const q = Math.floor((month - 1) / 3) + 1;
  return `${year}Q${q}`;
}

async function buildAmenitySnapshot(snapshotQuarter, opts) {
  const options = opts || {};
  const subzoneGeo = await readJson(CONFIG.SUBZONE_GEOJSON_PATH);
  if (!subzoneGeo) {
    throw new Error(`Missing subzone GeoJSON at ${CONFIG.SUBZONE_GEOJSON_PATH}`);
  }

  const polygons = normalizeSubzonePolygons(subzoneGeo);
  log(`Loaded subzone polygons: ${polygons.length}`);

  const categories = Object.entries(CONFIG.AMENITY_CATEGORIES || {});
  const needsSchools = categories.some(([, meta]) => meta && meta.source === "MOE_ONEMAP");

  let schoolByCategory = null;
  if (needsSchools) {
    const schoolPoints = await buildSchoolPointsFromMoe();
    schoolByCategory = {
      primary_schools: schoolPoints.primary_schools || [],
      secondary_schools: schoolPoints.secondary_schools || [],
    };
    log(
      `MOE schools points: primary=${schoolByCategory.primary_schools.length}, secondary=${schoolByCategory.secondary_schools.length}`
    );
  }

  const szCount = new Map();
  const paCount = new Map();
  const stats = { total: {}, assigned: {}, unassigned: {} };
  const sampleAssigned = {};

  for (const [category, meta] of categories) {
    const source = meta?.source || "OSM";
    let points = [];

    if (source === "OSM") {
      points = await fetchAmenityPointsFromOverpass(category);
    } else if (source === "MOE_ONEMAP") {
      if (!schoolByCategory) {
        throw new Error(`School data unavailable for ${category}.`);
      }
      points = schoolByCategory[category] || [];
    } else {
      throw new Error(`Unknown amenity source "${source}" for category "${category}".`);
    }

    stats.total[category] = points.length;
    sampleAssigned[category] = [];

    let assigned = 0;
    let unassigned = 0;

    for (const point of points) {
      const lon = Number(point.lon);
      const lat = Number(point.lat);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        unassigned += 1;
        continue;
      }

      const match = findContainingSubzone(lon, lat, polygons);
      if (!match || !match.sz) {
        unassigned += 1;
        continue;
      }

      assigned += 1;

      const pa = normalizeName(match.pa || "UNKNOWN");
      const sz = normalizeName(match.sz);

      addToMap(szCount, `${pa}||${sz}||${category}`, 1);
      addToMap(paCount, `${pa}||${category}`, 1);

      if (options.writeDebug && sampleAssigned[category].length < 50) {
        sampleAssigned[category].push({
          category,
          source,
          lon,
          lat,
          pa,
          sz,
          osm_type: point.osm_type || null,
          osm_id: point.osm_id || null,
          id: point.id || null,
          name: point.name || null,
        });
      }
    }

    stats.assigned[category] = assigned;
    stats.unassigned[category] = unassigned;
    log(`${category} (${source}): total=${points.length}, assigned=${assigned}, unassigned=${unassigned}`);
  }

  const szOut = [];
  for (const [key, count] of szCount.entries()) {
    const [pa, sz, category] = key.split("||");
    szOut.push({ snapshot: snapshotQuarter, pa, sz, category, count });
  }
  szOut.sort((a, b) => {
    if (a.pa !== b.pa) return a.pa.localeCompare(b.pa);
    if (a.sz !== b.sz) return a.sz.localeCompare(b.sz);
    return a.category.localeCompare(b.category);
  });

  const paOut = [];
  for (const [key, count] of paCount.entries()) {
    const [pa, category] = key.split("||");
    paOut.push({ snapshot: snapshotQuarter, pa, category, count });
  }
  paOut.sort((a, b) => {
    if (a.pa !== b.pa) return a.pa.localeCompare(b.pa);
    return a.category.localeCompare(b.category);
  });

  await writeJson(
    path.join(CONFIG.OUTPUT_DIR, `${CONFIG.AMENITIES_SZ_PREFIX}${snapshotQuarter}.json`),
    szOut
  );
  await writeJson(
    path.join(CONFIG.OUTPUT_DIR, `${CONFIG.AMENITIES_PA_PREFIX}${snapshotQuarter}.json`),
    paOut
  );

  const indexPath = path.join(CONFIG.OUTPUT_DIR, CONFIG.AMENITIES_INDEX_FILE);
  const index = (await readJson(indexPath)) || emptyAmenitiesIndex();
  const snapshots = new Set(index.snapshots || []);
  snapshots.add(snapshotQuarter);

  index.snapshots = Array.from(snapshots).sort(compareSnapshotQuarter);
  index.updated_at = new Date().toISOString();
  index.source = "overpass+moe_onemap";
  index.categories = Object.keys(CONFIG.AMENITY_CATEGORIES || {});
  index.geos = ["pa", "sz"];

  await writeJson(indexPath, index);

  if (options.writeDebug) {
    const debug = {
      snapshot: snapshotQuarter,
      stats,
      sample_assigned_points: sampleAssigned,
    };
    await writeJson(
      path.join(CONFIG.OUTPUT_DIR, `${CONFIG.AMENITIES_DEBUG_PREFIX}${snapshotQuarter}.json`),
      debug
    );
  }

  log(`Amenity snapshot written: ${snapshotQuarter}`);
}

async function fetchAmenityPointsFromOverpass(categoryKey) {
  const query = buildOverpassQL(categoryKey, CONFIG.OVERPASS_TIMEOUT_SEC);
  let lastError = null;

  for (const endpoint of CONFIG.OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= CONFIG.OVERPASS_RETRY_MAX; attempt += 1) {
      try {
        const body = new URLSearchParams({ data: query }).toString();
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            "user-agent": "amenities-dashboard-pipeline/1.0",
            accept: "application/json,text/plain,*/*",
          },
          body,
        });

        const text = await response.text();
        if (response.ok) {
          return overpassElementsToPoints(JSON.parse(text));
        }

        if ([429, 502, 503, 504].includes(response.status)) {
          const sleepMs =
            CONFIG.OVERPASS_RETRY_BASE_SLEEP_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
          log(
            `Overpass HTTP ${response.status} (${categoryKey}) attempt ${attempt}/${CONFIG.OVERPASS_RETRY_MAX}. Sleep ${sleepMs}ms`
          );
          await sleep(sleepMs);
          continue;
        }

        throw new Error(
          `Overpass HTTP ${response.status} for ${categoryKey} @ ${endpoint}: ${text.slice(0, 240)}`
        );
      } catch (error) {
        lastError = error;
        const sleepMs =
          CONFIG.OVERPASS_RETRY_BASE_SLEEP_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
        log(
          `Overpass error (${categoryKey}) attempt ${attempt}/${CONFIG.OVERPASS_RETRY_MAX}: ${error.message}. Sleep ${sleepMs}ms`
        );
        await sleep(sleepMs);
      }
    }
    log(`Switching Overpass endpoint after failures: ${endpoint}`);
  }

  throw lastError || new Error(`Overpass failed for category ${categoryKey}.`);
}

function buildOverpassQL(categoryKey, timeoutSec) {
  const header = `[out:json][timeout:${timeoutSec}];area["ISO3166-1"="SG"]->.sg;(`;
  const footer = ");out center;";
  const parts = [];

  if (categoryKey === "gp_clinics") {
    parts.push('node["amenity"="doctors"](area.sg);way["amenity"="doctors"](area.sg);relation["amenity"="doctors"](area.sg);');
    parts.push('node["amenity"="clinic"](area.sg);way["amenity"="clinic"](area.sg);relation["amenity"="clinic"](area.sg);');
    parts.push('node["healthcare"="doctor"](area.sg);way["healthcare"="doctor"](area.sg);relation["healthcare"="doctor"](area.sg);');
    parts.push('node["healthcare"="clinic"](area.sg);way["healthcare"="clinic"](area.sg);relation["healthcare"="clinic"](area.sg);');
  } else if (categoryKey === "dental") {
    parts.push('node["amenity"="dentist"](area.sg);way["amenity"="dentist"](area.sg);relation["amenity"="dentist"](area.sg);');
    parts.push('node["healthcare"="dentist"](area.sg);way["healthcare"="dentist"](area.sg);relation["healthcare"="dentist"](area.sg);');
  } else if (categoryKey === "childcare_preschool") {
    parts.push('node["amenity"="childcare"](area.sg);way["amenity"="childcare"](area.sg);relation["amenity"="childcare"](area.sg);');
    parts.push('node["amenity"="kindergarten"](area.sg);way["amenity"="kindergarten"](area.sg);relation["amenity"="kindergarten"](area.sg);');
    parts.push('node["childcare"="yes"](area.sg);way["childcare"="yes"](area.sg);relation["childcare"="yes"](area.sg);');
  } else if (categoryKey === "supermarkets") {
    parts.push('node["shop"="supermarket"](area.sg);way["shop"="supermarket"](area.sg);relation["shop"="supermarket"](area.sg);');
  } else if (categoryKey === "eldercare") {
    const sf =
      '["amenity"="social_facility"]["social_facility"~"nursing_home|assisted_living|group_home|day_care|retirement_home",i]';
    parts.push(`node${sf}(area.sg);way${sf}(area.sg);relation${sf}(area.sg);`);
    parts.push('node["healthcare"="nursing_home"](area.sg);way["healthcare"="nursing_home"](area.sg);relation["healthcare"="nursing_home"](area.sg);');
  } else {
    throw new Error(`Unknown OSM category: ${categoryKey}`);
  }

  return header + parts.join("") + footer;
}

function overpassElementsToPoints(json) {
  const elements = (json && json.elements) || [];
  const out = [];
  const seen = new Set();

  for (const element of elements) {
    const key = `${element.type}/${element.id}`;
    if (seen.has(key)) continue;

    let lon = null;
    let lat = null;
    if (element.type === "node") {
      lon = element.lon;
      lat = element.lat;
    } else if (element.center) {
      lon = element.center.lon;
      lat = element.center.lat;
    }

    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    seen.add(key);
    out.push({ osm_type: element.type, osm_id: element.id, lon, lat });
  }

  return out;
}

async function fetchAllMoeSchoolGeneralInfo() {
  const limit = 500;
  let offset = 0;
  const out = [];

  while (true) {
    const url = new URL(CONFIG.DATAGOV_DATASTORE_SEARCH);
    url.searchParams.set("resource_id", CONFIG.MOE_GENERAL_INFO_DATASET_ID);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`data.gov.sg API failed: HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (!payload.success) {
      throw new Error(`data.gov.sg API returned unsuccessful payload: ${JSON.stringify(payload).slice(0, 240)}`);
    }

    const records = payload?.result?.records || [];
    out.push(...records);
    if (records.length < limit) break;
    offset += limit;
  }

  return out;
}

async function buildSchoolPointsFromMoe() {
  const rows = await fetchAllMoeSchoolGeneralInfo();
  const geocodeCache = (await readJson(CONFIG.ONEMAP_GEOCODE_CACHE_FILE)) || {};
  let cacheChanged = false;
  let geocodeEligible = 0;
  let geocodeResolved = 0;
  let geocodeUnresolved = 0;

  const primary = [];
  const secondary = [];
  const seenPrimary = new Set();
  const seenSecondary = new Set();

  for (const row of rows) {
    const name = safeStr(row.school_name || row["School Name"]).trim();
    const address = safeStr(row.address || row["Address"]).trim();
    const postal = safeStr(row.postal_code || row["Postal Code"]).trim();
    const mainLevel = safeStr(row.mainlevel_code || row["Mainlevel Code"]).toUpperCase();

    const isPrimary = mainLevel.includes("PRIMARY");
    const isSecondary = mainLevel.includes("SECONDARY");
    if (!isPrimary && !isSecondary) continue;

    const searchVal = postal || (address ? `${address} SINGAPORE` : name);
    if (!searchVal) continue;
    geocodeEligible += 1;

    const cacheKey = normalizeName(searchVal);
    let geocode = geocodeCache[cacheKey] || null;
    if (!geocode) {
      geocode = await geocodeOneMap(searchVal);
      geocodeCache[cacheKey] = geocode || null;
      cacheChanged = true;
      await sleep(140);
    }
    if (!geocode) {
      geocodeUnresolved += 1;
      continue;
    }
    geocodeResolved += 1;

    const baseMeta = {
      postal: postal || null,
      mainlevel_code: mainLevel || null,
      zone_code: row.zone_code || null,
      type_code: row.type_code || null,
      nature_code: row.nature_code || null,
      session_code: row.session_code || null,
    };

    if (isPrimary) {
      const id = `MOE:PRIMARY:${name}:${postal || address}`;
      if (!seenPrimary.has(id)) {
        seenPrimary.add(id);
        primary.push({
          id: id.slice(0, 220),
          category: "primary_schools",
          name,
          source: "MOE+OneMap",
          lat: geocode.lat,
          lon: geocode.lon,
          meta: baseMeta,
        });
      }
    }

    if (isSecondary) {
      const id = `MOE:SECONDARY:${name}:${postal || address}`;
      if (!seenSecondary.has(id)) {
        seenSecondary.add(id);
        secondary.push({
          id: id.slice(0, 220),
          category: "secondary_schools",
          name,
          source: "MOE+OneMap",
          lat: geocode.lat,
          lon: geocode.lon,
          meta: baseMeta,
        });
      }
    }
  }

  primary.sort((a, b) => a.name.localeCompare(b.name));
  secondary.sort((a, b) => a.name.localeCompare(b.name));

  if (cacheChanged) {
    await writeJson(CONFIG.ONEMAP_GEOCODE_CACHE_FILE, geocodeCache);
  }

  const geocodeRate = geocodeEligible > 0 ? geocodeResolved / geocodeEligible : 1;
  log(
    `OneMap geocode stats: eligible=${geocodeEligible}, resolved=${geocodeResolved}, unresolved=${geocodeUnresolved}, rate=${geocodeRate.toFixed(4)}`
  );

  return { primary_schools: primary, secondary_schools: secondary };
}

async function geocodeOneMap(searchVal) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const token = await getOneMapToken();
    const url = new URL(CONFIG.ONEMAP_SEARCH_URL);
    url.searchParams.set("searchVal", searchVal);
    url.searchParams.set("returnGeom", "Y");
    url.searchParams.set("getAddrDetails", "Y");
    url.searchParams.set("pageNum", "1");

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 401) {
      runtimeToken = null;
      runtimeTokenExpMs = 0;
      await clearOneMapTokenFile();
      continue;
    }

    if (!response.ok) {
      if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 3) {
        await sleep(700 * attempt);
        continue;
      }
      throw new Error(`OneMap geocode failed for "${searchVal}". HTTP ${response.status}`);
    }

    const payload = await response.json();
    const results = payload.results || [];
    if (!results.length) return null;

    const first = results[0];
    const lat = Number(first.LATITUDE || first.lat);
    const lon = Number(first.LONGITUDE || first.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  }

  throw new Error(`OneMap geocode auth failed repeatedly for "${searchVal}".`);
}

async function getOneMapToken() {
  const now = Date.now();
  if (runtimeToken && runtimeTokenExpMs && now < runtimeTokenExpMs - 10 * 60 * 1000) {
    return runtimeToken;
  }

  const envToken = safeStr(process.env.ONEMAP_TOKEN).trim();
  const envExpMs = Number(process.env.ONEMAP_TOKEN_EXP_MS || "0");
  if (envToken && envExpMs && now < envExpMs - 10 * 60 * 1000) {
    runtimeToken = envToken;
    runtimeTokenExpMs = envExpMs;
    return runtimeToken;
  }

  const fileToken = await readJson(CONFIG.ONEMAP_TOKEN_CACHE_FILE);
  if (fileToken?.token && fileToken?.expMs && now < Number(fileToken.expMs) - 10 * 60 * 1000) {
    runtimeToken = String(fileToken.token);
    runtimeTokenExpMs = Number(fileToken.expMs);
    return runtimeToken;
  }

  const email = safeStr(process.env.ONEMAP_EMAIL).trim();
  const password = safeStr(process.env.ONEMAP_PASSWORD).trim();
  if (!email || !password) {
    throw new Error(
      "Missing OneMap credentials. Set ONEMAP_EMAIL and ONEMAP_PASSWORD (or provide ONEMAP_TOKEN with ONEMAP_TOKEN_EXP_MS)."
    );
  }

  const response = await fetch(CONFIG.ONEMAP_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OneMap auth failed: HTTP ${response.status} ${text.slice(0, 240)}`);
  }

  const payload = JSON.parse(text);
  const token = payload.access_token || payload.token;
  if (!token) {
    throw new Error(`OneMap auth response missing token: ${text.slice(0, 240)}`);
  }

  const expiresInSec = Number(payload.expires_in || 72 * 3600);
  runtimeToken = token;
  runtimeTokenExpMs = now + expiresInSec * 1000;

  await writeJson(CONFIG.ONEMAP_TOKEN_CACHE_FILE, { token: runtimeToken, expMs: runtimeTokenExpMs });
  return runtimeToken;
}

async function clearOneMapTokenFile() {
  try {
    await fs.unlink(CONFIG.ONEMAP_TOKEN_CACHE_FILE);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function normalizeSubzonePolygons(geojson) {
  const features = geojson?.features || [];
  const out = [];

  for (const feature of features) {
    const properties = feature.properties || {};
    const geometry = feature.geometry || {};
    const type = geometry.type;
    const coordinates = geometry.coordinates;

    const sz = pickProp(properties, ["SUBZONE_N", "SUBZONE_NAME", "SZ", "name", "NAME"]);
    const pa = pickProp(properties, [
      "PLN_AREA_N",
      "PLN_AREA_NAME",
      "PA",
      "planning_area",
      "name_1",
      "REGION_N",
    ]);
    if (!sz) continue;

    const szName = normalizeName(sz);
    const paName = pa ? normalizeName(pa) : null;

    if (type === "Polygon") {
      out.push(buildPolygonRecord(paName, szName, [coordinates]));
    } else if (type === "MultiPolygon") {
      out.push(buildPolygonRecord(paName, szName, coordinates));
    }
  }

  return out;
}

function buildPolygonRecord(paName, szName, multiPolyCoords) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  for (const polygon of multiPolyCoords) {
    for (const ring of polygon) {
      for (const point of ring) {
        const lon = Number(point[0]);
        const lat = Number(point[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        minLon = Math.min(minLon, lon);
        minLat = Math.min(minLat, lat);
        maxLon = Math.max(maxLon, lon);
        maxLat = Math.max(maxLat, lat);
      }
    }
  }

  return {
    pa_name: paName,
    sz_name: szName,
    bbox: [minLon, minLat, maxLon, maxLat],
    multipoly: multiPolyCoords,
  };
}

function findContainingSubzone(lon, lat, polygons) {
  for (const polygon of polygons) {
    if (!bboxContains(polygon.bbox, lon, lat)) continue;
    if (pointInMultiPolygon(lon, lat, polygon.multipoly)) {
      return { pa: polygon.pa_name, sz: polygon.sz_name };
    }
  }
  return null;
}

function bboxContains(bbox, lon, lat) {
  return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

function pointInMultiPolygon(lon, lat, multipoly) {
  for (const polygonRings of multipoly) {
    if (pointInPolygonRings(lon, lat, polygonRings)) return true;
  }
  return false;
}

function pointInPolygonRings(lon, lat, rings) {
  if (!rings || rings.length === 0) return false;
  if (!pointInRing(lon, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i += 1) {
    if (pointInRing(lon, lat, rings[i])) return false;
  }
  return true;
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];

    const intersects =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-15) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

async function runDenomTests(year) {
  const pa = await readJson(path.join(CONFIG.OUTPUT_DIR, `${CONFIG.DENOMS_PA_PREFIX}${year}.json`));
  const sz = await readJson(path.join(CONFIG.OUTPUT_DIR, `${CONFIG.DENOMS_SZ_PREFIX}${year}.json`));
  if (!pa || !sz) throw new Error(`Missing denominator outputs for year=${year}`);

  const totalAll = pa
    .filter((row) => row.age_group === "ALL")
    .reduce((sum, row) => sum + Number(row.residents || 0), 0);
  if (totalAll <= 3000000) {
    throw new Error(`Denominator sanity check failed: totalAll=${totalAll} <= 3,000,000`);
  }

  const bands = CONFIG.AGE_GROUPS.filter((group) => group !== "ALL");
  const byPa = new Map();
  for (const row of pa) {
    if (!byPa.has(row.pa)) byPa.set(row.pa, {});
    byPa.get(row.pa)[row.age_group] = Number(row.residents || 0);
  }

  let violations = 0;
  for (const [, groups] of byPa.entries()) {
    const all = groups.ALL || 0;
    const sumBands = bands.reduce((acc, group) => acc + (groups[group] || 0), 0);
    if (all < sumBands) violations += 1;
  }

  log(`Denominator tests passed for ${year}. ALL>=sumBands violations=${violations}`);
}

async function runAmenityTests(snapshotQuarter) {
  const index = await readJson(path.join(CONFIG.OUTPUT_DIR, CONFIG.AMENITIES_INDEX_FILE));
  const sz = await readJson(
    path.join(CONFIG.OUTPUT_DIR, `${CONFIG.AMENITIES_SZ_PREFIX}${snapshotQuarter}.json`)
  );
  const pa = await readJson(
    path.join(CONFIG.OUTPUT_DIR, `${CONFIG.AMENITIES_PA_PREFIX}${snapshotQuarter}.json`)
  );

  if (!index || !sz || !pa) {
    throw new Error(`Amenity test failed. Missing snapshot outputs for ${snapshotQuarter}.`);
  }

  const totalSupermarkets = sz
    .filter((row) => row.category === "supermarkets")
    .reduce((sum, row) => sum + Number(row.count || 0), 0);
  if (totalSupermarkets > 5000) {
    throw new Error(
      `Amenity sanity check failed: supermarkets total ${totalSupermarkets} > 5000 for ${snapshotQuarter}`
    );
  }

  log(`Amenity tests passed for ${snapshotQuarter}. supermarkets=${totalSupermarkets}`);
}

function emptyDenomsIndex() {
  return {
    updated_at: null,
    source: CONFIG.SINGSTAT_LATEST_DATA_URL,
    vintages: [],
    age_groups: CONFIG.AGE_GROUPS.slice(),
    geos: ["pa", "sz"],
  };
}

function emptyAmenitiesIndex() {
  return {
    updated_at: null,
    source: "overpass+moe_onemap",
    snapshots: [],
    categories: Object.keys(CONFIG.AMENITY_CATEGORIES || {}),
    geos: ["pa", "sz"],
  };
}

function compareSnapshotQuarter(a, b) {
  const ay = Number(String(a).slice(0, 4));
  const by = Number(String(b).slice(0, 4));
  const aq = Number(String(a).slice(5));
  const bq = Number(String(b).slice(5));
  if (ay !== by) return ay - by;
  return aq - bq;
}

function isValidSnapshot(value) {
  return /^\d{4}Q[1-4]$/.test(String(value || ""));
}

async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(filePath, obj) {
  await ensureDir(path.dirname(filePath));
  const text = `${JSON.stringify(obj, null, 2)}\n`;
  await fs.writeFile(filePath, text, "utf8");
}

async function writeText(filePath, text) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, text, "utf8");
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function getMonthInTimezone(date, timeZone) {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "numeric",
    }).format(date)
  );
}

function getYearInTimezone(date, timeZone) {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
    }).format(date)
  );
}

function normalizeHeader(value) {
  return safeStr(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function findCol(headerNorm, candidates) {
  for (const candidate of candidates) {
    const idx = headerNorm.indexOf(candidate);
    if (idx >= 0) return idx;
  }

  for (let i = 0; i < headerNorm.length; i += 1) {
    const header = headerNorm[i];
    for (const candidate of candidates) {
      if (header.includes(candidate)) return i;
    }
  }

  return -1;
}

function parseAgeInt(ageRaw) {
  const value = safeStr(ageRaw).trim();
  if (/^\d+$/.test(value)) return Number(value);
  return null;
}

function ageGroup(ageInt) {
  if (ageInt === null || ageInt === undefined) return "SENIOR_65_PLUS";
  if (ageInt >= 0 && ageInt <= 6) return "CHILD_0_6";
  if (ageInt >= 7 && ageInt <= 12) return "CHILD_7_12";
  if (ageInt >= 13 && ageInt <= 18) return "TEEN_13_18";
  if (ageInt >= 19 && ageInt <= 34) return "YOUNG_ADULT_19_34";
  if (ageInt >= 35 && ageInt <= 54) return "ADULT_35_54";
  if (ageInt >= 55 && ageInt <= 64) return "YOUNG_SENIOR_55_64";
  if (ageInt >= 65) return "SENIOR_65_PLUS";
  return "SENIOR_65_PLUS";
}

function safeStr(value) {
  return value === null || value === undefined ? "" : String(value);
}

function toInt(value) {
  const cleaned = safeStr(value).replace(/,/g, "").trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function normalizeName(value) {
  let name = safeStr(value).toUpperCase().trim();
  name = name.replace(/\s+/g, " ");
  name = name.replace(/&/g, "AND");
  name = name.replace(/[’']/g, "");
  name = name.replace(/\s*-\s*/g, "-");
  if (CONFIG.NAME_OVERRIDES[name]) return CONFIG.NAME_OVERRIDES[name];
  return name;
}

function pickProp(props, keys) {
  for (const key of keys) {
    const value = props[key];
    if (value !== null && value !== undefined && String(value).trim() !== "") {
      return value;
    }
  }
  return null;
}

function addToMap(map, key, value) {
  map.set(key, (map.get(key) || 0) + value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message) {
  // Keep logs compact for GitHub Actions and local runs.
  // eslint-disable-next-line no-console
  console.log(`[pipeline] ${message}`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`[pipeline] ERROR: ${error.stack || error.message || String(error)}`);
  process.exit(1);
});
