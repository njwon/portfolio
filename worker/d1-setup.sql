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
