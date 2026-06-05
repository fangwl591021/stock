CREATE TABLE IF NOT EXISTS watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL UNIQUE,
  name TEXT,
  market TEXT NOT NULL DEFAULT 'tw',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  market TEXT NOT NULL DEFAULT 'tw',
  source_symbol TEXT NOT NULL,
  price REAL,
  change_percent REAL,
  volume INTEGER,
  ma5 REAL,
  ma20 REAL,
  ma60 REAL,
  rsi14 REAL,
  macd REAL,
  macd_signal REAL,
  volume_ratio REAL,
  score INTEGER NOT NULL,
  trend TEXT NOT NULL,
  summary TEXT NOT NULL,
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_analysis_runs_symbol_created
ON analysis_runs(symbol, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  symbol TEXT,
  model TEXT,
  prompt_hash TEXT,
  report TEXT NOT NULL,
  source_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_reports_scope_symbol_created
ON ai_reports(scope, symbol, created_at DESC);

CREATE TABLE IF NOT EXISTS system_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_system_events_type_created
ON system_events(event_type, created_at DESC);
