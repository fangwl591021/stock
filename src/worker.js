const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/") {
        return htmlResponse(INDEX_HTML);
      }

      if (url.pathname === "/api/health") {
        return jsonResponse({ ok: true, service: "stock-analysis-worker" });
      }

      if (url.pathname === "/api/stocks" && request.method === "GET") {
        return listStocks(env);
      }

      if (url.pathname === "/api/stocks" && request.method === "POST") {
        return addStock(request, env);
      }

      if (url.pathname.startsWith("/api/stocks/") && request.method === "DELETE") {
        const symbol = decodeURIComponent(url.pathname.replace("/api/stocks/", ""));
        return deleteStock(symbol, env);
      }

      if (url.pathname === "/api/analyze" && request.method === "POST") {
        return analyzeFromRequest(request, env);
      }

      if (url.pathname.startsWith("/api/analysis/") && request.method === "GET") {
        const symbol = decodeURIComponent(url.pathname.replace("/api/analysis/", ""));
        return getAnalysis(symbol, env);
      }

      return jsonResponse({ error: "Not found" }, 404);
    } catch (error) {
      return jsonResponse({ error: error.message || "Internal error" }, 500);
    }
  }
};

async function listStocks(env) {
  requireDb(env);

  const stocks = await env.DB.prepare(`
    SELECT
      w.id,
      w.symbol,
      w.name,
      w.market,
      w.note,
      w.created_at,
      a.price,
      a.change_percent,
      a.score,
      a.trend,
      a.summary,
      a.created_at AS analyzed_at
    FROM watchlist w
    LEFT JOIN analysis_runs a
      ON a.id = (
        SELECT id FROM analysis_runs
        WHERE symbol = w.symbol
        ORDER BY created_at DESC
        LIMIT 1
      )
    ORDER BY w.created_at DESC
  `).all();

  return jsonResponse({ stocks: stocks.results || [] });
}

async function addStock(request, env) {
  requireDb(env);
  const body = await request.json();
  const symbol = normalizeSymbol(body.symbol);
  const market = normalizeMarket(body.market || "tw");
  const name = cleanText(body.name || "");
  const note = cleanText(body.note || "");

  if (!symbol) {
    return jsonResponse({ error: "symbol is required" }, 400);
  }

  await env.DB.prepare(`
    INSERT INTO watchlist(symbol, name, market, note)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(symbol) DO UPDATE SET
      name = excluded.name,
      market = excluded.market,
      note = excluded.note,
      updated_at = CURRENT_TIMESTAMP
  `).bind(symbol, name, market, note).run();

  return jsonResponse({ ok: true, symbol, market });
}

async function deleteStock(symbol, env) {
  requireDb(env);
  const normalized = normalizeSymbol(symbol);

  await env.DB.prepare("DELETE FROM watchlist WHERE symbol = ?").bind(normalized).run();
  return jsonResponse({ ok: true, symbol: normalized });
}

async function analyzeFromRequest(request, env) {
  requireDb(env);
  const body = await request.json();
  const symbol = normalizeSymbol(body.symbol);

  if (!symbol) {
    return jsonResponse({ error: "symbol is required" }, 400);
  }

  const stock = await env.DB.prepare("SELECT symbol, market FROM watchlist WHERE symbol = ?")
    .bind(symbol)
    .first();

  const market = normalizeMarket(body.market || stock?.market || "tw");
  const analysis = await analyzeStock(symbol, market);

  await env.DB.prepare(`
    INSERT INTO analysis_runs(
      symbol, market, source_symbol, price, change_percent, volume,
      ma5, ma20, ma60, rsi14, macd, macd_signal, volume_ratio,
      score, trend, summary, raw_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    symbol,
    market,
    analysis.sourceSymbol,
    analysis.price,
    analysis.changePercent,
    analysis.volume,
    analysis.ma5,
    analysis.ma20,
    analysis.ma60,
    analysis.rsi14,
    analysis.macd,
    analysis.macdSignal,
    analysis.volumeRatio,
    analysis.score,
    analysis.trend,
    analysis.summary,
    JSON.stringify(analysis.raw)
  ).run();

  return jsonResponse({ ok: true, analysis });
}

async function getAnalysis(symbol, env) {
  requireDb(env);
  const normalized = normalizeSymbol(symbol);

  const rows = await env.DB.prepare(`
    SELECT * FROM analysis_runs
    WHERE symbol = ?
    ORDER BY created_at DESC
    LIMIT 20
  `).bind(normalized).all();

  return jsonResponse({ symbol: normalized, analyses: rows.results || [] });
}

async function analyzeStock(symbol, market) {
  const sourceSymbol = toYahooSymbol(symbol, market);
  const candles = await fetchYahooCandles(sourceSymbol);

  if (candles.length < 25) {
    throw new Error("not enough price data");
  }

  const closes = candles.map((item) => item.close);
  const volumes = candles.map((item) => item.volume || 0);
  const latest = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const ma5 = sma(closes, 5);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const rsi14 = rsi(closes, 14);
  const macdResult = macd(closes);
  const volumeAvg20 = average(volumes.slice(-20));
  const volumeRatio = volumeAvg20 ? latest.volume / volumeAvg20 : null;
  const changePercent = previous.close
    ? ((latest.close - previous.close) / previous.close) * 100
    : 0;
  const scored = scoreAnalysis({
    price: latest.close,
    ma5,
    ma20,
    ma60,
    rsi14,
    macdValue: macdResult.macd,
    macdSignal: macdResult.signal,
    volumeRatio,
    changePercent
  });

  return {
    symbol,
    market,
    sourceSymbol,
    price: round(latest.close),
    changePercent: round(changePercent),
    volume: latest.volume,
    ma5: round(ma5),
    ma20: round(ma20),
    ma60: round(ma60),
    rsi14: round(rsi14),
    macd: round(macdResult.macd),
    macdSignal: round(macdResult.signal),
    volumeRatio: round(volumeRatio),
    score: scored.score,
    trend: scored.trend,
    summary: scored.summary,
    raw: {
      date: latest.date,
      candleCount: candles.length
    }
  };
}

async function fetchYahooCandles(sourceSymbol) {
  const endpoint = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sourceSymbol)}?range=6mo&interval=1d`;
  const response = await fetch(endpoint, {
    headers: {
      "User-Agent": "stock-analysis-worker/0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`Yahoo request failed: ${response.status}`);
  }

  const data = await response.json();
  const result = data.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0];

  if (!result || !quote) {
    throw new Error("Yahoo response missing chart data");
  }

  return timestamps
    .map((timestamp, index) => ({
      date: new Date(timestamp * 1000).toISOString().slice(0, 10),
      open: quote.open?.[index],
      high: quote.high?.[index],
      low: quote.low?.[index],
      close: quote.close?.[index],
      volume: quote.volume?.[index] || 0
    }))
    .filter((item) => Number.isFinite(item.close));
}

function scoreAnalysis(input) {
  let score = 50;
  const reasons = [];

  if (input.price > input.ma20) {
    score += 12;
    reasons.push("股價站上 MA20");
  } else {
    score -= 12;
    reasons.push("股價跌破 MA20");
  }

  if (input.ma5 > input.ma20) {
    score += 10;
    reasons.push("短均線強於中期均線");
  } else {
    score -= 8;
    reasons.push("短均線弱於中期均線");
  }

  if (input.ma20 && input.ma60 && input.ma20 > input.ma60) {
    score += 8;
    reasons.push("MA20 高於 MA60");
  }

  if (input.rsi14 >= 45 && input.rsi14 <= 70) {
    score += 8;
    reasons.push("RSI 位於健康區間");
  } else if (input.rsi14 > 75) {
    score -= 8;
    reasons.push("RSI 偏熱");
  } else if (input.rsi14 < 35) {
    score -= 8;
    reasons.push("RSI 偏弱");
  }

  if (input.macdValue > input.macdSignal) {
    score += 8;
    reasons.push("MACD 高於 signal");
  } else {
    score -= 6;
    reasons.push("MACD 低於 signal");
  }

  if (input.volumeRatio >= 1.5 && input.changePercent > 0) {
    score += 8;
    reasons.push("上漲且量能放大");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  const trend = score >= 70 ? "偏多" : score >= 45 ? "中性" : "偏弱";
  const summary = `${trend}，分數 ${score}。${reasons.slice(0, 4).join("；")}。`;

  return { score, trend, summary };
}

function sma(values, period) {
  if (values.length < period) return null;
  return average(values.slice(-period));
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function rsi(values, period) {
  if (values.length <= period) return null;

  const slice = values.slice(-(period + 1));
  let gains = 0;
  let losses = 0;

  for (let index = 1; index < slice.length; index += 1) {
    const diff = slice[index] - slice[index - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  if (losses === 0) return 100;
  const relativeStrength = gains / period / (losses / period);
  return 100 - 100 / (1 + relativeStrength);
}

function macd(values) {
  const ema12 = emaSeries(values, 12);
  const ema26 = emaSeries(values, 26);
  const macdSeries = ema12
    .map((value, index) => {
      const slow = ema26[index];
      return Number.isFinite(value) && Number.isFinite(slow) ? value - slow : null;
    })
    .filter(Number.isFinite);
  const signalSeries = emaSeries(macdSeries, 9);

  return {
    macd: macdSeries[macdSeries.length - 1] || null,
    signal: signalSeries[signalSeries.length - 1] || null
  };
}

function emaSeries(values, period) {
  const multiplier = 2 / (period + 1);
  const result = [];
  let previous = null;

  values.forEach((value) => {
    if (!Number.isFinite(value)) {
      result.push(null);
      return;
    }

    previous = previous === null ? value : value * multiplier + previous * (1 - multiplier);
    result.push(previous);
  });

  return result;
}

function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

function normalizeMarket(market) {
  const value = String(market || "tw").trim().toLowerCase();
  return ["tw", "us"].includes(value) ? value : "tw";
}

function cleanText(value) {
  return String(value || "").trim().slice(0, 200);
}

function toYahooSymbol(symbol, market) {
  if (market === "us") return symbol;
  if (/^\d{4}$/.test(symbol)) return `${symbol}.TW`;
  return symbol;
}

function round(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

function requireDb(env) {
  if (!env.DB) {
    throw new Error("D1 binding DB is not configured");
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS
  });
}

function htmlResponse(html) {
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

const INDEX_HTML = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>股市分析工具</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #1f2937;
      --muted: #667085;
      --line: #d9dee7;
      --accent: #0f766e;
      --accent-dark: #115e59;
      --danger: #b42318;
      --weak: #93370d;
      --ok: #067647;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Arial, "Microsoft JhengHei", sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    header {
      background: var(--panel);
      border-bottom: 1px solid var(--line);
      padding: 18px 24px;
    }
    h1 {
      margin: 0;
      font-size: 24px;
      letter-spacing: 0;
    }
    main {
      max-width: 1160px;
      margin: 0 auto;
      padding: 24px;
    }
    .toolbar {
      display: grid;
      grid-template-columns: 1fr 1fr 120px auto;
      gap: 10px;
      align-items: end;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
    }
    label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 13px;
    }
    input, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 10px 12px;
      font-size: 15px;
      background: #fff;
      color: var(--text);
    }
    button {
      border: 0;
      border-radius: 6px;
      padding: 11px 14px;
      font-size: 15px;
      cursor: pointer;
      background: var(--accent);
      color: #fff;
      min-height: 42px;
    }
    button:hover { background: var(--accent-dark); }
    button.secondary {
      background: #e7eef0;
      color: #164e63;
    }
    button.secondary:hover { background: #d4e3e6; }
    button.danger {
      background: #fee4e2;
      color: var(--danger);
    }
    button.danger:hover { background: #fecdca; }
    .status {
      min-height: 24px;
      margin: 0 0 12px;
      color: var(--muted);
      font-size: 14px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }
    th, td {
      padding: 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
      font-size: 14px;
    }
    th {
      color: var(--muted);
      background: #f9fafb;
      font-weight: 700;
    }
    tr:last-child td { border-bottom: 0; }
    .symbol {
      font-weight: 700;
      font-size: 15px;
    }
    .muted {
      color: var(--muted);
      font-size: 13px;
    }
    .badge {
      display: inline-block;
      min-width: 52px;
      border-radius: 999px;
      padding: 4px 9px;
      font-weight: 700;
      text-align: center;
      background: #eef2f6;
    }
    .bull { color: var(--ok); background: #dcfae6; }
    .flat { color: #175cd3; background: #d1e9ff; }
    .weak { color: var(--weak); background: #fef0c7; }
    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .empty {
      background: var(--panel);
      border: 1px dashed var(--line);
      border-radius: 8px;
      padding: 32px;
      text-align: center;
      color: var(--muted);
    }
    @media (max-width: 820px) {
      main { padding: 16px; }
      .toolbar { grid-template-columns: 1fr; }
      table, thead, tbody, th, td, tr { display: block; }
      thead { display: none; }
      tr {
        border-bottom: 1px solid var(--line);
        padding: 12px;
      }
      td {
        border-bottom: 0;
        padding: 6px 0;
      }
      td::before {
        content: attr(data-label);
        display: block;
        color: var(--muted);
        font-size: 12px;
        margin-bottom: 2px;
      }
    }
  </style>
</head>
<body>
  <header>
    <h1>股市分析工具</h1>
  </header>
  <main>
    <form class="toolbar" id="stock-form">
      <label>股票代號
        <input id="symbol" placeholder="例如 2330 或 AAPL" autocomplete="off" required>
      </label>
      <label>股票名稱
        <input id="name" placeholder="例如 台積電" autocomplete="off">
      </label>
      <label>市場
        <select id="market">
          <option value="tw">台股</option>
          <option value="us">美股</option>
        </select>
      </label>
      <button type="submit">新增 / 更新</button>
    </form>

    <p class="status" id="status"></p>
    <section id="content"></section>
  </main>

  <script>
    const form = document.querySelector("#stock-form");
    const statusEl = document.querySelector("#status");
    const contentEl = document.querySelector("#content");

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = {
        symbol: document.querySelector("#symbol").value,
        name: document.querySelector("#name").value,
        market: document.querySelector("#market").value
      };

      await api("/api/stocks", {
        method: "POST",
        body: JSON.stringify(payload)
      });

      form.reset();
      await loadStocks();
    });

    async function loadStocks() {
      setStatus("讀取自選股...");
      const data = await api("/api/stocks");
      renderStocks(data.stocks || []);
      setStatus("");
    }

    async function analyze(symbol) {
      setStatus("分析 " + symbol + "...");
      await api("/api/analyze", {
        method: "POST",
        body: JSON.stringify({ symbol })
      });
      await loadStocks();
    }

    async function removeStock(symbol) {
      if (!confirm("刪除 " + symbol + "？")) return;
      await api("/api/stocks/" + encodeURIComponent(symbol), { method: "DELETE" });
      await loadStocks();
    }

    async function api(path, options = {}) {
      const response = await fetch(path, {
        headers: { "Content-Type": "application/json" },
        ...options
      });
      const data = await response.json();
      if (!response.ok) {
        setStatus(data.error || "API 錯誤");
        throw new Error(data.error || "API error");
      }
      return data;
    }

    function renderStocks(stocks) {
      if (!stocks.length) {
        contentEl.innerHTML = '<div class="empty">尚未加入自選股</div>';
        return;
      }

      const rows = stocks.map((stock) => {
        const trendClass = stock.trend === "偏多" ? "bull" : stock.trend === "偏弱" ? "weak" : "flat";
        const price = stock.price == null ? "-" : stock.price;
        const change = stock.change_percent == null ? "-" : stock.change_percent + "%";
        const score = stock.score == null ? "-" : stock.score;
        const trend = stock.trend || "未分析";
        const summary = stock.summary || "尚未產生分析";
        const analyzedAt = stock.analyzed_at || "-";

        return '<tr>' +
          '<td data-label="股票"><div class="symbol">' + escapeHtml(stock.symbol) + '</div><div class="muted">' + escapeHtml(stock.name || "") + '</div></td>' +
          '<td data-label="市場">' + (stock.market === "us" ? "美股" : "台股") + '</td>' +
          '<td data-label="價格">' + price + '</td>' +
          '<td data-label="漲跌">' + change + '</td>' +
          '<td data-label="分數"><span class="badge ' + trendClass + '">' + score + '</span></td>' +
          '<td data-label="趨勢"><span class="badge ' + trendClass + '">' + trend + '</span></td>' +
          '<td data-label="摘要">' + escapeHtml(summary) + '<div class="muted">' + analyzedAt + '</div></td>' +
          '<td data-label="操作"><div class="actions"><button class="secondary" onclick="analyze(\\'' + escapeJs(stock.symbol) + '\\')">分析</button><button class="danger" onclick="removeStock(\\'' + escapeJs(stock.symbol) + '\\')">刪除</button></div></td>' +
        '</tr>';
      }).join("");

      contentEl.innerHTML = '<table><thead><tr><th>股票</th><th>市場</th><th>價格</th><th>漲跌</th><th>分數</th><th>趨勢</th><th>摘要</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }

    function setStatus(message) {
      statusEl.textContent = message;
    }

    function escapeHtml(value) {
      return String(value || "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[char]);
    }

    function escapeJs(value) {
      return String(value || "").replace(/\\\\/g, "\\\\\\\\").replace(/'/g, "\\\\'");
    }

    loadStocks().catch((error) => setStatus(error.message));
  </script>
</body>
</html>`;
