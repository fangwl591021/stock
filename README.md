# 股市分析 Worker 平台

使用 Cloudflare Worker + D1 建立可部署、可維護的股市分析平台。

## 功能

- 新增 / 更新自選股
- 刪除自選股
- 從 Yahoo Finance chart API 抓 6 個月日線資料
- 計算 MA5、MA20、MA60、RSI14、MACD、量能比
- 產生 0-100 分與偏多 / 中性 / 偏弱摘要
- 將分析紀錄寫入 D1
- 批次分析全部自選股
- 單股明細與近 90 日收盤線圖
- AI 總覽報告與單股報告
- 系統事件紀錄
- Cloudflare scheduled trigger 自動分析

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

目前 live URL：

```text
https://stock.fangwl591021.workers.dev/
```

## OpenAI AI 報告

Cloudflare Worker 需要有 secret：

```text
OPENAI_API_KEY
```

如果 health API 顯示 `hasOpenAI:false`，請到 Cloudflare Worker 的「變數和祕密」確認名稱是否完全等於 `OPENAI_API_KEY`。不要在名稱前後多空白。

可選模型設定：

```text
OPENAI_MODEL=gpt-4.1-mini
```

若未設定 `OPENAI_MODEL`，Worker 預設使用 `gpt-4.1-mini`。

## 排程

`wrangler.toml` 已設定：

```toml
[triggers]
crons = ["10 23 * * 1-5"]
```

這代表 UTC 週一到週五 23:10 執行，約等於台灣時間週二到週六 07:10。用途是每天早上自動更新自選股技術分析。

## API

- `GET /api/dashboard`
- `GET /api/stocks`
- `POST /api/stocks`
- `DELETE /api/stocks/:symbol`
- `POST /api/analyze`
- `POST /api/analyze-all`
- `GET /api/analysis/:symbol`
- `GET /api/candles/:symbol`
- `POST /api/ai-report`
- `GET /api/ai-report`
- `GET /api/events`

## 注意

這是分析工具，不是投資建議。Yahoo Finance 來源適合第一版驗證，正式產品應補上資料快取、錯誤重試、資料來源備援、權限控管與更完整的基本面/籌碼資料。
