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
