const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

const MAX_BATCH_SIZE = 40;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/") {
        return htmlResponse(INDEX_HTML);
      }

      if (url.pathname === "/api/health") {
        return jsonResponse({
          ok: true,
          service: "stock-analysis-platform",
          hasOpenAI: Boolean(getOpenAIKey(env))
        });
      }

      if (url.pathname === "/api/dashboard" && request.method === "GET") {
        return getDashboard(env);
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

      if (url.pathname === "/api/analyze-all" && request.method === "POST") {
        const result = await analyzeAll(env, "manual");
        return jsonResponse(result);
      }

      if (url.pathname.startsWith("/api/analysis/") && request.method === "GET") {
        const symbol = decodeURIComponent(url.pathname.replace("/api/analysis/", ""));
        return getAnalysis(symbol, env);
      }

      if (url.pathname.startsWith("/api/candles/") && request.method === "GET") {
        const symbol = decodeURIComponent(url.pathname.replace("/api/candles/", ""));
        const market = url.searchParams.get("market");
        return getCandles(symbol, market, env);
      }

      if (url.pathname === "/api/ai-report" && request.method === "POST") {
        return createAiReport(request, env);
      }

      if (url.pathname === "/api/ai-report" && request.method === "GET") {
        return getAiReports(url, env);
      }

      if (url.pathname === "/api/jensen-report" && request.method === "POST") {
        return createJensenReport(env);
      }

      if (url.pathname === "/api/events" && request.method === "GET") {
        return getSystemEvents(env);
      }

      return jsonResponse({ error: "Not found" }, 404);
    } catch (error) {
      return jsonResponse({ error: error.message || "Internal error" }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(analyzeAll(env, "scheduled"));
  }
};

async function getDashboard(env) {
  requireDb(env);
  const stocks = await getStocksWithLatest(env);
  const latestReport = await env.DB.prepare(`
    SELECT id, scope, symbol, model, report, created_at
    FROM ai_reports
    ORDER BY created_at DESC
    LIMIT 1
  `).first();
  const events = await getRecentEvents(env, 5);
  const analyzed = stocks.filter((stock) => stock.score !== null && stock.score !== undefined);
  const stats = {
    total: stocks.length,
    analyzed: analyzed.length,
    bullish: analyzed.filter((stock) => stock.trend === "偏多").length,
    neutral: analyzed.filter((stock) => stock.trend === "中性").length,
    weak: analyzed.filter((stock) => stock.trend === "偏弱").length,
    averageScore: analyzed.length ? round(average(analyzed.map((stock) => stock.score))) : null,
    updatedAt: analyzed[0]?.analyzed_at || null,
    hasOpenAI: Boolean(getOpenAIKey(env))
  };

  const leaders = [...analyzed].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5);
  const risks = [...analyzed].sort((a, b) => (a.score || 0) - (b.score || 0)).slice(0, 5);

  return jsonResponse({ stats, stocks, leaders, risks, latestReport, events });
}

async function listStocks(env) {
  requireDb(env);
  return jsonResponse({ stocks: await getStocksWithLatest(env) });
}

async function getStocksWithLatest(env) {
  const result = await env.DB.prepare(`
    SELECT
      w.id,
      w.symbol,
      w.name,
      w.market,
      w.note,
      w.created_at,
      w.updated_at,
      a.price,
      a.change_percent,
      a.volume,
      a.ma5,
      a.ma20,
      a.ma60,
      a.rsi14,
      a.macd,
      a.macd_signal,
      a.volume_ratio,
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
    ORDER BY
      CASE WHEN a.score IS NULL THEN 1 ELSE 0 END,
      a.score DESC,
      w.created_at DESC
  `).all();

  return result.results || [];
}

async function addStock(request, env) {
  requireDb(env);
  const body = await request.json();
  const symbol = normalizeSymbol(body.symbol);
  const market = normalizeMarket(body.market || "tw");
  const name = cleanText(body.name || "");
  const note = cleanText(body.note || "");

  if (!symbol) {
    return jsonResponse({ error: "請輸入股票代號" }, 400);
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
    return jsonResponse({ error: "請輸入股票代號" }, 400);
  }

  const stock = await findStock(env, symbol);
  const market = normalizeMarket(body.market || stock?.market || "tw");
  const analysis = await analyzeStock(symbol, market);
  await saveAnalysis(env, analysis);

  return jsonResponse({ ok: true, analysis });
}

async function analyzeAll(env, trigger) {
  requireDb(env);
  const stocks = await env.DB.prepare(`
    SELECT symbol, market
    FROM watchlist
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(MAX_BATCH_SIZE).all();

  const results = [];
  for (const stock of stocks.results || []) {
    try {
      const analysis = await analyzeStock(stock.symbol, stock.market);
      await saveAnalysis(env, analysis);
      results.push({ symbol: stock.symbol, ok: true, score: analysis.score, trend: analysis.trend });
    } catch (error) {
      results.push({ symbol: stock.symbol, ok: false, error: error.message });
    }
  }

  const okCount = results.filter((item) => item.ok).length;
  await logEvent(env, "analyze_all", okCount === results.length ? "ok" : "partial", `${trigger}: ${okCount}/${results.length} completed`, { trigger, results });

  return { ok: okCount === results.length, trigger, total: results.length, okCount, results };
}

async function saveAnalysis(env, analysis) {
  await env.DB.prepare(`
    INSERT INTO analysis_runs(
      symbol, market, source_symbol, price, change_percent, volume,
      ma5, ma20, ma60, rsi14, macd, macd_signal, volume_ratio,
      score, trend, summary, raw_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    analysis.symbol,
    analysis.market,
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
}

async function getAnalysis(symbol, env) {
  requireDb(env);
  const normalized = normalizeSymbol(symbol);
  const rows = await env.DB.prepare(`
    SELECT * FROM analysis_runs
    WHERE symbol = ?
    ORDER BY created_at DESC
    LIMIT 30
  `).bind(normalized).all();

  return jsonResponse({ symbol: normalized, analyses: rows.results || [] });
}

async function getCandles(symbol, requestedMarket, env) {
  requireDb(env);
  const normalized = normalizeSymbol(symbol);
  const stock = await findStock(env, normalized);
  const market = normalizeMarket(requestedMarket || stock?.market || "tw");
  const candles = await fetchYahooCandles(toYahooSymbol(normalized, market), "6mo");

  return jsonResponse({
    symbol: normalized,
    market,
    candles: candles.slice(-90)
  });
}

async function createAiReport(request, env) {
  requireDb(env);

  const apiKey = getOpenAIKey(env);
  if (!apiKey) {
    return jsonResponse({ error: "Cloudflare secret OPENAI_API_KEY 尚未設定或未部署到此 Worker" }, 400);
  }

  const body = await request.json();
  const scope = body.scope === "symbol" ? "symbol" : "portfolio";
  const symbol = scope === "symbol" ? normalizeSymbol(body.symbol) : null;

  const payload = scope === "symbol"
    ? await buildSymbolReportPayload(env, symbol)
    : await buildPortfolioReportPayload(env);

  const model = env.OPENAI_MODEL || "gpt-4.1-mini";
  const aiResult = await callOpenAI(apiKey, model, payload, { useWebSearch: true });

  await env.DB.prepare(`
    INSERT INTO ai_reports(scope, symbol, model, prompt_hash, report, source_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    scope,
    symbol,
    model,
    await digestText(JSON.stringify(payload).slice(0, 4096)),
    aiResult.report,
    JSON.stringify({ payload, sources: aiResult.sources, usedWebSearch: aiResult.usedWebSearch })
  ).run();

  await logEvent(env, "ai_report", "ok", `${scope}${symbol ? `:${symbol}` : ""}`, { model });
  return jsonResponse({ ok: true, scope, symbol, model, report: aiResult.report, sources: aiResult.sources, usedWebSearch: aiResult.usedWebSearch });
}

async function createJensenReport(env) {
  requireDb(env);

  const apiKey = getOpenAIKey(env);
  if (!apiKey) {
    return jsonResponse({ error: "Cloudflare secret OPENAI_API_KEY 尚未設定或未部署到此 Worker" }, 400);
  }

  const model = env.OPENAI_MODEL || "gpt-4.1-mini";
  const payload = buildJensenReportPayload();
  const aiResult = await callOpenAI(apiKey, model, payload, { useWebSearch: true });

  await env.DB.prepare(`
    INSERT INTO ai_reports(scope, symbol, model, prompt_hash, report, source_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    "jensen",
    null,
    model,
    await digestText(JSON.stringify(payload).slice(0, 4096)),
    aiResult.report,
    JSON.stringify({ payload, sources: aiResult.sources, usedWebSearch: aiResult.usedWebSearch })
  ).run();

  await logEvent(env, "jensen_report", "ok", "Jensen Huang tracker updated", {
    model,
    sources: aiResult.sources.length,
    usedWebSearch: aiResult.usedWebSearch
  });

  return jsonResponse({
    ok: true,
    scope: "jensen",
    model,
    report: aiResult.report,
    sources: aiResult.sources,
    usedWebSearch: aiResult.usedWebSearch
  });
}

async function getAiReports(url, env) {
  requireDb(env);
  const scope = url.searchParams.get("scope");
  const symbol = normalizeSymbol(url.searchParams.get("symbol"));
  const limit = Math.min(Number(url.searchParams.get("limit")) || 10, 30);
  const conditions = [];
  const binds = [];

  if (scope) {
    conditions.push("scope = ?");
    binds.push(scope);
  }

  if (symbol) {
    conditions.push("symbol = ?");
    binds.push(symbol);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await env.DB.prepare(`
    SELECT id, scope, symbol, model, report, created_at
    FROM ai_reports
    ${where}
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(...binds, limit).all();

  return jsonResponse({ reports: rows.results || [] });
}

async function buildPortfolioReportPayload(env) {
  const stocks = await getStocksWithLatest(env);
  const analyzed = stocks.filter((stock) => stock.score !== null && stock.score !== undefined);
  return {
    reportType: "portfolio",
    generatedAt: new Date().toISOString(),
    instruction: "請用繁體中文產出可操作但保守的股市觀察報告。請使用 web search 補充主要個股近期市場新聞與產業背景。近期新聞優先近 14 天，若資料不足可放寬到近 90 天，至少整理 3 則與清單股票或台股市場直接相關的新聞。不得宣稱保證獲利，不得直接叫使用者買賣。請分成：總覽、主要業務/產業背景、最近市場新聞、偏強名單、風險名單、明天觀察重點、資料限制。新聞請附來源名稱與日期，並說明和股價觀察的關聯。",
    webSearchQueries: analyzed.slice(0, 8).map((stock) => `${stock.name || stock.symbol} ${stock.symbol} 股價 新聞 法說 營收 近期`),
    stocks: analyzed.map(compactStockForPrompt)
  };
}

function buildJensenReportPayload() {
  return {
    reportType: "jensen_huang_tracker",
    generatedAt: new Date().toISOString(),
    instruction: [
      "請用繁體中文產出「黃仁勳追蹤區」報告。",
      "請使用 web search 搜尋最新資料，優先近 30 天，不足則放寬到近 180 天。",
      "請盡可能完整列出黃仁勳相關新聞、公開行程、演講、媒體採訪、供應鏈互動、拜訪或被報導互動過的公司/廠家。",
      "廠家不限於實體工廠，也包含供應鏈公司、代工廠、ODM、伺服器廠、散熱、電源、連接器、PCB、記憶體、晶圓代工、雲端服務商、機器人/AI PC/車用合作方。",
      "請列出概念股，優先台股，其次美股；每檔要給股票代號、市場、和黃仁勳/NVIDIA/AI 供應鏈的關聯理由。",
      "請避免把未證實傳聞寫成事實；若是市場傳聞，請標示為傳聞或市場解讀。",
      "請分成：1. 最新重點摘要；2. 黃仁勳最新新聞；3. 拜訪/互動過的廠家與關聯；4. NVIDIA/黃仁勳概念股清單；5. 需要明天追蹤的訊號；6. 資料限制。",
      "每則新聞或拜訪紀錄請附來源名稱與日期。"
    ].join("\n"),
    webSearchQueries: [
      "黃仁勳 最新 新聞 台灣 供應鏈 廠商 拜訪",
      "黃仁勳 拜訪 廠商 台積電 鴻海 廣達 緯創 緯穎 英業達 技嘉 華碩",
      "Jensen Huang latest news NVIDIA Taiwan suppliers visit",
      "NVIDIA supply chain Taiwan stocks Jensen Huang concept stocks",
      "黃仁勳 概念股 NVIDIA 伺服器 散熱 電源 連接器 PCB 台股"
    ],
    seedConceptStocks: JENSEN_CONCEPT_STOCKS
  };
}

const JENSEN_CONCEPT_STOCKS = [
  { symbol: "2330", market: "tw", name: "台積電", link: "NVIDIA GPU/AI 加速器主要晶圓代工與先進封裝供應鏈核心" },
  { symbol: "2317", market: "tw", name: "鴻海", link: "AI 伺服器、GB200/GB300 相關組裝與系統整合市場焦點" },
  { symbol: "2382", market: "tw", name: "廣達", link: "AI 伺服器 ODM 與雲端資料中心供應鏈" },
  { symbol: "3231", market: "tw", name: "緯創", link: "AI 伺服器 ODM 與 NVIDIA 伺服器供應鏈" },
  { symbol: "6669", market: "tw", name: "緯穎", link: "雲端資料中心與 AI 伺服器系統供應鏈" },
  { symbol: "2356", market: "tw", name: "英業達", link: "伺服器與 AI PC/雲端硬體供應鏈" },
  { symbol: "2376", market: "tw", name: "技嘉", link: "GPU、AI 伺服器與主機板相關產品" },
  { symbol: "2357", market: "tw", name: "華碩", link: "AI PC、伺服器、GPU 板卡與邊緣 AI 產品" },
  { symbol: "3017", market: "tw", name: "奇鋐", link: "AI 伺服器散熱模組與液冷題材" },
  { symbol: "3324", market: "tw", name: "雙鴻", link: "AI 伺服器散熱與液冷概念股" },
  { symbol: "2421", market: "tw", name: "建準", link: "風扇與散熱供應鏈" },
  { symbol: "2308", market: "tw", name: "台達電", link: "AI 資料中心電源、散熱與能源管理" },
  { symbol: "8046", market: "tw", name: "南電", link: "ABF 載板與高階封裝供應鏈" },
  { symbol: "3037", market: "tw", name: "欣興", link: "載板、PCB 與 AI 高速運算供應鏈" },
  { symbol: "2368", market: "tw", name: "金像電", link: "AI 伺服器 PCB 供應鏈" },
  { symbol: "3533", market: "tw", name: "嘉澤", link: "高速連接器與伺服器平台供應鏈" },
  { symbol: "6415", market: "tw", name: "矽力-KY", link: "電源管理 IC 與高效運算供應鏈題材" },
  { symbol: "NVDA", market: "us", name: "NVIDIA", link: "黃仁勳創辦與領導公司，AI GPU/加速運算核心" },
  { symbol: "TSM", market: "us", name: "TSMC ADR", link: "台積電 ADR，NVIDIA 先進晶片製造供應鏈核心" },
  { symbol: "AMD", market: "us", name: "AMD", link: "AI GPU 競爭與加速運算市場比較標的" },
  { symbol: "AVGO", market: "us", name: "Broadcom", link: "AI ASIC、網通與資料中心晶片供應鏈" },
  { symbol: "SMCI", market: "us", name: "Supermicro", link: "AI 伺服器系統與 NVIDIA 平台合作供應鏈" },
  { symbol: "DELL", market: "us", name: "Dell", link: "AI 伺服器與企業資料中心平台" },
  { symbol: "MSFT", market: "us", name: "Microsoft", link: "雲端 AI 資本支出與 NVIDIA GPU 需求來源" },
  { symbol: "GOOGL", market: "us", name: "Alphabet", link: "雲端 AI、資料中心與加速運算需求來源" },
  { symbol: "AMZN", market: "us", name: "Amazon", link: "AWS AI 資料中心與加速運算需求來源" },
  { symbol: "META", market: "us", name: "Meta", link: "AI 訓練/推論資料中心資本支出需求來源" }
];

async function buildSymbolReportPayload(env, symbol) {
  if (!symbol) {
    throw new Error("請指定股票代號");
  }

  const stock = (await getStocksWithLatest(env)).find((item) => item.symbol === symbol);
  const analysisRows = await env.DB.prepare(`
    SELECT price, change_percent, volume, ma5, ma20, ma60, rsi14, macd, macd_signal, volume_ratio, score, trend, summary, created_at
    FROM analysis_runs
    WHERE symbol = ?
    ORDER BY created_at DESC
    LIMIT 10
  `).bind(symbol).all();

  return {
    reportType: "symbol",
    generatedAt: new Date().toISOString(),
    instruction: "請用繁體中文產出單股觀察報告。請使用 web search 補充公司主要業務、營收/產業定位摘要，以及該股或該公司近期市場新聞。新聞優先近 14 天，若不足請放寬到近 90 天，至少列出 3 則可靠新聞或公告型資訊。不得宣稱保證獲利，不得直接叫使用者買賣。請分成：公司主要業務、最近市場新聞、目前技術狀態、風險、明天觀察價位/條件、資料限制。新聞請附來源名稱與日期，並說明和股價觀察的關聯。",
    webSearchQueries: [
      `${stock?.name || symbol} ${symbol} 公司主要業務`,
      `${stock?.name || symbol} ${symbol} 股價 新聞 近期`,
      `${stock?.name || symbol} ${symbol} 營收 法說 產業 新聞`
    ],
    stock: compactStockForPrompt(stock || { symbol }),
    recentAnalyses: analysisRows.results || []
  };
}

function compactStockForPrompt(stock) {
  return {
    symbol: stock.symbol,
    name: stock.name,
    market: stock.market,
    price: stock.price,
    changePercent: stock.change_percent,
    ma5: stock.ma5,
    ma20: stock.ma20,
    ma60: stock.ma60,
    rsi14: stock.rsi14,
    macd: stock.macd,
    macdSignal: stock.macd_signal,
    volumeRatio: stock.volume_ratio,
    score: stock.score,
    trend: stock.trend,
    summary: stock.summary,
    analyzedAt: stock.analyzed_at,
    note: stock.note
  };
}

async function callOpenAI(apiKey, model, payload, options = {}) {
  const body = {
    model,
    input: [
      {
        role: "developer",
        content: "你是保守、嚴謹的股票研究助理。只做資料解讀、公司背景整理、新聞摘要與風險提示，不提供個人化投資建議。輸出繁體中文，條列清楚。涉及近期新聞時要避免誇大，並標示來源或日期。"
      },
      {
        role: "user",
        content: JSON.stringify(payload)
      }
    ],
    max_output_tokens: 2200
  };

  if (options.useWebSearch) {
    body.tools = [
      {
        type: "web_search",
        user_location: {
          type: "approximate",
          country: "TW",
          timezone: "Asia/Taipei"
        }
      }
    ];
    body.tool_choice = "auto";
    body.include = ["web_search_call.action.sources"];
  }

  let response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  let data = await response.json();
  let usedWebSearch = Boolean(options.useWebSearch);

  if (!response.ok && options.useWebSearch) {
    delete body.tools;
    delete body.tool_choice;
    delete body.include;
    body.input[0].content += " 如果無法使用 web search，請只根據輸入資料與一般公司背景知識撰寫，並明確標示近期新聞未能即時查證。";

    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    data = await response.json();
    usedWebSearch = false;
  }

  if (!response.ok) {
    throw new Error(data.error?.message || `OpenAI request failed: ${response.status}`);
  }

  const text = extractResponseText(data);
  if (!text) {
    throw new Error("OpenAI response missing output text");
  }

  return {
    report: text,
    sources: extractSources(data),
    usedWebSearch
  };
}

function extractResponseText(data) {
  if (data.output_text) return data.output_text;

  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n").trim();
}

function extractSources(data) {
  const sources = [];
  for (const item of data.output || []) {
    if (item.type === "web_search_call") {
      for (const source of item.action?.sources || []) {
        sources.push({
          title: source.title,
          url: source.url,
          source: source.source
        });
      }
    }
  }
  return sources;
}

async function analyzeStock(symbol, market) {
  const sourceSymbol = toYahooSymbol(symbol, market);
  const candles = await fetchYahooCandles(sourceSymbol, "6mo");

  if (candles.length < 25) {
    throw new Error("可用股價資料不足");
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
      candleCount: candles.length,
      recentCandles: candles.slice(-20)
    }
  };
}

async function fetchYahooCandles(sourceSymbol, range = "6mo") {
  const endpoint = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sourceSymbol)}?range=${range}&interval=1d`;
  const response = await fetch(endpoint, {
    headers: { "User-Agent": "stock-analysis-platform/0.2" }
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

async function findStock(env, symbol) {
  return env.DB.prepare("SELECT symbol, market, name, note FROM watchlist WHERE symbol = ?")
    .bind(symbol)
    .first();
}

async function getSystemEvents(env) {
  return jsonResponse({ events: await getRecentEvents(env, 20) });
}

async function getRecentEvents(env, limit) {
  const result = await env.DB.prepare(`
    SELECT event_type, status, message, metadata_json, created_at
    FROM system_events
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(limit).all();
  return result.results || [];
}

async function logEvent(env, eventType, status, message, metadata) {
  await env.DB.prepare(`
    INSERT INTO system_events(event_type, status, message, metadata_json)
    VALUES (?, ?, ?, ?)
  `).bind(eventType, status, message, JSON.stringify(metadata || {})).run();
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
  return String(value || "").trim().slice(0, 300);
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

async function digestText(text) {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

function requireDb(env) {
  if (!env.DB) {
    throw new Error("D1 binding DB is not configured");
  }
}

function getOpenAIKey(env) {
  if (typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.trim()) {
    return env.OPENAI_API_KEY.trim();
  }

  for (const [key, value] of Object.entries(env)) {
    if (key.trim() === "OPENAI_API_KEY" && typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
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
  <title>股市分析平台</title>
  <style>
    :root {
      --bg: #f4f6f8;
      --panel: #ffffff;
      --text: #1f2937;
      --muted: #667085;
      --line: #d9dee7;
      --accent: #0f766e;
      --accent-dark: #115e59;
      --red: #b42318;
      --amber: #93370d;
      --green: #067647;
      --blue: #175cd3;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Arial, "Microsoft JhengHei", sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    header {
      background: #fff;
      border-bottom: 1px solid var(--line);
      padding: 16px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
    }
    h1 { margin: 0; font-size: 22px; letter-spacing: 0; }
    main { padding: 20px; }
    .app-shell {
      display: grid;
      grid-template-columns: 260px 0 minmax(0, 1fr);
      min-height: 100vh;
      transition: grid-template-columns .18s ease;
    }
    .app-shell.drawer-open {
      grid-template-columns: 260px 340px minmax(0, 1fr);
    }
    .sidebar {
      position: sticky;
      top: 0;
      height: 100vh;
      overflow-y: auto;
      background: #fff;
      border-right: 1px solid var(--line);
      padding: 18px;
      z-index: 20;
    }
    .sidebar h1 { font-size: 21px; margin-bottom: 6px; }
    .sidebar-actions {
      display: grid;
      gap: 8px;
      margin: 16px 0;
    }
    .nav-button {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: transparent;
      color: var(--text);
      border: 1px solid transparent;
      text-align: left;
    }
    .nav-button:hover {
      background: #eef2f6;
      color: var(--text);
    }
    .nav-button.active {
      background: var(--accent);
      color: #fff;
    }
    .content {
      min-width: 0;
      max-width: 1320px;
      width: 100%;
      margin: 0 auto;
    }
    .top-actions, .actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .grid { display: grid; gap: 14px; }
    .stats { grid-template-columns: repeat(6, minmax(120px, 1fr)); margin-bottom: 14px; }
    .layout { grid-template-columns: minmax(0, 1fr) 420px; align-items: start; }
    .view-section { display: none; }
    .view-section.active { display: block; }
    .panel, .stat {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .panel { padding: 16px; }
    .stat { padding: 14px; }
    .stat .label { color: var(--muted); font-size: 12px; }
    .stat .value { font-size: 24px; font-weight: 700; margin-top: 5px; }
    h2 { font-size: 16px; margin: 0 0 12px; }
    form {
      display: grid;
      grid-template-columns: 1fr 1fr 120px 1.2fr auto;
      gap: 10px;
      align-items: end;
      margin-bottom: 14px;
    }
    label { display: grid; gap: 5px; color: var(--muted); font-size: 12px; }
    input, select, textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 10px 12px;
      font-size: 14px;
      color: var(--text);
      background: #fff;
    }
    textarea { min-height: 92px; resize: vertical; }
    button {
      border: 0;
      border-radius: 6px;
      padding: 10px 13px;
      min-height: 40px;
      cursor: pointer;
      color: #fff;
      background: var(--accent);
      font-size: 14px;
    }
    button:hover { background: var(--accent-dark); }
    button.secondary { background: #e7eef0; color: #164e63; }
    button.secondary:hover { background: #d4e3e6; }
    button.danger { background: #fee4e2; color: var(--red); }
    button.danger:hover { background: #fecdca; }
    button:disabled { opacity: .6; cursor: wait; }
    table { width: 100%; border-collapse: collapse; }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 10px 8px;
      text-align: left;
      vertical-align: top;
      font-size: 13px;
    }
    th { color: var(--muted); font-weight: 700; background: #f9fafb; }
    tr:last-child td { border-bottom: 0; }
    .symbol { font-weight: 700; font-size: 14px; }
    .muted { color: var(--muted); font-size: 12px; }
    .status { min-height: 22px; color: var(--muted); font-size: 13px; margin: 0 0 10px; }
    .badge {
      display: inline-block;
      min-width: 52px;
      border-radius: 999px;
      padding: 4px 8px;
      font-weight: 700;
      text-align: center;
      background: #eef2f6;
    }
    .bull { color: var(--green); background: #dcfae6; }
    .flat { color: var(--blue); background: #d1e9ff; }
    .weak { color: var(--amber); background: #fef0c7; }
    .report {
      white-space: pre-wrap;
      line-height: 1.6;
      font-size: 14px;
      background: #fbfcfd;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      min-height: 160px;
      max-height: calc(100vh - 190px);
      overflow: auto;
    }
    .detail {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-top: 14px;
    }
    .chart {
      width: 100%;
      height: 180px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
    }
    .empty {
      border: 1px dashed var(--line);
      border-radius: 8px;
      padding: 28px;
      color: var(--muted);
      text-align: center;
      background: #fff;
    }
    .teacher-list {
      display: grid;
      gap: 8px;
      margin-top: 12px;
    }
    .teacher-item {
      width: 100%;
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: #eef2f6;
      color: var(--text);
      text-align: left;
    }
    .teacher-item:hover { background: #dbe4ec; }
    .teacher-item.primary {
      background: var(--accent);
      color: #fff;
    }
    .teacher-drawer {
      height: 100vh;
      overflow: hidden;
      background: #fff;
      border-right: 1px solid var(--line);
      box-shadow: 10px 0 26px rgba(15, 23, 42, .08);
      position: sticky;
      top: 0;
    }
    .app-shell.drawer-open .teacher-drawer {
      overflow-y: auto;
    }
    .teacher-drawer-inner {
      width: 340px;
      min-height: 100vh;
      padding: 20px;
    }
    .drawer-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      margin-bottom: 18px;
    }
    .drawer-head h2 { margin: 0 0 4px; }
    @media (max-width: 980px) {
      .app-shell,
      .app-shell.drawer-open { grid-template-columns: 1fr; }
      .sidebar {
        position: static;
        height: auto;
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      .teacher-drawer {
        position: static;
        height: auto;
        display: none;
      }
      .app-shell.drawer-open .teacher-drawer {
        display: block;
      }
      .stats, .layout, .detail { grid-template-columns: 1fr; }
      form { grid-template-columns: 1fr; }
      header { align-items: flex-start; flex-direction: column; }
      table, thead, tbody, th, td, tr { display: block; }
      thead { display: none; }
      tr { border-bottom: 1px solid var(--line); padding: 10px 0; }
      td { border-bottom: 0; padding: 5px 0; }
      td::before {
        content: attr(data-label);
        display: block;
        color: var(--muted);
        font-size: 11px;
        margin-bottom: 2px;
      }
    }
  </style>
</head>
<body>
  <div class="app-shell">
    <aside class="sidebar">
      <h1>股市分析平台</h1>
      <div class="muted">LINE OA 式後台。左側選功能，右側顯示內容。</div>

      <div class="sidebar-actions">
        <button class="nav-button" id="nav-celebrity" onclick="showView('celebrity')"><span>名人專區</span><span>›</span></button>
        <button class="nav-button active" id="nav-stocks" onclick="showView('stocks')"><span>自選股</span><span>›</span></button>
        <button class="nav-button" id="nav-ai-picks" onclick="showView('ai-picks')"><span>AI推薦股</span><span>›</span></button>
      </div>
      <div class="muted">資料僅供研究，不構成投資建議。</div>
    </aside>

    <aside class="teacher-drawer" id="teacher-drawer">
      <div class="teacher-drawer-inner">
        <div class="drawer-head">
          <div>
            <h2>名人專區</h2>
            <div class="muted">追蹤人物列表</div>
          </div>
          <button class="secondary" onclick="closeTeacherDrawer()">關閉</button>
        </div>
        <div class="teacher-list">
          <button class="teacher-item primary" onclick="selectTeacher('jensen')"><span>黃仁勳</span><span>›</span></button>
          <button class="teacher-item" onclick="selectTeacher('placeholder')"><span>XXX</span><span>›</span></button>
        </div>
      </div>
    </aside>

    <main class="content">
      <p class="status" id="status"></p>

      <section class="view-section" id="view-celebrity">
        <section class="panel" style="margin-bottom:14px;">
          <h2>名人專區</h2>
          <div class="muted">左側會展開名人老師子選單。選黃仁勳後，可追蹤新聞、拜訪廠家與 NVIDIA/AI 概念股。</div>
        </section>
        <section class="grid layout">
          <div class="panel">
            <h2>追蹤結果</h2>
            <div class="muted" id="celebrity-state">請先從左側子選單選擇名人老師。</div>
            <div class="actions" id="celebrity-actions" style="margin:12px 0;"></div>
            <div class="report" id="celebrity-report">尚未產生追蹤報告。</div>
          </div>
          <aside class="panel">
            <h2>操作提示</h2>
            <div class="muted">目前已建立黃仁勳追蹤。XXX 是下一位名人老師預留模板。</div>
          </aside>
        </section>
      </section>

      <section class="view-section active" id="view-stocks">
      <section class="grid stats" id="stats"></section>
      <section class="grid layout">
      <div class="panel">
        <h2>自選股工作台</h2>
        <form id="stock-form">
          <label>股票代號
            <input id="symbol" placeholder="2330 或 AAPL" autocomplete="off" required>
          </label>
          <label>股票名稱
            <input id="name" placeholder="台積電、Apple" autocomplete="off">
          </label>
          <label>市場
            <select id="market">
              <option value="tw">台股</option>
              <option value="us">美股</option>
            </select>
          </label>
          <label>備註
            <input id="note" placeholder="觀察理由、產業、風險">
          </label>
          <button type="submit">新增 / 更新</button>
        </form>
        <div id="stocks"></div>
        <div id="detail"></div>
      </div>

      <aside class="panel">
        <h2>AI 分析報告</h2>
        <div class="muted" id="ai-state"></div>
        <div class="report" id="report">尚未產生報告。</div>
        <h2 style="margin-top:16px;">系統紀錄</h2>
        <div id="events"></div>
      </aside>
    </section>
      </section>

      <section class="view-section" id="view-ai-picks">
        <section class="grid stats" id="ai-pick-stats"></section>
        <section class="grid layout">
          <div class="panel">
            <h2>AI推薦股</h2>
            <div class="muted">根據目前自選股的技術分數、趨勢與 AI 報告，整理偏強、觀察、風險名單。</div>
            <div class="actions" style="margin:12px 0;">
              <button onclick="createPortfolioReport()">產生 AI 推薦報告</button>
              <button class="secondary" onclick="analyzeAll()">先批次分析全部</button>
            </div>
            <div id="ai-picks"></div>
          </div>
          <aside class="panel">
            <h2>AI推薦報告</h2>
            <div class="muted" id="ai-pick-state">尚未產生推薦報告。</div>
            <div class="report" id="ai-pick-report">按「產生 AI 推薦報告」後，這裡會顯示內容。</div>
          </aside>
        </section>
      </section>
    </main>
  </div>

  <script>
    let dashboard = null;
    let selectedSymbol = null;
    let currentView = "stocks";

    document.querySelector("#stock-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      await api("/api/stocks", {
        method: "POST",
        body: JSON.stringify({
          symbol: document.querySelector("#symbol").value,
          name: document.querySelector("#name").value,
          market: document.querySelector("#market").value,
          note: document.querySelector("#note").value
        })
      });
      event.target.reset();
      await loadDashboard();
    });

    async function loadDashboard() {
      setBusy("讀取平台資料...");
      dashboard = await api("/api/dashboard");
      renderStats(dashboard.stats);
      renderStocks(dashboard.stocks || []);
      renderAiPicks(dashboard);
      renderReport(dashboard.latestReport, dashboard.stats.hasOpenAI);
      renderEvents(dashboard.events || []);
      clearBusy();
    }

    function showView(view) {
      currentView = view;
      document.querySelectorAll(".view-section").forEach((section) => section.classList.remove("active"));
      document.querySelector("#view-" + view).classList.add("active");
      document.querySelectorAll(".nav-button").forEach((button) => button.classList.remove("active"));
      document.querySelector("#nav-" + view).classList.add("active");

      if (view === "celebrity") {
        openTeacherDrawer();
      } else {
        closeTeacherDrawer();
      }
    }

    async function analyze(symbol) {
      setBusy("分析 " + symbol + "...");
      await api("/api/analyze", {
        method: "POST",
        body: JSON.stringify({ symbol })
      });
      selectedSymbol = symbol;
      await loadDashboard();
      await showDetail(symbol);
    }

    async function analyzeAll() {
      setBusy("批次分析全部自選股...");
      const result = await api("/api/analyze-all", { method: "POST", body: "{}" });
      setStatus("批次完成：" + result.okCount + "/" + result.total);
      await loadDashboard();
    }

    async function createPortfolioReport() {
      setBusy("產生 AI 總覽報告...");
      const data = await api("/api/ai-report", {
        method: "POST",
        body: JSON.stringify({ scope: "portfolio" })
      });
      const targetReport = currentView === "ai-picks" ? "#ai-pick-report" : "#report";
      const targetState = currentView === "ai-picks" ? "#ai-pick-state" : "#ai-state";
      document.querySelector(targetReport).textContent = data.report;
      document.querySelector(targetState).textContent = "模型：" + data.model;
      clearBusy();
    }

    async function createSymbolReport(symbol) {
      setBusy("產生 " + symbol + " AI 報告...");
      const data = await api("/api/ai-report", {
        method: "POST",
        body: JSON.stringify({ scope: "symbol", symbol })
      });
      const targetReport = currentView === "ai-picks" ? "#ai-pick-report" : "#report";
      const targetState = currentView === "ai-picks" ? "#ai-pick-state" : "#ai-state";
      document.querySelector(targetReport).textContent = data.report;
      document.querySelector(targetState).textContent = "模型：" + data.model + " / " + symbol;
      clearBusy();
    }

    function openTeacherDrawer() {
      document.querySelector(".app-shell").classList.add("drawer-open");
    }

    function closeTeacherDrawer() {
      document.querySelector(".app-shell").classList.remove("drawer-open");
    }

    function selectTeacher(key) {
      showView("celebrity");
      if (key === "jensen") {
        document.querySelector("#celebrity-state").textContent = "黃仁勳：NVIDIA、AI 供應鏈、拜訪廠家、概念股追蹤";
        document.querySelector("#celebrity-report").innerHTML =
          '追蹤內容：\\n' +
          '- 黃仁勳最新新聞、公開行程、演講、媒體採訪\\n' +
          '- 拜訪或互動過的台灣/全球供應鏈廠家\\n' +
          '- NVIDIA / AI 伺服器 / 散熱 / 電源 / PCB / 連接器 / 先進封裝概念股\\n\\n' +
          '可執行：\\n' +
          '1. 產生最新追蹤報告\\n' +
          '2. 加入核心概念股到自選股';
        document.querySelector("#celebrity-actions").innerHTML =
          '<button onclick="createJensenReport()">產生最新追蹤報告</button>' +
          '<button class="secondary" onclick="addJensenConceptStocks()">加入核心概念股到自選股</button>';
      } else {
        document.querySelector("#celebrity-state").textContent = "XXX：預留名人老師追蹤模板";
        document.querySelector("#celebrity-report").textContent = "這個位置預留給下一位名人老師。之後可接獨立新聞追蹤、拜訪廠家、概念股清單與 AI 報告。";
        document.querySelector("#celebrity-actions").innerHTML = "";
      }
    }

    async function createJensenReport() {
      setBusy("更新名人老師追蹤：黃仁勳...");
      const data = await api("/api/jensen-report", {
        method: "POST",
        body: "{}"
      });
      showView("celebrity");
      document.querySelector("#celebrity-report").textContent = data.report;
      document.querySelector("#celebrity-state").textContent = "黃仁勳 / 模型：" + data.model + " / web search：" + (data.usedWebSearch ? "已啟用" : "未啟用") + " / sources：" + (data.sources?.length || 0);
      clearBusy();
    }

    async function addJensenConceptStocks() {
      const items = [
        ["2382", "廣達", "tw", "黃仁勳/NVIDIA AI 伺服器概念股"],
        ["3231", "緯創", "tw", "黃仁勳/NVIDIA AI 伺服器概念股"],
        ["6669", "緯穎", "tw", "雲端資料中心與 AI 伺服器概念股"],
        ["2356", "英業達", "tw", "伺服器與 AI PC 供應鏈"],
        ["2376", "技嘉", "tw", "GPU 與 AI 伺服器概念股"],
        ["2357", "華碩", "tw", "AI PC 與伺服器概念股"],
        ["3017", "奇鋐", "tw", "AI 伺服器散熱概念股"],
        ["3324", "雙鴻", "tw", "AI 伺服器散熱概念股"],
        ["2421", "建準", "tw", "散熱風扇概念股"],
        ["2308", "台達電", "tw", "AI 資料中心電源與散熱"],
        ["8046", "南電", "tw", "ABF 載板概念股"],
        ["3037", "欣興", "tw", "PCB/載板概念股"],
        ["2368", "金像電", "tw", "AI 伺服器 PCB 概念股"],
        ["3533", "嘉澤", "tw", "高速連接器概念股"],
        ["NVDA", "NVIDIA", "us", "黃仁勳核心公司"],
        ["TSM", "TSMC ADR", "us", "NVIDIA 先進晶片製造供應鏈"],
        ["SMCI", "Supermicro", "us", "AI 伺服器系統概念股"],
        ["DELL", "Dell", "us", "AI 伺服器與企業資料中心"],
        ["MSFT", "Microsoft", "us", "雲端 AI 資本支出"],
        ["GOOGL", "Alphabet", "us", "雲端 AI 資本支出"],
        ["AMZN", "Amazon", "us", "AWS AI 資料中心"],
        ["META", "Meta", "us", "AI 資料中心資本支出"]
      ];

      setBusy("加入黃仁勳/NVIDIA 核心概念股...");
      for (const [symbol, name, market, note] of items) {
        await api("/api/stocks", {
          method: "POST",
          body: JSON.stringify({ symbol, name, market, note })
        });
      }
      await loadDashboard();
      setStatus("核心概念股已加入，可再批次分析全部。");
    }

    async function removeStock(symbol) {
      if (!confirm("刪除 " + symbol + "？")) return;
      setBusy("刪除 " + symbol + "...");
      await api("/api/stocks/" + encodeURIComponent(symbol), { method: "DELETE" });
      if (selectedSymbol === symbol) {
        selectedSymbol = null;
        document.querySelector("#detail").innerHTML = "";
      }
      await loadDashboard();
    }

    async function showDetail(symbol) {
      selectedSymbol = symbol;
      setBusy("讀取 " + symbol + " 明細...");
      const stock = (dashboard?.stocks || []).find((item) => item.symbol === symbol);
      const [candles, history] = await Promise.all([
        api("/api/candles/" + encodeURIComponent(symbol) + "?market=" + encodeURIComponent(stock?.market || "tw")),
        api("/api/analysis/" + encodeURIComponent(symbol))
      ]);
      renderDetail(stock, candles.candles || [], history.analyses || []);
      clearBusy();
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

    function renderStats(stats) {
      const cards = [
        ["自選股", stats.total],
        ["已分析", stats.analyzed],
        ["偏多", stats.bullish],
        ["中性", stats.neutral],
        ["偏弱", stats.weak],
        ["平均分", stats.averageScore ?? "-"]
      ];
      document.querySelector("#stats").innerHTML = cards.map(([label, value]) =>
        '<div class="stat"><div class="label">' + label + '</div><div class="value">' + value + '</div></div>'
      ).join("");
      document.querySelector("#ai-pick-stats").innerHTML = document.querySelector("#stats").innerHTML;
    }

    function renderAiPicks(data) {
      const leaders = data.leaders || [];
      const risks = data.risks || [];

      const leaderRows = leaders.map((stock) =>
        '<tr><td data-label="股票"><strong>' + escapeHtml(stock.symbol) + '</strong><div class="muted">' + escapeHtml(stock.name || "") + '</div></td><td data-label="分數"><span class="badge ' + classForTrend(stock.trend) + '">' + (stock.score ?? "-") + '</span></td><td data-label="理由">' + escapeHtml(stock.summary || "") + '</td><td data-label="操作"><button class="secondary" onclick="createSymbolReport(\\'' + escapeJs(stock.symbol) + '\\')">AI</button></td></tr>'
      ).join("");

      const riskRows = risks.map((stock) =>
        '<tr><td data-label="股票"><strong>' + escapeHtml(stock.symbol) + '</strong><div class="muted">' + escapeHtml(stock.name || "") + '</div></td><td data-label="分數"><span class="badge ' + classForTrend(stock.trend) + '">' + (stock.score ?? "-") + '</span></td><td data-label="理由">' + escapeHtml(stock.summary || "") + '</td><td data-label="操作"><button class="secondary" onclick="createSymbolReport(\\'' + escapeJs(stock.symbol) + '\\')">AI</button></td></tr>'
      ).join("");

      document.querySelector("#ai-picks").innerHTML =
        '<h2>偏強觀察</h2>' +
        '<table><thead><tr><th>股票</th><th>分數</th><th>理由</th><th>操作</th></tr></thead><tbody>' + leaderRows + '</tbody></table>' +
        '<h2 style="margin-top:16px;">風險觀察</h2>' +
        '<table><thead><tr><th>股票</th><th>分數</th><th>理由</th><th>操作</th></tr></thead><tbody>' + riskRows + '</tbody></table>';
    }

    function renderStocks(stocks) {
      if (!stocks.length) {
        document.querySelector("#stocks").innerHTML = '<div class="empty">尚未加入自選股。先新增 2330、2317、AAPL 這類代號。</div>';
        return;
      }

      const rows = stocks.map((stock) => {
        const trendClass = classForTrend(stock.trend);
        return '<tr>' +
          '<td data-label="股票"><div class="symbol">' + escapeHtml(stock.symbol) + '</div><div class="muted">' + escapeHtml(stock.name || "") + '</div></td>' +
          '<td data-label="市場">' + (stock.market === "us" ? "美股" : "台股") + '</td>' +
          '<td data-label="價格">' + format(stock.price) + '<div class="muted">' + format(stock.change_percent) + '%</div></td>' +
          '<td data-label="指標">MA20 ' + format(stock.ma20) + '<div class="muted">RSI ' + format(stock.rsi14) + ' / 量比 ' + format(stock.volume_ratio) + '</div></td>' +
          '<td data-label="分數"><span class="badge ' + trendClass + '">' + (stock.score ?? "-") + '</span></td>' +
          '<td data-label="趨勢"><span class="badge ' + trendClass + '">' + escapeHtml(stock.trend || "未分析") + '</span></td>' +
          '<td data-label="摘要">' + escapeHtml(stock.summary || "尚未分析") + '<div class="muted">' + escapeHtml(stock.analyzed_at || "") + '</div></td>' +
          '<td data-label="操作"><div class="actions">' +
            '<button class="secondary" onclick="showDetail(\\'' + escapeJs(stock.symbol) + '\\')">明細</button>' +
            '<button onclick="analyze(\\'' + escapeJs(stock.symbol) + '\\')">分析</button>' +
            '<button class="secondary" onclick="createSymbolReport(\\'' + escapeJs(stock.symbol) + '\\')">AI</button>' +
            '<button class="danger" onclick="removeStock(\\'' + escapeJs(stock.symbol) + '\\')">刪除</button>' +
          '</div></td>' +
        '</tr>';
      }).join("");

      document.querySelector("#stocks").innerHTML = '<table><thead><tr><th>股票</th><th>市場</th><th>價格</th><th>指標</th><th>分數</th><th>趨勢</th><th>摘要</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }

    function renderDetail(stock, candles, history) {
      const latest = history[0] || {};
      const historyRows = history.slice(0, 8).map((item) =>
        '<tr><td data-label="時間">' + escapeHtml(item.created_at) + '</td><td data-label="價格">' + format(item.price) + '</td><td data-label="分數">' + item.score + '</td><td data-label="趨勢">' + escapeHtml(item.trend) + '</td><td data-label="摘要">' + escapeHtml(item.summary) + '</td></tr>'
      ).join("");

      document.querySelector("#detail").innerHTML =
        '<section class="detail">' +
          '<div class="panel">' +
            '<h2>' + escapeHtml(stock?.symbol || "") + ' 技術明細</h2>' +
            renderChart(candles) +
            '<p>價格 ' + format(latest.price) + '，MA5 ' + format(latest.ma5) + '，MA20 ' + format(latest.ma20) + '，MA60 ' + format(latest.ma60) + '</p>' +
            '<p>RSI ' + format(latest.rsi14) + '，MACD ' + format(latest.macd) + ' / Signal ' + format(latest.macd_signal) + '，量比 ' + format(latest.volume_ratio) + '</p>' +
          '</div>' +
          '<div class="panel">' +
            '<h2>分析歷史</h2>' +
            '<table><thead><tr><th>時間</th><th>價格</th><th>分數</th><th>趨勢</th><th>摘要</th></tr></thead><tbody>' + historyRows + '</tbody></table>' +
          '</div>' +
        '</section>';
    }

    function renderChart(candles) {
      if (!candles.length) return '<div class="chart"></div>';
      const closes = candles.map((item) => item.close);
      const min = Math.min(...closes);
      const max = Math.max(...closes);
      const width = 640;
      const height = 180;
      const pad = 16;
      const points = closes.map((close, index) => {
        const x = pad + index * ((width - pad * 2) / Math.max(closes.length - 1, 1));
        const y = height - pad - ((close - min) / Math.max(max - min, 1)) * (height - pad * 2);
        return x.toFixed(1) + "," + y.toFixed(1);
      }).join(" ");
      return '<svg class="chart" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none"><polyline fill="none" stroke="#0f766e" stroke-width="3" points="' + points + '"></polyline><text x="16" y="24" fill="#667085" font-size="13">近 ' + closes.length + ' 日收盤線</text></svg>';
    }

    function renderReport(report, hasOpenAI) {
      document.querySelector("#ai-state").textContent = hasOpenAI ? "OPENAI_API_KEY 已啟用" : "OPENAI_API_KEY 尚未啟用";
      document.querySelector("#report").textContent = report?.report || "尚未產生報告。";
    }

    function renderEvents(events) {
      if (!events.length) {
        document.querySelector("#events").innerHTML = '<div class="muted">尚無紀錄</div>';
        return;
      }
      document.querySelector("#events").innerHTML = events.map((event) =>
        '<div style="border-top:1px solid var(--line);padding:8px 0;"><strong>' + escapeHtml(event.event_type) + '</strong> <span class="muted">' + escapeHtml(event.status) + '</span><div class="muted">' + escapeHtml(event.message || "") + '</div><div class="muted">' + escapeHtml(event.created_at) + '</div></div>'
      ).join("");
    }

    function classForTrend(trend) {
      if (trend === "偏多") return "bull";
      if (trend === "偏弱") return "weak";
      return "flat";
    }

    function format(value) {
      return value === null || value === undefined ? "-" : Number(value).toLocaleString("zh-TW", { maximumFractionDigits: 2 });
    }

    function setBusy(message) {
      document.querySelectorAll("button").forEach((button) => button.disabled = true);
      setStatus(message);
    }

    function clearBusy() {
      document.querySelectorAll("button").forEach((button) => button.disabled = false);
      setStatus("");
    }

    function setStatus(message) {
      document.querySelector("#status").textContent = message || "";
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

    loadDashboard().catch((error) => {
      clearBusy();
      setStatus(error.message);
    });
  </script>
</body>
</html>`;
