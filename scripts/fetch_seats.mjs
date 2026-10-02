// scripts/fetch_seats.mjs  (Node 20+，不需要任何套件)
//
// 用法：
//   TDX_CLIENT_ID=xxx TDX_CLIENT_SECRET=yyy node scripts/fetch_seats.mjs --probe   # 印出 API 原始回傳前段，用來確認欄位
//   TDX_CLIENT_ID=xxx TDX_CLIENT_SECRET=yyy node scripts/fetch_seats.mjs           # 產生 site/data/*.json
//
// 輸出：
//   site/data/index.json        { fetchedAt, today, dates: [...] }
//   site/data/YYYY-MM-DD.json   { date, fetchedAt, sourceUpdateTime, trips, arrivals }
//
// 今天：車站看板型 /AvailableSeatStatusList（每次執行都重抓，約每 10 分鐘更新）。
// 未來 1~27 天：OD 型 /AvailableSeatStatus/Train/OD/TrainDate/{日期} + /DailyTimetable/TrainDate/{日期}。
// TDX 只在每天 10、16、22 時更新未來日期，所以結果存在 .cache/future（由 Actions cache 保存），
// 過了更新時間點才重抓，避免每次執行都打幾十支 API。

import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';

const BASE = 'https://tdx.transportdata.tw/api/basic/v2/Rail/THSR';
const TOKEN_URL =
  'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const SEAT_PATH = process.env.SEAT_PATH ?? '/AvailableSeatStatusList';
const DAYS_AHEAD = Number(process.env.DAYS_AHEAD ?? 27); // 高鐵最多開放 D+27
const REQUEST_GAP_MS = 1000; // TDX 對短時間連續呼叫會回 429，請求之間留間隔
const CACHE_DIR = '.cache/future';
const OUT_DIR = 'site/data';
const REFRESH_SLOTS = [10 * 60 + 30, 16 * 60 + 30, 22 * 60 + 30]; // 台北時間（分鐘），TDX 更新時間後 30 分

const { TDX_CLIENT_ID, TDX_CLIENT_SECRET } = process.env;
if (!TDX_CLIENT_ID || !TDX_CLIENT_SECRET) {
  console.error('請設定環境變數 TDX_CLIENT_ID 與 TDX_CLIENT_SECRET');
  process.exit(1);
}
const PROBE = process.argv.includes('--probe');
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

// 被限流（429）時等一下再試
async function getJson(path, token) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}${path}?%24format=JSON`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    if (res.status === 429 && attempt < 3) {
      await sleep(5000 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      const err = new Error(`${path} 失敗：${res.status} ${(await res.text()).slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
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
// 最近一次「該重抓未來日期」的時間點（epoch ms）
function latestRefreshSlotMs() {
  const tp = taipeiNow();
  const today = ymd(tp);
  const minutes = tp.getUTCHours() * 60 + tp.getUTCMinutes();
  const toMs = (date, min) => Date.parse(`${date}T00:00:00Z`) + (min - 8 * 60) * 60000;
  const passed = REFRESH_SLOTS.filter((m) => m <= minutes);
  return passed.length
    ? toMs(today, passed.at(-1))
    : toMs(addDays(today, -1), REFRESH_SLOTS.at(-1));
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
function buildTripsFromOD(raw, timetable) {
  const list = Array.isArray(raw) ? raw : raw.AvailableSeats ?? [];
  const groups = new Map(); // `${no}|${from}` -> trip
  for (const item of list) {
    const no = String(item.TrainNo);
    const from = item.OriginStationID;
    const dep = timetable.departures[no]?.[from];
    if (!dep) continue; // 時刻表對不到就略過
    const key = `${no}|${from}`;
    if (!groups.has(key)) groups.set(key, { no, from, dep, to: [] });
    groups.get(key).to.push({
      id: item.DestinationStationID,
      s: status(item.StandardSeatStatus),
      b: status(item.BusinessSeatStatus),
    });
  }
  return [...groups.values()];
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

async function fetchFutureDay(date, token) {
  const seatRaw = await getJson(`/AvailableSeatStatus/Train/OD/TrainDate/${date}`, token);
  await sleep(REQUEST_GAP_MS);
  const timetableRaw = await getJson(`/DailyTimetable/TrainDate/${date}`, token);
  const timetable = buildTimetable(timetableRaw);
  const trips = buildTripsFromOD(seatRaw, timetable);
  return {
    date,
    fetchedAt: new Date().toISOString(),
    sourceUpdateTime: seatRaw.UpdateTime ?? null,
    trips,
    arrivals: timetable.arrivals,
  };
}

const readJsonIfExists = async (p) => {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
};
const writeJson = (p, obj) => writeFile(p, JSON.stringify(obj));

// ---------- main ----------
const token = await getToken();
const today = ymd(taipeiNow());

if (PROBE) {
  const tomorrow = addDays(today, 1);
  const show = (title, v) => {
    console.log(`--- ${title} ---`);
    console.log(JSON.stringify(v, null, 2)?.slice(0, 1500));
  };
  show('今天 餘位', await getJson(SEAT_PATH, token));
  show('今天 時刻表', await getJson('/DailyTimetable/Today', token));
  show(`${tomorrow} OD 餘位`, await getJson(`/AvailableSeatStatus/Train/OD/TrainDate/${tomorrow}`, token));
  show(`${tomorrow} 時刻表`, await getJson(`/DailyTimetable/TrainDate/${tomorrow}`, token));
  process.exit(0);
}

await mkdir(OUT_DIR, { recursive: true });
await mkdir(CACHE_DIR, { recursive: true });

// 1) 今天：一定要成功，否則讓 workflow 失敗，避免部署空資料
const seatRaw = await getJson(SEAT_PATH, token);
let timetable = { arrivals: {}, departures: {} };
await sleep(REQUEST_GAP_MS);
try {
  timetable = buildTimetable(await getJson('/DailyTimetable/Today', token));
} catch (e) {
  console.warn(`今天的時刻表抓取失敗，將不顯示抵達時間：${e.message}`);
}
const todayTrips = buildTripsFromBoard(seatRaw);
if (todayTrips.length === 0) {
  throw new Error('今天沒有任何班次，請用 --probe 檢查端點與欄位');
}
await writeJson(`${OUT_DIR}/${today}.json`, {
  date: today,
  fetchedAt: new Date().toISOString(),
  sourceUpdateTime: seatRaw.UpdateTime ?? null,
  trips: todayTrips,
  arrivals: timetable.arrivals,
});

// 2) 未來日期：失敗就沿用快取，沒快取就略過該天
const dates = [today];
const slotMs = latestRefreshSlotMs();
let refetched = 0;
let rateLimited = false;
for (let i = 1; i <= DAYS_AHEAD; i++) {
  const date = addDays(today, i);
  const cachePath = `${CACHE_DIR}/${date}.json`;
  let day = await readJsonIfExists(cachePath);
  const stale = !day || Date.parse(day.fetchedAt) < slotMs;
  if (stale && !rateLimited) {
    try {
      const fresh = await fetchFutureDay(date, token);
      if (fresh.trips.length > 0) {
        day = fresh;
        await writeJson(cachePath, day);
        refetched++;
      }
      await sleep(REQUEST_GAP_MS);
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
for (const f of await readdir(CACHE_DIR)) {
  if (f.slice(0, 10) <= today) await rm(`${CACHE_DIR}/${f}`);
}

await writeJson(`${OUT_DIR}/index.json`, { fetchedAt: new Date().toISOString(), today, dates });
console.log(
  `完成：今天 ${todayTrips.length} 筆起站班次；未來日期共 ${dates.length - 1} 天（本次重抓 ${refetched} 天${rateLimited ? '，遇到限流，其餘下次補抓' : ''}）`,
);
