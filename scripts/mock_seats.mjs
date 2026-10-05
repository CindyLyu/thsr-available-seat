// 產生假資料到 site/data/（格式同 fetch_seats.mjs），僅用於本機檢查前端。
import { mkdir, writeFile } from 'node:fs/promises';

const IDS = ['0990', '1000', '1010', '1020', '1030', '1035', '1040', '1043', '1047', '1050', '1060', '1070'];
const pick = (i) => ['O', 'O', 'L', 'X', null][((i % 5) + 5) % 5];
const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const DAYS = 15; // 今天 + 未來 14 天

const today = new Date(Date.now() + 8 * 3600e3);
const ymd = (d) => d.toISOString().slice(0, 10);

function makeDay(seed) {
  const trips = [];
  const arrivals = {};
  for (let n = 0; n < 60; n++) {
    const no = String(100 + n);
    const ids = n % 2 === 0 ? IDS : [...IDS].reverse();
    const start = 6 * 60 + Math.floor(n / 2) * 30;
    arrivals[no] = {};
    ids.forEach((id, k) => { arrivals[no][id] = hhmm(start + k * 12); });
    ids.forEach((id, k) => {
      if (k === ids.length - 1) return;
      trips.push({
        no, from: id, dep: hhmm(start + k * 12 + 1),
        to: ids.slice(k + 1).map((d, j) => ({ id: d, s: pick(n + k + j + seed), b: pick(n * 2 + k + j + 1 + seed) })),
      });
    });
  }
  return { trips, arrivals };
}

await mkdir('site/data', { recursive: true });
const dates = [];
for (let i = 0; i < DAYS; i++) {
  const d = new Date(today);
  d.setUTCDate(d.getUTCDate() + i);
  const date = ymd(d);
  dates.push(date);
  await writeFile(`site/data/${date}.json`, JSON.stringify({
    date, fetchedAt: new Date().toISOString(), sourceUpdateTime: null, ...makeDay(i),
  }));
}
await writeFile('site/data/index.json', JSON.stringify({
  fetchedAt: new Date().toISOString(), today: dates[0], dates,
}));
console.log(`mock 完成：${dates.length} 天`);
