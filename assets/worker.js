/* Neo Climate Twin — seasonal similarity/search worker. No external dependencies. */
importScripts("regions.js");
let base = "../data/";
let cfg = null;
let names = null, codebooks = null;
let population = null, country = null, continent = null, admin1 = null, grid = null;
let metrics = null, features = null, positions = null;
let searchText = null, searchOffsets = null;
let lightPromise = null, metricsPromise = null, featuresPromise = null, positionsPromise = null, searchPromise = null;
let lastScores = null, lastIdx = -1, lastModel = null;
let continentIds = null;

const url = name => new URL(name, base).href;
async function fetchBuffer(name) {
  const r = await fetch(url(name));
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return r.arrayBuffer();
}
async function fetchText(name) {
  const r = await fetch(url(name));
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return r.text();
}
async function fetchGzipText(name) {
  const r = await fetch(url(name));
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  if (typeof DecompressionStream === "undefined") {
    throw new Error("Este navegador no soporta DecompressionStream (gzip). Usa una versión moderna de Chrome, Edge, Firefox o Safari.");
  }
  const stream = r.body.pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}
const norm = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
const subregionByIso = new Map((self.NEO_SUBREGIONS || []).flatMap(region => region.codes.map(code => [code, region.id])));

function continentForCity(idx) {
  const source = continent[idx];
  if (!positions || !codebooks || !continentIds) return source;
  const iso = codebooks.country_iso2[country[idx]], lon = positions[idx * 2], lat = positions[idx * 2 + 1];
  // Territorios de ultramar conservan la asignación de su país fuente. Solo se
  // subdividen estados cuya masa continental cruza un límite continental claro.
  if (iso === "RU") {
    // Aproximación de la divisoria Ural–Caspio: Siberia y Extremo Oriente son Asia.
    const europe = lat >= 60 ? lon < 60 : lat >= 50 ? lon < 57 : lat >= 45 ? lon < 50 : lon < 42;
    return europe ? continentIds.Europe : continentIds.Asia;
  }
  if (iso === "TR" && lon < 29.5 && lat > 40) return continentIds.Europe;
  if (iso === "KZ" && lon < 55 && lat > 46) return continentIds.Europe;
  return source;
}

function subregionForCity(idx) {
  const iso = codebooks?.country_iso2?.[country[idx]];
  if (iso === "RU" && continentForCity(idx) === continentIds?.Asia) return "asia-north";
  return subregionByIso.get(iso) || "";
}

async function init(dataBase) {
  base = dataBase;
  cfg = await fetch(url("config.json")).then(r => {
    if (!r.ok) throw new Error(`config.json: HTTP ${r.status}`);
    return r.json();
  });
  postMessage({type: "ready", cityCount: cfg.city_count});
}

async function light() {
  if (names) return;
  if (!lightPromise) lightPromise = (async () => {
    postMessage({type: "warmStatus", part: "metadata", state: "loading"});
    const f = cfg.files;
    const [namesText, books, pb, cb, kb, ab, gb] = await Promise.all([
      fetchText(f.names), fetch(url(f.codebooks)).then(r => r.json()),
      fetchBuffer(f.population), fetchBuffer(f.country), fetchBuffer(f.continent),
      fetchBuffer(f.admin1), fetchBuffer(f.grid)
    ]);
    names = namesText.trimEnd().split("\n");
    codebooks = books;
    continentIds = Object.fromEntries(codebooks.continents.map((label, id) => [label, id]));
    population = new Uint32Array(pb);
    country = new Uint16Array(cb);
    continent = new Uint8Array(kb);
    admin1 = new Uint32Array(ab);
    grid = new Uint32Array(gb);
    const n = cfg.city_count;
    if (names.length !== n || population.length !== n || country.length !== n || continent.length !== n || admin1.length !== n || grid.length !== n) {
      throw new Error("Metadatos desalineados con city_count");
    }
    postMessage({type: "warmStatus", part: "metadata", state: "ready"});
  })();
  return lightPromise;
}

async function loadMetrics() {
  if (metrics) return;
  if (!metricsPromise) metricsPromise = (async () => {
    const b = await fetchBuffer(cfg.files.metrics);
    metrics = new Float32Array(b);
    if (metrics.length !== cfg.city_count * 9) throw new Error("metrics9 desalineado");
  })();
  return metricsPromise;
}

async function loadFeatures() {
  if (features) return;
  if (!featuresPromise) featuresPromise = (async () => {
    postMessage({type: "warmStatus", part: "features", state: "loading"});
    const b = await fetchBuffer(cfg.files.features);
    features = new Int8Array(b);
    if (features.length !== cfg.city_count * cfg.feature_dim) throw new Error("Fingerprint desalineado");
    postMessage({type: "warmStatus", part: "features", state: "ready"});
  })();
  return featuresPromise;
}

async function loadPositions() {
  if (positions) return;
  if (!positionsPromise) positionsPromise = (async () => {
    const b = await fetchBuffer(cfg.files.positions);
    positions = new Float32Array(b);
    if (positions.length !== cfg.city_count * 2) throw new Error("Coordenadas desalineadas");
  })();
  return positionsPromise;
}

async function loadSearch() {
  if (searchText) return;
  if (!searchPromise) searchPromise = (async () => {
    postMessage({type: "warmStatus", part: "search", state: "loading"});
    searchText = await fetchGzipText(cfg.files.search);
    const offsets = new Uint32Array(cfg.city_count + 1);
    let line = 0;
    offsets[0] = 0;
    for (let i = 0; i < searchText.length && line < cfg.city_count; i++) {
      if (searchText.charCodeAt(i) === 10) offsets[++line] = i + 1;
    }
    if (line !== cfg.city_count) throw new Error(`Índice de búsqueda incompleto: ${line}/${cfg.city_count}`);
    searchOffsets = offsets;
    postMessage({type: "warmStatus", part: "search", state: "ready"});
  })();
  return searchPromise;
}

function detailLite(idx) {
  const c = country[idx], a = admin1[idx], ct = continentForCity(idx);
  return {
    idx,
    city_name: names[idx] || "",
    country_name: codebooks.countries[c] || "",
    country_iso2: codebooks.country_iso2[c] || "",
    admin1_name: codebooks.admin1[a] || "",
    continent: codebooks.continents[ct] || "",
    population: population[idx] || null
  };
}
async function detail(idx) {
  await Promise.all([light(), loadMetrics(), loadPositions()]);
  const row = detailLite(idx);
  const o = idx * 9;
  const n = j => Number.isFinite(metrics[o + j]) ? metrics[o + j] : null;
  return Object.assign(row, {
    avg_temp_c: n(0), min_week_temp_c: n(1), max_week_temp_c: n(2), annual_precip_mm_est: n(3),
    avg_humidity_pct: n(4), avg_wind_kmh: n(5), avg_cloud_pct: n(6),
    avg_sunshine_hours: n(7), avg_solar_kwh_m2_day: n(8)
  });
}

async function quickDetail(idx) {
  await Promise.all([light(), loadPositions()]);
  if (!Number.isInteger(idx) || idx < 0 || idx >= cfg.city_count) throw new Error("Índice de ciudad inválido.");
  return detailLite(idx);
}

async function quickDetails(indices) {
  await Promise.all([light(), loadPositions()]);
  const unique = [...new Set((indices || []).filter(idx => Number.isInteger(idx) && idx >= 0 && idx < cfg.city_count))].slice(0, 64);
  return unique.map(detailLite);
}

function parseSearchLine(lineNo) {
  const start = searchOffsets[lineNo];
  let end = searchOffsets[lineNo + 1];
  if (end > start && searchText.charCodeAt(end - 1) === 10) end--;
  const tab = searchText.lastIndexOf("\t", end - 1);
  if (tab < start) return null;
  return {key: searchText.slice(start, tab), idx: Number(searchText.slice(tab + 1, end))};
}
async function search(q, limit = 12) {
  await Promise.all([light(), loadSearch()]);
  const nq = norm(q);
  if (nq.length < 2) return [];
  const tokens = nq.split(" ").filter(Boolean);
  const p3 = nq.slice(0, 3), p2 = nq.slice(0, 2);
  const range = (p3.length >= 3 && cfg.search_prefix3[p3]) || cfg.search_prefix2[p2];
  if (!range) return [];
  const best = [];
  for (let line = range[0]; line < range[1]; line++) {
    const rec = parseSearchLine(line);
    if (!rec) continue;
    let ok = true;
    for (const t of tokens) if (!rec.key.includes(t)) { ok = false; break; }
    if (!ok) continue;
    const cityKeyEnd = rec.key.indexOf(" ");
    const startsFull = rec.key.startsWith(nq);
    const startsFirst = rec.key.startsWith(tokens[0]);
    const rank = startsFull ? 4 : startsFirst ? 3 : rec.key.includes(" " + nq) ? 2 : 1;
    const pop = population[rec.idx] || 0;
    best.push({idx: rec.idx, rank, pop});
  }
  best.sort((a, b) => b.rank - a.rank || b.pop - a.pop || a.idx - b.idx);
  return best.slice(0, limit).map(x => detailLite(x.idx));
}

function seasonBuckets(season, referenceIdx) {
  if (!season || season === "annual") return null;
  const northern = {
    summer: [10, 11, 12, 13, 14, 15],
    autumn: [16, 17, 18, 19, 20, 21, 22],
    winter: [23, 24, 25, 0, 1, 2, 3],
    spring: [4, 5, 6, 7, 8, 9]
  };
  const selected = northern[season];
  if (!selected) return null;
  // Al sur del ecuador, el verano/invierno local ocurre seis meses después.
  return positions[referenceIdx * 2 + 1] < 0 ? selected.map(bucket => (bucket + cfg.seasonal_shift_buckets) % cfg.bucket_count) : selected;
}

function groupDistance(refOffset, candidateOffset, group, shift, selectedBuckets = null) {
  const buckets = cfg.bucket_count;
  const base = group * buckets;
  let sum = 0;
  if (selectedBuckets) for (const bucket of selectedBuckets) {
    const d = features[candidateOffset + base + ((bucket + shift) % buckets)] - features[refOffset + base + bucket];
    sum += d * d;
  } else for (let bucket = 0; bucket < buckets; bucket++) {
    const d = features[candidateOffset + base + ((bucket + shift) % buckets)] - features[refOffset + base + bucket];
    sum += d * d;
  }
  const scale = cfg.groups[group].comparison_scale;
  return sum / (scale * scale * (selectedBuckets ? selectedBuckets.length : buckets));
}

function explanation(refIdx, candidateIdx, shift, selectedBuckets = null) {
  const ref = refIdx * cfg.feature_dim, candidate = candidateIdx * cfg.feature_dim;
  return cfg.groups.map((group, index) => ({
    id: group.id,
    label: group.label,
    similarity_pct: Math.max(0, Math.min(100, Math.round(100 * Math.exp(-cfg.score_alpha * Math.sqrt(groupDistance(ref, candidate, index, shift, selectedBuckets))))))
  }));
}

async function compute(idx, mode, weights, season = "annual") {
  await Promise.all([loadFeatures(), loadPositions()]);
  const t0 = performance.now();
  const N = cfg.city_count, D = cfg.feature_dim;
  let sw = 0;
  const ws = new Float64Array(cfg.groups.length);
  for (let g = 0; g < cfg.groups.length; g++) { ws[g] = Math.max(0, Number(weights[g] || 0)); sw += ws[g]; }
  if (sw <= 0) throw new Error("Al menos un peso climático debe ser mayor a 0");
  const ref = idx * D;
  const selectedBuckets = seasonBuckets(season, idx);
  const scores = new Uint8Array(N);
  let high = 0, mid = 0, low = 0;
  for (let i = 0; i < N; i++) {
    const off = i * D;
    let shift = 0;
    if (mode === "adaptive") {
      const opposite = cfg.seasonal_shift_buckets;
      if (groupDistance(ref, off, 0, opposite, selectedBuckets) < groupDistance(ref, off, 0, 0, selectedBuckets)) shift = opposite;
    }
    let d2 = 0;
    for (let g = 0; g < cfg.groups.length; g++) {
      const w = ws[g];
      if (w <= 0) continue;
      d2 += w * groupDistance(ref, off, g, shift, selectedBuckets);
    }
    const s = Math.max(0, Math.min(100, Math.round(100 * Math.exp(-cfg.score_alpha * Math.sqrt(d2 / sw)))));
    scores[i] = s;
    if (s > 60) high++; else if (s >= 48) mid++; else low++;
  }
  scores[idx] = 100;
  lastScores = scores;
  lastIdx = idx;
  lastModel = {mode, weights: Array.from(ws), season};
  const payload = scores.slice();
  postMessage({type: "scores", idx, ms: performance.now() - t0, counts: {high, mid, low}, scores: payload}, [payload.buffer]);
}

function allowedByFilters(i, idx, filters) {
  const rc = country[idx], rt = continentForCity(idx), ra = admin1[idx], rg = grid[idx];
  if (filters.grid && rg !== 0 && grid[i] === rg) return false;
  if (filters.country && rc !== 0 && country[i] === rc) return false;
  if (filters.region && ra !== 0 && admin1[i] === ra) return false;
  if (filters.continent && rt !== 0 && continentForCity(i) === rt) return false;
  return true;
}

function allowedByScope(i, scope, target) {
  if (scope === "country") return Number(target) > 0 && country[i] === Number(target);
  if (scope === "continent") return Number(target) > 0 && continentForCity(i) === Number(target);
  if (scope === "subcontinent") return Boolean(target) && subregionForCity(i) === target;
  return true;
}

function rankedDetail(idx, candidateIdx) {
  const ref = idx * cfg.feature_dim, candidate = candidateIdx * cfg.feature_dim;
  const selectedBuckets = seasonBuckets(lastModel?.season || "annual", idx);
  let shift = 0;
  if (lastModel?.mode === "adaptive" && groupDistance(ref, candidate, 0, cfg.seasonal_shift_buckets, selectedBuckets) < groupDistance(ref, candidate, 0, 0, selectedBuckets)) shift = cfg.seasonal_shift_buckets;
  return Object.assign(detailLite(candidateIdx), {
    similarity_pct: lastScores[candidateIdx],
    seasonal_alignment: shift ? "hemisferio opuesto" : "mismo calendario",
    factors: explanation(idx, candidateIdx, shift, selectedBuckets)
  });
}

async function rank(idx, limit, filters, visibility) {
  await light();
  if (!lastScores || lastIdx !== idx) return {rows: [], visible: new Uint8Array(cfg.city_count), total: 0};
  const onlyTop = Boolean(visibility?.onlyTop);
  const scope = visibility?.scope || "global";
  const target = visibility?.target || "";
  const viewMode = visibility?.viewMode || "count";
  const requested = Math.max(1, Math.min(cfg.city_count, Math.round(Number(visibility?.value) || 250)));
  const candidates = [];
  const visible = new Uint8Array(cfg.city_count);
  for (let i = 0; i < lastScores.length; i++) {
    if (i === idx) continue;
    if (!allowedByFilters(i, idx, filters)) continue;
    if (!onlyTop) visible[i] = 1;
    if (allowedByScope(i, scope, target)) candidates.push(i);
  }
  candidates.sort((a, b) => lastScores[b] - lastScores[a] || (population[b] || 0) - (population[a] || 0));
  let shown = candidates.length;
  if (onlyTop) {
    if (viewMode === "threshold") {
      shown = 0;
      for (const candidateIdx of candidates) if (lastScores[candidateIdx] >= requested) { visible[candidateIdx] = 1; shown++; }
    } else {
      const count = viewMode === "percentile" ? Math.ceil(candidates.length * requested / 100) : requested;
      shown = Math.min(count, candidates.length);
      for (let i = 0; i < shown; i++) visible[candidates[i]] = 1;
    }
  }
  visible[idx] = 1;
  const payload = visible.slice();
  const topRows = candidates.slice(0, Math.max(1, limit)).map(candidateIdx => rankedDetail(idx, candidateIdx));
  const foreignIndices = [];for (const candidateIdx of candidates) if (continentForCity(candidateIdx) !== continentForCity(idx)) { foreignIndices.push(candidateIdx); if (foreignIndices.length === 6) break; }
  const foreignRows = foreignIndices.map(candidateIdx => rankedDetail(idx, candidateIdx));
  const exportRows = [...foreignRows, ...topRows.filter(row => !foreignRows.some(other => other.idx === row.idx))].slice(0, 8);
  return {
    rows: topRows,
    exportRows,
    visible: payload,
    total: candidates.length,
    shown
  };
}

async function regionCatalog() {
  await light();
  return {
    continents: codebooks.continents.map((label, id) => ({id: String(id), label})).filter(row => row.id !== "0" && row.label),
    subcontinents: (self.NEO_SUBREGIONS || []).map(({id, label}) => ({id, label})),
    countries: codebooks.countries.map((label, id) => ({id: String(id), label})).filter(row => row.id !== "0" && row.label).sort((a, b) => a.label.localeCompare(b.label))
  };
}

function countryIndices(countryId, maxCities = 0) {
  const rows = [];
  for (let i = 0; i < country.length; i++) if (country[i] === countryId) rows.push(i);
  if (!maxCities || rows.length <= maxCities) return rows;
  rows.sort((a, b) => (population[b] || 0) - (population[a] || 0));
  return rows.slice(0, maxCities);
}

function boundsForIndices(indices) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const idx of indices) { const lon = positions[idx * 2], lat = positions[idx * 2 + 1]; minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon); minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat); }
  return {minLon, maxLon, minLat, maxLat};
}

async function countryTop(idx, countryId, limit, filters) {
  await Promise.all([light(), loadPositions()]);
  if (!lastScores || lastIdx !== idx) throw new Error("Calcula primero la afinidad de una ciudad.");
  const target = Number(countryId);
  if (!target || !codebooks.countries[target]) throw new Error("Selecciona un país válido.");
  const all = countryIndices(target);
  // El país elegido define el universo: excluir "mismo país" no debe ocultarlo por completo.
  const countryScopedFilters = Object.assign({}, filters, {country: false});
  const candidates = all.filter(candidateIdx => candidateIdx !== idx && allowedByFilters(candidateIdx, idx, countryScopedFilters));
  candidates.sort((a, b) => lastScores[b] - lastScores[a] || (population[b] || 0) - (population[a] || 0));
  return {countryId: target, countryName: codebooks.countries[target], bounds: boundsForIndices(all), rows: candidates.slice(0, Math.max(1, limit || 10)).map(candidateIdx => rankedDetail(idx, candidateIdx))};
}

function pairScore(leftIdx, rightIdx, mode, weights, season = "annual") {
  const ref = leftIdx * cfg.feature_dim, candidate = rightIdx * cfg.feature_dim;
  const selectedBuckets = seasonBuckets(season, leftIdx);
  let shift = 0;
  if (mode === "adaptive" && groupDistance(ref, candidate, 0, cfg.seasonal_shift_buckets, selectedBuckets) < groupDistance(ref, candidate, 0, 0, selectedBuckets)) shift = cfg.seasonal_shift_buckets;
  let sw = 0, d2 = 0;
  for (let g = 0; g < cfg.groups.length; g++) { const w = Math.max(0, Number(weights[g] || 0)); if (!w) continue; sw += w; d2 += w * groupDistance(ref, candidate, g, shift, selectedBuckets); }
  if (!sw) throw new Error("Al menos un peso debe ser mayor a 0.");
  return {score: Math.max(0, Math.min(100, Math.round(100 * Math.exp(-cfg.score_alpha * Math.sqrt(d2 / sw))))), shift};
}

async function compareCountries(leftCountryId, rightCountryId, mode, weights, season = "annual") {
  await Promise.all([light(), loadFeatures(), loadPositions()]);
  const leftId = Number(leftCountryId), rightId = Number(rightCountryId);
  if (!leftId || !rightId || leftId === rightId) throw new Error("Elige dos países distintos.");
  let left = countryIndices(leftId), right = countryIndices(rightId);
  const totalPairs = left.length * right.length, exactLimit = 1000000;
  let sampled = false;
  if (totalPairs > exactLimit) {
    const perCountryCap = Math.floor(Math.sqrt(exactLimit));
    left = countryIndices(leftId, perCountryCap); right = countryIndices(rightId, perCountryCap); sampled = true;
  }
  const best = [], reserve = 400;
  let lowest = -1, lowestScore = -Infinity;
  for (const leftIdx of left) for (const rightIdx of right) {
    const pair = pairScore(leftIdx, rightIdx, mode, weights, season);
    if (best.length < reserve) {
      best.push({leftIdx, rightIdx, ...pair});
      if (best.length === reserve) {
        lowest = 0;
        for (let i = 1; i < best.length; i++) if (best[i].score < best[lowest].score) lowest = i;
        lowestScore = best[lowest].score;
      }
    } else if (pair.score > lowestScore) {
      best[lowest] = {leftIdx, rightIdx, ...pair};
      lowest = 0;
      for (let i = 1; i < best.length; i++) if (best[i].score < best[lowest].score) lowest = i;
      lowestScore = best[lowest].score;
    }
  }
  best.sort((a, b) => b.score - a.score);
  const usedLeft = new Set(), usedRight = new Set(), pairs = [];
  for (const pair of best) {
    if (usedLeft.has(pair.leftIdx) || usedRight.has(pair.rightIdx)) continue;
    usedLeft.add(pair.leftIdx); usedRight.add(pair.rightIdx); pairs.push(pair);
    if (pairs.length === 10) break;
  }
  return {leftCountry: codebooks.countries[leftId], rightCountry: codebooks.countries[rightId], leftBounds: boundsForIndices(countryIndices(leftId)), rightBounds: boundsForIndices(countryIndices(rightId)), sampled, pairs: pairs.map(pair => ({similarity_pct: pair.score, seasonal_alignment: pair.shift ? "hemisferio opuesto" : "mismo calendario", left: detailLite(pair.leftIdx), right: detailLite(pair.rightIdx)}))};
}

const ANNUAL_METRICS = [
  ["temperature", "Temperatura media", "°C", 0],
  ["rain", "Precipitación anual", "mm/año", 3],
  ["humidity", "Humedad media", "%", 4],
  ["wind", "Viento medio", "km/h", 5],
  ["cloud", "Nubosidad media", "%", 6],
  ["sun", "Horas de sol", "h/día", 7],
  ["solar", "Energía solar", "kWh/m²/día", 8]
];

function annualMetricsFor(idx) {
  const offset = idx * 9;
  return ANNUAL_METRICS.map(([id, label, unit, metricIndex]) => ({
    id, label, unit,
    value: Number.isFinite(metrics[offset + metricIndex]) ? metrics[offset + metricIndex] : null
  }));
}

async function compareCities(leftIdx, rightIdx, mode, weights, season = "annual") {
  await Promise.all([light(), loadMetrics(), loadFeatures(), loadPositions()]);
  if (!Number.isInteger(leftIdx) || !Number.isInteger(rightIdx) || leftIdx < 0 || rightIdx < 0 || leftIdx >= cfg.city_count || rightIdx >= cfg.city_count || leftIdx === rightIdx) throw new Error("Elige dos urbes distintas.");
  const result = pairScore(leftIdx, rightIdx, mode, weights, season);
  const selectedBuckets = seasonBuckets(season, leftIdx);
  const seasons = ["summer", "autumn", "winter", "spring"].map(id => ({
    id,
    score: pairScore(leftIdx, rightIdx, mode, weights, id).score
  }));
  const leftMetrics = annualMetricsFor(leftIdx), rightMetrics = annualMetricsFor(rightIdx);
  const annual = leftMetrics.map((metric, index) => Object.assign(metric, {
    left: metric.value,
    right: rightMetrics[index].value,
    difference: metric.value == null || rightMetrics[index].value == null ? null : rightMetrics[index].value - metric.value
  }));
  return {
    similarity_pct: result.score,
    seasonal_alignment: result.shift ? "hemisferio opuesto" : "mismo calendario",
    left: detailLite(leftIdx), right: detailLite(rightIdx),
    domains: explanation(leftIdx, rightIdx, result.shift, selectedBuckets),
    seasons,
    annual
  };
}

async function warm() {
  await Promise.allSettled([light(), loadSearch()]);
}

onmessage = async e => {
  const m = e.data || {};
  try {
    if (m.type === "init") return init(m.base);
    if (m.type === "warm") return warm();
    if (m.type === "warmFeatures") return loadFeatures();
    if (m.type === "search") return postMessage({type: "searchResults", id: m.id, rows: await search(m.q, m.limit)});
    if (m.type === "detail") return postMessage({type: "detailResult", id: m.id, row: await detail(m.idx)});
    if (m.type === "hover") return postMessage({type: "hoverResult", id: m.id, row: await quickDetail(m.idx)});
    if (m.type === "labels") return postMessage({type: "labelResults", id: m.id, rows: await quickDetails(m.indices)});
    if (m.type === "regionCatalog") return postMessage({type: "regionCatalogResult", id: m.id, result: await regionCatalog()});
    if (m.type === "compute") return compute(m.idx, m.mode, m.weights, m.season || "annual");
    if (m.type === "countryTop") return postMessage({type: "countryTopResult", id: m.id, result: await countryTop(m.idx, m.countryId, m.limit || 10, m.filters || {})});
    if (m.type === "compareCountries") return postMessage({type: "countryComparisonResult", id: m.id, result: await compareCountries(m.leftCountryId, m.rightCountryId, m.mode || "adaptive", m.weights || [], m.season || "annual")});
    if (m.type === "compareCities") return postMessage({type: "cityComparisonResult", id: m.id, result: await compareCities(m.leftIdx, m.rightIdx, m.mode || "adaptive", m.weights || [], m.season || "annual")});
    if (m.type === "rank") {
      const result = await rank(m.idx, m.limit || 10, m.filters || {}, m.visibility || {});
      return postMessage({type: "rankResults", id: m.id, result}, [result.visible.buffer]);
    }
  } catch (err) {
    postMessage({type: "error", id: m.id, message: String(err && err.message || err)});
  }
};
