/**
 * Milestone 1: resident denominator builder (PA + SZ) and JSON endpoint.
 *
 * Input mode: Drive CSV file with headers PA,SZ,Age,Sex,Pop,Time
 */

const CONFIG = {
  OUTPUT_FOLDER_ID: 'REPLACE_WITH_DRIVE_FOLDER_ID',
  RESIDENT_SOURCE: {
    mode: 'drive_csv',
    csvFileId: 'REPLACE_WITH_RESIDENT_CSV_FILE_ID',
    label: 'Drive CSV: PA,SZ,Age,Sex,Pop,Time'
  }
};

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
