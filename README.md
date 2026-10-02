# 高鐵餘票查詢

用 TDX API 查詢高鐵剩餘座位（今天起 28 天內），GitHub Actions 定時抓資料並部署到 GitHub Pages。

## 本機開發

```bash
# 沒有金鑰：產生假資料
node scripts/mock_seats.mjs            # 產生 site/data/ 下 8 天的假資料

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
