-- Cloudflare D1 (SQLite) 스키마
-- wrangler d1 execute blog-db --file=d1-setup.sql --remote 로 실행하세요

CREATE TABLE IF NOT EXISTS posts (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  velog_id     TEXT UNIQUE,
  title        TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,
  body         TEXT,
  short_description TEXT,
  thumbnail    TEXT,
  tags         TEXT DEFAULT '[]',   -- JSON 배열을 문자열로 저장
  series_name  TEXT,
  display_date TEXT NOT NULL,
  original_date TEXT NOT NULL,
  synced_at    TEXT DEFAULT (datetime('now')),
  created_at   TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_posts_slug ON posts(slug);
CREATE INDEX IF NOT EXISTS idx_posts_display_date ON posts(display_date DESC);

-- ── DREAM RPG ──────────────────────────────────────────────
-- Workers AI 무료 한도(하루 10,000 뉴런) 누적. day = UTC 날짜
CREATE TABLE IF NOT EXISTS rpg_quota (
  day      TEXT PRIMARY KEY,
  neurons  REAL    NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0
);
-- IP 별 하루 호출 수
CREATE TABLE IF NOT EXISTS rpg_ip (
  day      TEXT NOT NULL,
  ip       TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, ip)
);
-- 온라인 대전 방 (state = JSON, updated 는 낙관적 잠금 버전)
CREATE TABLE IF NOT EXISTS rpg_rooms (
  code    TEXT PRIMARY KEY,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  state   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rpg_rooms_updated ON rpg_rooms(updated);
-- 캐릭터 (서버 권위: 스탯은 서버가 정하고 클라이언트는 id+token 만 가짐)
CREATE TABLE IF NOT EXISTS rpg_chars (
  id      TEXT PRIMARY KEY,
  token   TEXT NOT NULL,
  json    TEXT NOT NULL,
  created INTEGER NOT NULL
);
-- AI 상대 전투 상태
CREATE TABLE IF NOT EXISTS rpg_battles (
  id      TEXT PRIMARY KEY,
  char_id TEXT NOT NULL,
  state   TEXT NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rpg_battles_updated ON rpg_battles(updated);
-- DREAM RPG: 외부 무료 AI 제공자(Groq · Gemini · Cerebras · Mistral · GitHub Models · OpenRouter)별 일일 호출 수
CREATE TABLE IF NOT EXISTS rpg_provider (
  day      TEXT NOT NULL,
  provider TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider)
);
-- DREAM RPG: 사용자(IP)별 몫 버킷 — 제공자 초기화 시각에 맞춰 충전 (rpg_ip 는 더 이상 사용하지 않음)
CREATE TABLE IF NOT EXISTS rpg_ip_bucket (
  ip      TEXT PRIMARY KEY,
  tokens  REAL NOT NULL,
  updated INTEGER NOT NULL,
  used    INTEGER NOT NULL DEFAULT 0
);
-- DREAM RPG: Google 로그인 계정·세션, 캐릭터 ↔ 계정 연결, 순위표용 승점 컬럼
CREATE TABLE IF NOT EXISTS rpg_users (
  sub     TEXT PRIMARY KEY,
  email   TEXT,
  name    TEXT,
  picture TEXT,
  created INTEGER NOT NULL,
  last    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rpg_sessions (
  token   TEXT PRIMARY KEY,
  sub     TEXT NOT NULL,
  created INTEGER NOT NULL
);
ALTER TABLE rpg_chars ADD COLUMN user_sub TEXT;
ALTER TABLE rpg_chars ADD COLUMN score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rpg_chars ADD COLUMN name TEXT;
CREATE INDEX IF NOT EXISTS idx_rpg_chars_score ON rpg_chars(score);
CREATE INDEX IF NOT EXISTS idx_rpg_chars_user ON rpg_chars(user_sub);
