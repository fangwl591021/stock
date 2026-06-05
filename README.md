# 股市分析 Worker 工具

第一版 MVP：使用 Cloudflare Worker + D1 建立自選股與簡單技術分析工具。

## 功能

- 新增 / 更新自選股
- 刪除自選股
- 從 Yahoo Finance chart API 抓 6 個月日線資料
- 計算 MA5、MA20、MA60、RSI14、MACD、量能比
- 產生 0-100 分與偏多 / 中性 / 偏弱摘要
- 將分析紀錄寫入 D1

## 檔案

- `src/worker.js`：Worker API 與前端頁面
- `schema.sql`：D1 資料表
- `wrangler.toml`：Cloudflare Worker 設定
- `package.json`：Wrangler 指令

## 建立 D1

```bash
npm install
npm run db:create
```

Cloudflare 會回傳 `database_id`。把它填入 `wrangler.toml`：

```toml
database_id = "你的 database_id"
```

## 建立資料表

本機：

```bash
npm run db:migrate:local
```

遠端：

```bash
npm run db:migrate:remote
```

## 本機開發

```bash
npm run dev
```

開啟 Wrangler 顯示的 localhost 網址。

## 部署

```bash
npm run deploy
```

## 注意

這是分析工具，不是投資建議。Yahoo Finance 來源適合第一版驗證，正式產品應補上資料快取、錯誤重試、資料來源備援與權限控管。
