# 高鐵餘票查詢

用 TDX API 查詢高鐵剩餘座位（今天起兩週內），GitHub Actions 定時抓資料並部署到 GitHub Pages。

## 本機開發

```bash
# 沒有金鑰：產生假資料
node scripts/mock_seats.mjs            # 產生 site/data/ 下 15 天的假資料

# 有金鑰：先 probe 看 API 原始回傳，再產生真實資料
export TDX_CLIENT_ID=... TDX_CLIENT_SECRET=...
node scripts/fetch_seats.mjs --probe
node scripts/fetch_seats.mjs

# 預覽前端
python3 -m http.server 8080 -d site
```

## 部署

1. 在 repo 設定 Secrets：`TDX_CLIENT_ID`、`TDX_CLIENT_SECRET`
2. Settings → Pages → Source 選 GitHub Actions
3. 到 Actions 手動執行 `fetch-and-deploy`

## TDX 額度（基礎會員）

基礎會員每月只有 3 點，且每分鐘最多 5 次呼叫（點數 = 呼叫次數 / 1500 + 傳輸量 MB / 150）。腳本因此：

- 今天的餘位每 30 分鐘抓一次，只在台北 06:00 之後；時刻表每天只抓一次並快取。
- 未來 14 天：近 3 天每天更新 3 次，更遠的每天更新 1 次；OD 餘位用 `$select` 只取需要的欄位。
- 每次呼叫之間間隔 13 秒（`REQUEST_GAP_MS`）。`DAYS_AHEAD`、`NEAR_DAYS` 可用環境變數調整。
- 估算每月約 1.5 到 2 點，到 TDX 會員中心的「點數用量」確認實際用量。
