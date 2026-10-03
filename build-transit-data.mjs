#!/usr/bin/env node
/**
 * 彙整九巴／龍運、城巴、綠色專線小巴的「路線 → 巴士站（含座標）」資料，輸出成 transit-data.json。
 *
 * 為什麼需要這個檔案：
 *   城巴和專線小巴的官方 API 沒有「一次取得全部站點」的介面，要逐條路線、逐個站查詢（幾千次請求），
 *   網頁在手機上做不到。所以改由 GitHub Actions 每日在伺服器端查詢一次，把結果存成一個靜態檔案，
 *   網頁只需下載這一個檔案即可計算乘車方案。
 *
 * 資料來源（全部是運輸署／營辦商官方開放 API）：
 *   九巴／龍運  https://data.etabus.gov.hk/v1/transport/kmb
 *   城巴        https://rt.data.gov.hk/v2/transport/citybus
 *   專線小巴    https://data.etagmb.gov.hk
 *
 * 輸出格式（為縮小檔案而使用短欄位名）：
 *   {
 *     "version": 1,
 *     "generated": "2026-10-03T04:00:00.000Z",
 *     "status": { "KMB": "ok (1500 routes)", "CTB": "...", "GMB": "..." },
 *     "stops":  [ [緯度, 經度, "站名", "營辦商代號", "營辦商站編號"], ... ],   // 陣列位置 = 站索引
 *     "routes": [
 *       { "c":"KMB", "r":"1A", "b":"O", "x":"1", "o":"起點", "d":"終點", "s":[站索引...] },
 *       { "c":"CTB", "r":"1",  "b":"outbound", "o":"..", "d":"..", "s":[...] },
 *       { "c":"GMB", "r":"69", "b":1, "x":2000410, "g":"HKI", "n":"正常班次", "o":"..", "d":"..", "s":[...], "q":[官方站序...] }
 *     ]
 *   }
 *   KMB: b = O/I，x = service_type；CTB: b = outbound/inbound；GMB: b = route_seq，x = route_id，g = 地區。
 *
 * 可用環境變數：KMB_BASE / CTB_BASE / GMB_BASE（改用其他網址，測試用）、OUT（輸出檔案路徑）、CONCURRENCY（並行請求數）
 */
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const KMB = process.env.KMB_BASE || 'https://data.etabus.gov.hk/v1/transport/kmb';
const CTB = process.env.CTB_BASE || 'https://rt.data.gov.hk/v2/transport/citybus';
const GMB = process.env.GMB_BASE || 'https://data.etagmb.gov.hk';
const OUT = process.env.OUT || 'transit-data.json';
const CONC = parseInt(process.env.CONCURRENCY || '6', 10);

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 取得 JSON。soft=true 時，400/404/422（例如該路線沒有這個方向）回傳 null 而不是報錯。 */
async function getJSON(url, { soft = false, tries = 4 } = {}) {
  let lastErr;
  for (let a = 0; a < tries; a++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000), headers: { accept: 'application/json' } });
      if ([400, 404, 422].includes(res.status)) {
        if (soft) return null;
        const e = new Error(`HTTP ${res.status} ${url}`); e.final = true; throw e;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (e.final) break;
      await sleep(800 * 2 ** a);
    }
  }
  throw lastErr;
}

/** 以固定並行數處理清單；單一項目失敗只記錄、不中斷整體 */
async function pool(items, limit, fn, label = '') {
  const out = new Array(items.length);
  let next = 0, done = 0, failed = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch (e) { out[i] = null; failed++; }
      done++;
      if (label && done % 500 === 0) console.log(`  ${label}: ${done}/${items.length}`);
    }
  });
  await Promise.all(workers);
  return { out, failed };
}

const stops = [];
const stopIndex = new Map();
const round5 = n => Math.round(n * 1e5) / 1e5;
function addStop(co, id, lat, lng, name) {
  const key = co + ':' + id;
  if (stopIndex.has(key)) return stopIndex.get(key);
  const i = stops.length;
  stops.push([round5(lat), round5(lng), name, co, String(id)]);
  stopIndex.set(key, i);
  return i;
}

/* ---------------- 九巴／龍運（官方提供「全部路線巴士站」及「全部巴士站」兩個一次下載的介面） ---------------- */
async function crawlKMB() {
  const [rl, sl, rsl] = await Promise.all([getJSON(KMB + '/route/'), getJSON(KMB + '/stop'), getJSON(KMB + '/route-stop')]);
  const info = new Map();
  (rl.data || []).forEach(r => info.set(`${r.route}|${r.bound}|${r.service_type}`, r));
  const sm = new Map();
  (sl.data || []).forEach(s => {
    const lat = parseFloat(s.lat), lng = parseFloat(s.long);
    if (isFinite(lat) && isFinite(lng)) sm.set(s.stop, { lat, lng, name: s.name_tc || s.name_en || s.stop });
  });
  const groups = new Map();
  (rsl.data || []).forEach(r => {
    const key = `${r.route}|${r.bound}|${r.service_type}`;
    if (!groups.has(key)) groups.set(key, { route: r.route, bound: r.bound, st: r.service_type, items: [] });
    groups.get(key).items.push({ seq: parseInt(r.seq, 10), stop: r.stop });
  });
  const routes = [];
  groups.forEach((g, key) => {
    g.items.sort((a, b) => a.seq - b.seq);
    const s = [];
    g.items.forEach(it => { const p = sm.get(it.stop); if (p) s.push(addStop('KMB', it.stop, p.lat, p.lng, p.name)); });
    if (s.length < 2) return;
    const nm = info.get(key) || {};
    routes.push({ c: 'KMB', r: g.route, b: g.bound, x: String(g.st), o: nm.orig_tc || '', d: nm.dest_tc || '', s });
  });
  if (!routes.length) throw new Error('九巴沒有取得任何路線（API 格式可能已改變）');
  return routes;
}

/* ---------------- 城巴（逐條路線取站序，再逐個站取座標） ---------------- */
async function crawlCTB() {
  const rl = await getJSON(CTB + '/route/ctb');
  const list = rl.data || [];
  const jobs = [];
  list.forEach(r => { jobs.push({ r, dir: 'outbound' }); jobs.push({ r, dir: 'inbound' }); });
  console.log(`城巴：${list.length} 條路線，查詢 ${jobs.length} 個方向的站序…`);
  const rs = await pool(jobs, CONC, async j => {
    const d = await getJSON(`${CTB}/route-stop/CTB/${encodeURIComponent(j.r.route)}/${j.dir}`, { soft: true });
    return d && d.data ? d.data : null;
  }, '城巴站序');
  const uniq = new Set();
  rs.out.forEach(arr => (arr || []).forEach(x => uniq.add(x.stop)));
  const ids = [...uniq];
  console.log(`城巴：共 ${ids.length} 個巴士站，逐個查詢座標…`);
  const sp = await pool(ids, CONC, async id => {
    const d = await getJSON(`${CTB}/stop/${encodeURIComponent(id)}`, { soft: true });
    const x = d && d.data;
    if (!x) return null;
    const lat = parseFloat(x.lat), lng = parseFloat(x.long);
    return isFinite(lat) && isFinite(lng) ? { lat, lng, name: x.name_tc || x.name_en || id } : null;
  }, '城巴站座標');
  const sm = new Map(ids.map((id, i) => [id, sp.out[i]]));
  const routes = [];
  jobs.forEach((j, i) => {
    const arr = rs.out[i];
    if (!arr || !arr.length) return;
    arr.sort((a, b) => a.seq - b.seq);
    const s = [];
    arr.forEach(x => { const p = sm.get(x.stop); if (p) s.push(addStop('CTB', x.stop, p.lat, p.lng, p.name)); });
    if (s.length < 2) return;
    const outbound = j.dir === 'outbound';
    routes.push({ c: 'CTB', r: j.r.route, b: j.dir, o: (outbound ? j.r.orig_tc : j.r.dest_tc) || '', d: (outbound ? j.r.dest_tc : j.r.orig_tc) || '', s });
  });
  if (!routes.length) throw new Error('城巴沒有取得任何路線（API 格式可能已改變）');
  return routes;
}

/* ---------------- 專線小巴（逐條路線取站序，再逐個站取座標） ---------------- */
async function crawlGMB() {
  const all = await getJSON(GMB + '/route');
  const regions = (all.data && all.data.routes) || {};
  const codes = [];
  Object.keys(regions).forEach(region => (regions[region] || []).forEach(code => codes.push({ region, code })));
  console.log(`小巴：${codes.length} 個路線編號，查詢路線詳情…`);
  const det = await pool(codes, CONC, async c => {
    const d = await getJSON(`${GMB}/route/${c.region}/${encodeURIComponent(c.code)}`, { soft: true });
    return d && d.data ? d.data : null;
  }, '小巴路線');
  const dirs = [];
  det.out.forEach((arr, i) => (arr || []).forEach(rt => (rt.directions || []).forEach(d => dirs.push({
    region: codes[i].region, code: codes[i].code, routeId: rt.route_id, desc: rt.description_tc || '',
    seq: d.route_seq, orig: d.orig_tc || '', dest: d.dest_tc || ''
  }))));
  console.log(`小巴：${dirs.length} 個路線方向，查詢站序…`);
  const rs = await pool(dirs, CONC, async d => {
    const r = await getJSON(`${GMB}/route-stop/${d.routeId}/${d.seq}`, { soft: true });
    return r && r.data && r.data.route_stops ? r.data.route_stops : null;
  }, '小巴站序');
  const names = new Map();
  rs.out.forEach(arr => (arr || []).forEach(x => { if (!names.has(x.stop_id)) names.set(x.stop_id, x.name_tc || x.name_en || String(x.stop_id)); }));
  const ids = [...names.keys()];
  console.log(`小巴：共 ${ids.length} 個巴士站，逐個查詢座標…`);
  const sp = await pool(ids, CONC, async id => {
    const d = await getJSON(`${GMB}/stop/${id}`, { soft: true });
    const w = d && d.data && d.data.coordinates && d.data.coordinates.wgs84;
    return w && isFinite(w.latitude) && isFinite(w.longitude) ? { lat: w.latitude, lng: w.longitude } : null;
  }, '小巴站座標');
  const sm = new Map(ids.map((id, i) => [id, sp.out[i]]));
  const routes = [];
  dirs.forEach((d, i) => {
    const arr = rs.out[i];
    if (!arr || !arr.length) return;
    arr.sort((a, b) => a.stop_seq - b.stop_seq);
    const s = [], q = [];
    arr.forEach(x => {
      const p = sm.get(x.stop_id);
      if (p){ s.push(addStop('GMB', x.stop_id, p.lat, p.lng, names.get(x.stop_id))); q.push(x.stop_seq); }
    });
    if (s.length < 2) return;
    // q = 官方的 stop_seq（有些站查不到座標被略過時，位置與官方站序會不同，查到站時間要用官方站序）
    routes.push({ c: 'GMB', r: d.code, b: d.seq, x: d.routeId, g: d.region, n: d.desc, o: d.orig, d: d.dest, s, q });
  });
  if (!routes.length) throw new Error('專線小巴沒有取得任何路線（API 格式可能已改變）');
  return routes;
}

const status = {};
const routes = [];
let failures = 0;
for (const [name, fn] of [['KMB', crawlKMB], ['CTB', crawlCTB], ['GMB', crawlGMB]]) {
  try {
    const r = await fn();
    routes.push(...r);
    status[name] = `ok (${r.length} routes)`;
    console.log(`✔ ${name}: ${r.length} 條路線方向`);
  } catch (e) {
    failures++;
    status[name] = 'failed: ' + e.message;
    console.error(`✖ ${name} 失敗：`, e.message);
  }
}

if (!routes.length) { console.error('三個營辦商全部失敗，不寫入檔案。'); process.exit(1); }
if (failures && existsSync(OUT)) {
  console.error('有營辦商失敗，為免新資料缺少部分營辦商，保留原有的 ' + OUT + ' 不覆蓋。');
  process.exit(1);
}
const data = { version: 1, generated: new Date().toISOString(), status, stops, routes };
await writeFile(OUT, JSON.stringify(data));
console.log(`已寫入 ${OUT}：${stops.length} 個巴士站、${routes.length} 個路線方向。`);
