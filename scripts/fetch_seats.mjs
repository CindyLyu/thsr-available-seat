// scripts/fetch_seats.mjs  (Node 20+，不需要任何套件)
//
// 用法：
//   TDX_CLIENT_ID=xxx TDX_CLIENT_SECRET=yyy node scripts/fetch_seats.mjs --probe   # 印出 API 原始回傳前段與大小，用來確認欄位
//   TDX_CLIENT_ID=xxx TDX_CLIENT_SECRET=yyy node scripts/fetch_seats.mjs           # 產生 site/data/*.json
//
// 輸出：
//   site/data/index.json        { fetchedAt, today, dates: [...] }
//   site/data/YYYY-MM-DD.json   { date, fetchedAt, sourceUpdateTime, trips, arrivals }
//
// TDX 基礎會員的限制（這支腳本的設計前提）：
//   - 每月只有 3 點：點數 = 呼叫次數 / 1500 + 傳輸量(MB) / 150，所以要少呼叫、少傳輸
//   - 每分鐘最多 5 次呼叫：每次呼叫之間至少間隔 REQUEST_GAP_MS（預設 13 秒）
//
// 呼叫策略：
//   今天        車站看板型 /AvailableSeatStatusList，每次執行都抓（營運時段才抓）
//   未來日期    OD 型 /AvailableSeatStatus/Train/OD/TrainDate/{日期}，用 $select 只取需要的欄位
//               近 NEAR_DAYS 天在 TDX 更新（10、16、22 時）後重抓，更遠的日期每天只在 22 時更新後重抓
//   時刻表      每個日期只抓一次並快取（.cache/timetable）；OD 對不到車次時才重抓
// 快取放在 .cache，由 Actions cache 保存。

import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

const BASE = process.env.TDX_BASE ?? 'https://tdx.transportdata.tw/api/basic/v2/Rail/THSR';
const TOKEN_URL =
  process.env.TDX_TOKEN_URL ??
  'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const SEAT_PATH = process.env.SEAT_PATH ?? '/AvailableSeatStatusList';
const DAYS_AHEAD = Number(process.env.DAYS_AHEAD ?? 14);
const NEAR_DAYS = Number(process.env.NEAR_DAYS ?? 3);
const REQUEST_GAP_MS = Number(process.env.REQUEST_GAP_MS ?? 13000);
const OPEN_HOUR = 6; // 台北時間 06:00 之前高鐵沒有營運，不抓資料
const CACHE_FUTURE = '.cache/future';
const CACHE_TIMETABLE = '.cache/timetable';
const OUT_DIR = 'site/data';
// TDX 更新未來日期的時間（台北時間，分鐘）後 30 分
const ALL_SLOTS = [10 * 60 + 30, 16 * 60 + 30, 22 * 60 + 30];
const LATE_SLOTS = [22 * 60 + 30];
const OD_SELECT =
  '&%24select=TrainNo,OriginStationID,DestinationStationID,StandardSeatStatus,BusinessSeatStatus';

const { TDX_CLIENT_ID, TDX_CLIENT_SECRET } = process.env;
if (!TDX_CLIENT_ID || !TDX_CLIENT_SECRET) {
  console.error('請設定環境變數 TDX_CLIENT_ID 與 TDX_CLIENT_SECRET');
  process.exit(1);
}
const PROBE = process.argv.includes('--probe');
const FORCE = process.argv.includes('--force') || process.env.FORCE === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getToken() {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: TDX_CLIENT_ID,
      client_secret: TDX_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`取得 token 失敗：${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

// 所有 API 呼叫都經過這裡：維持呼叫間隔，429 時等一下再試
let lastCallAt = 0;
let callCount = 0;
let totalBytes = 0; // 解壓後的文字長度
let totalGzipBytes = 0; // 估算壓縮後大小（TDX 的「資料傳輸量」應該是壓縮後的大小）
async function getJson(path, token, query = '') {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCallAt + REQUEST_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    callCount++;
    const res = await fetch(`${BASE}${path}?%24format=JSON${query}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    if (res.status === 429 && attempt < 2) {
      await sleep(30000 * (attempt + 1)); // 每分鐘 5 次的限制，等一段時間再試
      continue;
    }
    if (!res.ok) {
      const err = new Error(`${path} 失敗：${res.status} ${(await res.text()).slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    const text = await res.text();
    totalBytes += text.length;
    totalGzipBytes += gzipSync(text).length;
    return JSON.parse(text);
  }
}

// ---------- 日期 / 時間（一律台北時間） ----------
const taipeiNow = () => new Date(Date.now() + 8 * 3600e3); // 用 UTC 欄位讀就是台北時間
const ymd = (d) => d.toISOString().slice(0, 10);
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}
// 最近一次「該重抓」的時間點（epoch ms）
function latestSlotMs(slots) {
  const tp = taipeiNow();
  const today = ymd(tp);
  const minutes = tp.getUTCHours() * 60 + tp.getUTCMinutes();
  const toMs = (date, min) => Date.parse(`${date}T00:00:00Z`) + (min - 8 * 60) * 60000;
  const passed = slots.filter((m) => m <= minutes);
  return passed.length ? toMs(today, passed.at(-1)) : toMs(addDays(today, -1), slots.at(-1));
}

// ---------- normalize ----------
// 狀態統一成 O(尚有) / L(有限) / X(售完)；認不得的回傳 null
function status(v) {
  if (!v) return null;
  const s = String(v).toLowerCase();
  if (s === 'o' || s === 'available') return 'O';
  if (s === 'l' || s === 'limited') return 'L';
  if (s === 'x' || s === 'full') return 'X';
  return null;
}

// 今天：車站看板型。每筆 = 某班車從 StationID 出發，StopStations 是到各目的站的餘位。
function buildTripsFromBoard(raw) {
  const list = Array.isArray(raw) ? raw : raw.AvailableSeats ?? [];
  return list.map((item) => ({
    no: String(item.TrainNo),
    from: item.StationID,
    dep: item.DepartureTime,
    to: (item.StopStations ?? []).map((st) => ({
      id: st.StationID,
      s: status(st.StandardSeatStatus),
      b: status(st.BusinessSeatStatus),
    })),
  }));
}

// 未來日期：OD 型。每筆 = 某班車 起站→迄站 的餘位；出發時間從時刻表補。
// missing = 時刻表裡找不到的車次（可能是後來加開的班次）
function buildTripsFromOD(raw, timetable) {
  const list = Array.isArray(raw) ? raw : raw.AvailableSeats ?? [];
  const groups = new Map(); // `${no}|${from}` -> trip
  const missing = new Set();
  for (const item of list) {
    const no = String(item.TrainNo);
    const from = item.OriginStationID;
    const dep = timetable.departures[no]?.[from];
    if (!dep) {
      missing.add(no);
      continue;
    }
    const key = `${no}|${from}`;
    if (!groups.has(key)) groups.set(key, { no, from, dep, to: [] });
    groups.get(key).to.push({
      id: item.DestinationStationID,
      s: status(item.StandardSeatStatus),
      b: status(item.BusinessSeatStatus),
    });
  }
  return { trips: [...groups.values()], missing };
}

function buildTimetable(raw) {
  const list = Array.isArray(raw) ? raw : raw?.TrainTimetables ?? [];
  const arrivals = {};
  const departures = {};
  for (const item of list) {
    const no = String(item.DailyTrainInfo?.TrainNo ?? item.TrainInfo?.TrainNo ?? '');
    if (!no) continue;
    arrivals[no] = {};
    departures[no] = {};
    for (const st of item.StopTimes ?? []) {
      arrivals[no][st.StationID] = st.ArrivalTime ?? st.DepartureTime;
      departures[no][st.StationID] = st.DepartureTime ?? st.ArrivalTime;
    }
  }
  return { arrivals, departures };
}

const readJsonIfExists = async (p) => {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
};
const writeJson = (p, obj) => writeFile(p, JSON.stringify(obj));

// 時刻表：每個日期只抓一次並快取。force 用於 OD 對不到車次時重抓。
async function getTimetable(date, token, { force = false } = {}) {
  const path = `${CACHE_TIMETABLE}/${date}.json`;
  if (!force) {
    const cached = await readJsonIfExists(path);
    if (cached) return { ...cached, fresh: false };
  }
  const tt = buildTimetable(await getJson(`/DailyTimetable/TrainDate/${date}`, token));
  await writeJson(path, tt);
  return { ...tt, fresh: true };
}

// OD 餘位：優先用 $select 縮小回傳；若 $select 沒有作用（欄位不見了）就退回完整回傳
let useSelect = process.env.USE_SELECT !== '0';
async function fetchOD(date, token) {
  const path = `/AvailableSeatStatus/Train/OD/TrainDate/${date}`;
  if (useSelect) {
    const raw = await getJson(path, token, OD_SELECT);
    const list = Array.isArray(raw) ? raw : raw.AvailableSeats ?? [];
    if (list[0]?.OriginStationID && list[0]?.TrainNo) return raw;
    console.warn('$select 沒有作用或回傳為空，改用完整回傳');
    useSelect = false;
  }
  return getJson(path, token);
}

async function fetchFutureDay(date, token) {
  let tt = await getTimetable(date, token);
  const seatRaw = await fetchOD(date, token);
  let { trips, missing } = buildTripsFromOD(seatRaw, tt);
  if (missing.size > 0 && !tt.fresh) {
    // 可能有加開班次：時刻表重抓一次再合併
    tt = await getTimetable(date, token, { force: true });
    ({ trips, missing } = buildTripsFromOD(seatRaw, tt));
  }
  if (missing.size > 0) console.warn(`${date} 有 ${missing.size} 班車在時刻表找不到，已略過`);
  return {
    date,
    fetchedAt: new Date().toISOString(),
    sourceUpdateTime: seatRaw.UpdateTime ?? null,
    trips,
    arrivals: tt.arrivals,
  };
}

async function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

// ---------- main ----------
const today = ymd(taipeiNow());

if (!PROBE && !FORCE && taipeiNow().getUTCHours() < OPEN_HOUR) {
  console.log(`台北時間 ${OPEN_HOUR}:00 前高鐵沒有營運，略過這次抓取（用 --force 可強制執行）`);
  await setOutput('skip', 'true');
  process.exit(0);
}

const token = await getToken();

if (PROBE) {
  const tomorrow = addDays(today, 1);
  const kb = (n) => (n / 1024).toFixed(1);
  // 每支 API 單獨列出大小，方便和 TDX 會員中心的「呼叫統計」比對
  const show = async (title, call) => {
    const g0 = totalGzipBytes;
    const t0 = totalBytes;
    const v = await call();
    console.log(`--- ${title}：解壓後 ${kb(totalBytes - t0)} KB，估算壓縮後 ${kb(totalGzipBytes - g0)} KB ---`);
    console.log((JSON.stringify(v, null, 2) ?? 'undefined').slice(0, 1200));
  };
  await show('今天 餘位', () => getJson(SEAT_PATH, token));
  await show(`${tomorrow} OD 餘位（用 $select）`, () =>
    getJson(`/AvailableSeatStatus/Train/OD/TrainDate/${tomorrow}`, token, OD_SELECT));
  await show(`${tomorrow} 時刻表`, () => getJson(`/DailyTimetable/TrainDate/${tomorrow}`, token));
  console.log(`\n本次 probe 共呼叫 ${callCount} 次，解壓後 ${kb(totalBytes)} KB，估算壓縮後 ${kb(totalGzipBytes)} KB`);
  process.exit(0);
}

await mkdir(OUT_DIR, { recursive: true });
await mkdir(CACHE_FUTURE, { recursive: true });
await mkdir(CACHE_TIMETABLE, { recursive: true });

// 1) 今天：一定要成功，否則讓 workflow 失敗，避免部署空資料
const seatRaw = await getJson(SEAT_PATH, token);
const todayTrips = buildTripsFromBoard(seatRaw);
if (todayTrips.length === 0) {
  throw new Error('今天沒有任何班次，請用 --probe 檢查端點與欄位');
}
let todayTimetable = { arrivals: {} };
try {
  todayTimetable = await getTimetable(today, token); // 每天只抓一次
} catch (e) {
  console.warn(`今天的時刻表抓取失敗，將不顯示抵達時間：${e.message}`);
}
await writeJson(`${OUT_DIR}/${today}.json`, {
  date: today,
  fetchedAt: new Date().toISOString(),
  sourceUpdateTime: seatRaw.UpdateTime ?? null,
  trips: todayTrips,
  arrivals: todayTimetable.arrivals,
});

// 2) 未來日期：失敗就沿用快取，沒快取就略過該天
const dates = [today];
let refetched = 0;
let rateLimited = false;
for (let i = 1; i <= DAYS_AHEAD; i++) {
  const date = addDays(today, i);
  const cachePath = `${CACHE_FUTURE}/${date}.json`;
  let day = await readJsonIfExists(cachePath);
  const slotMs = latestSlotMs(i <= NEAR_DAYS ? ALL_SLOTS : LATE_SLOTS);
  const stale = !day || Date.parse(day.fetchedAt) < slotMs;
  if (stale && !rateLimited) {
    try {
      const fresh = await fetchFutureDay(date, token);
      if (fresh.trips.length > 0) {
        day = fresh;
        await writeJson(cachePath, day);
        refetched++;
      }
    } catch (e) {
      console.warn(`${date} 抓取失敗，${day ? '沿用舊資料' : '略過'}：${e.message}`);
      // 被限流就先停，沒抓到的日期下一次排程會自動補抓
      if (e.status === 429) rateLimited = true;
    }
  }
  if (day?.trips?.length) {
    await writeJson(`${OUT_DIR}/${date}.json`, day);
    dates.push(date);
  }
}

// 清掉已過期的快取
for (const dir of [CACHE_FUTURE, CACHE_TIMETABLE]) {
  for (const f of await readdir(dir)) {
    if (f.slice(0, 10) < today) await rm(`${dir}/${f}`);
  }
}
for (const f of await readdir(CACHE_FUTURE)) {
  if (f.slice(0, 10) <= today) await rm(`${CACHE_FUTURE}/${f}`);
}

await writeJson(`${OUT_DIR}/index.json`, { fetchedAt: new Date().toISOString(), today, dates });
console.log(
  `完成：今天 ${todayTrips.length} 筆起站班次；未來日期共 ${dates.length - 1} 天（本次重抓 ${refetched} 天${rateLimited ? '，遇到限流，其餘下次補抓' : ''}）；` +
    `本次 API 呼叫 ${callCount} 次，估算壓縮後傳輸約 ${(totalGzipBytes / 1024).toFixed(0)} KB`,
);
