// scripts/fetch_seats.mjs  (Node 20+，不需要任何套件)
//
// 用法：
//   TDX_CLIENT_ID=xxx TDX_CLIENT_SECRET=yyy node scripts/fetch_seats.mjs --probe   # 只印出 API 原始回傳前段，用來確認欄位
//   TDX_CLIENT_ID=xxx TDX_CLIENT_SECRET=yyy node scripts/fetch_seats.mjs           # 產生 site/seats.json
//
// 餘位端點 /AvailableSeatStatusList 已實測（車站看板型，一次回傳全部車站與車次）。

import { mkdir, writeFile } from 'node:fs/promises';

const BASE = 'https://tdx.transportdata.tw/api/basic/v2/Rail/THSR';
const TOKEN_URL =
  'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const SEAT_PATH = process.env.SEAT_PATH ?? '/AvailableSeatStatusList';
const TIMETABLE_PATH = '/DailyTimetable/Today';

const { TDX_CLIENT_ID, TDX_CLIENT_SECRET } = process.env;
if (!TDX_CLIENT_ID || !TDX_CLIENT_SECRET) {
  console.error('請設定環境變數 TDX_CLIENT_ID 與 TDX_CLIENT_SECRET');
  process.exit(1);
}
const PROBE = process.argv.includes('--probe');

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

async function getJson(path, token) {
  const res = await fetch(`${BASE}${path}?%24format=JSON`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`${path} 失敗：${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
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

// 餘位 API 是車站看板型：每筆 = 某班車從 StationID 出發，StopStations 是到各目的站的餘位（OD 直接給）。
function buildTrips(raw) {
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

// 時刻表只用來補抵達時間，欄位尚未驗證，所以抓不到就略過。
function buildArrivals(raw) {
  const list = Array.isArray(raw) ? raw : raw?.TrainTimetables ?? [];
  const out = {};
  for (const item of list) {
    const no = String(item.DailyTrainInfo?.TrainNo ?? item.TrainInfo?.TrainNo ?? '');
    if (!no) continue;
    out[no] = {};
    for (const st of item.StopTimes ?? []) {
      out[no][st.StationID] = st.ArrivalTime ?? st.DepartureTime;
    }
  }
  return out;
}

// ---------- main ----------
const token = await getToken();
const seatRaw = await getJson(SEAT_PATH, token);

let timetableRaw = null;
try {
  timetableRaw = await getJson(TIMETABLE_PATH, token);
} catch (e) {
  console.warn(`時刻表抓取失敗，將不顯示抵達時間：${e.message}`);
}

if (PROBE) {
  console.log('--- seat ---');
  console.log(JSON.stringify(seatRaw, null, 2).slice(0, 1800));
  console.log('--- timetable ---');
  console.log(JSON.stringify(timetableRaw, null, 2)?.slice(0, 1800));
  process.exit(0);
}

const trips = buildTrips(seatRaw);
const arrivals = timetableRaw ? buildArrivals(timetableRaw) : {};

// 沒抓到班次就讓 workflow 失敗，避免把空資料部署上去
if (trips.length === 0) {
  throw new Error('沒有任何班次，請用 --probe 檢查端點與欄位');
}

await mkdir('site', { recursive: true });
await writeFile(
  'site/seats.json',
  JSON.stringify({
    fetchedAt: new Date().toISOString(),
    sourceUpdateTime: seatRaw.UpdateTime ?? null,
    trips,
    arrivals,
  }),
);
console.log(`完成：${trips.length} 筆起站班次，時刻表 ${Object.keys(arrivals).length} 班車`);
