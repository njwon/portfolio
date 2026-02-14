-- Supabase SQL Editor에서 실행하세요

-- 1. posts 테이블 생성
CREATE TABLE posts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  velog_id VARCHAR(255) UNIQUE,
  title VARCHAR(500) NOT NULL,
  slug VARCHAR(500) NOT NULL UNIQUE,
  body TEXT,
  short_description TEXT,
  thumbnail VARCHAR(1000),
  tags TEXT[] DEFAULT '{}',
  series_name VARCHAR(255),
  display_date TIMESTAMPTZ NOT NULL,       -- 수정 가능한 표시 날짜
  original_date TIMESTAMPTZ NOT NULL,      -- 원본 Velog 날짜
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. slug 인덱스
CREATE INDEX idx_posts_slug ON posts(slug);
CREATE INDEX idx_posts_display_date ON posts(display_date DESC);

-- 3. RLS (Row Level Security) 설정
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;

-- 누구나 읽기 가능 (블로그는 공개)
CREATE POLICY "Public read access" ON posts
  FOR SELECT USING (true);

-- service_role만 쓰기 가능 (Worker에서 동기화할 때)
CREATE POLICY "Service role write access" ON posts
  FOR ALL USING (auth.role() = 'service_role');
