/**
 * Cloudflare Worker - Velog 동기화 & 블로그 API (D1 버전)
 *
 * 환경변수 (Cloudflare Dashboard에서 설정):
 *   VELOG_USERNAME  - Velog 유저네임 (njw)
 *   SYNC_SECRET     - 동기화 API 보호용 시크릿 키
 *
 * D1 바인딩 (wrangler.toml):
 *   DB              - blog-db
 */

const VELOG_API = 'https://v2.velog.io/graphql';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/api/sync' && request.method === 'POST') {
        return await handleSync(request, env);
      }
      if (path === '/api/posts' && request.method === 'GET') {
        return await handleGetPosts(url, env);
      }
      if (path.startsWith('/api/posts/') && request.method === 'GET') {
        const slug = decodeURIComponent(path.replace('/api/posts/', ''));
        return await handleGetPost(slug, env);
      }
      return jsonResponse({ error: 'Not Found' }, 404);
    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }
  },
};

// ─── Velog → D1 동기화 ──────────────────────────────────────
async function handleSync(request, env) {
  const auth = request.headers.get('Authorization');
  if (auth !== `Bearer ${env.SYNC_SECRET}`) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const velogPosts = await fetchVelogPosts(env.VELOG_USERNAME);

  let synced = 0;
  for (const post of velogPosts) {
    const detail = await fetchVelogPost(env.VELOG_USERNAME, post.url_slug);
    if (!detail) continue;

    await upsertPost(env, {
      velog_id: detail.id,
      title: detail.title,
      slug: detail.url_slug,
      body: detail.body,
      short_description: detail.short_description || post.short_description || '',
      thumbnail: detail.thumbnail || post.thumbnail || null,
      tags: JSON.stringify(detail.tags || []),
      series_name: detail.series?.name || null,
      display_date: detail.released_at,
      original_date: detail.released_at,
      synced_at: new Date().toISOString(),
    });
    synced++;
  }

  return jsonResponse({ message: `${synced}개 글 동기화 완료` });
}

// ─── 글 목록 API ────────────────────────────────────────────
async function handleGetPosts(url, env) {
  const tag = url.searchParams.get('tag');

  let sql = `SELECT id, title, slug, short_description, thumbnail, tags, display_date, series_name
             FROM posts`;
  const bindings = [];

  if (tag) {
    sql += ` WHERE tags LIKE ?`;
    bindings.push(`%"${tag}"%`);
  }

  sql += ` ORDER BY display_date DESC`;

  const { results } = await env.DB.prepare(sql).bind(...bindings).all();

  const posts = results.map(p => ({
    ...p,
    tags: JSON.parse(p.tags || '[]'),
  }));

  return jsonResponse(posts);
}

// ─── 글 상세 API ────────────────────────────────────────────
async function handleGetPost(slug, env) {
  const row = await env.DB
    .prepare(`SELECT * FROM posts WHERE slug = ? LIMIT 1`)
    .bind(slug)
    .first();

  if (!row) {
    return jsonResponse({ error: 'Post not found' }, 404);
  }

  return jsonResponse({
    ...row,
    tags: JSON.parse(row.tags || '[]'),
  });
}

// ─── Velog GraphQL ──────────────────────────────────────────
async function fetchVelogPosts(username) {
  const query = `
    query Posts($username: String!) {
      posts(username: $username) {
        id title url_slug short_description thumbnail released_at tags
      }
    }
  `;
  const res = await fetch(VELOG_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { username } }),
  });
  const json = await res.json();
  return json.data?.posts || [];
}

async function fetchVelogPost(username, urlSlug) {
  const query = `
    query Post($username: String!, $url_slug: String!) {
      post(username: $username, url_slug: $url_slug) {
        id title url_slug body short_description thumbnail released_at tags
        series { name }
      }
    }
  `;
  const res = await fetch(VELOG_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { username, url_slug: urlSlug } }),
  });
  const json = await res.json();
  return json.data?.post || null;
}

// ─── D1 upsert ──────────────────────────────────────────────
async function upsertPost(env, row) {
  await env.DB.prepare(`
    INSERT INTO posts (velog_id, title, slug, body, short_description, thumbnail, tags, series_name, display_date, original_date, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      title             = excluded.title,
      body              = excluded.body,
      short_description = excluded.short_description,
      thumbnail         = excluded.thumbnail,
      tags              = excluded.tags,
      series_name       = excluded.series_name,
      display_date      = excluded.display_date,
      synced_at         = excluded.synced_at
  `).bind(
    row.velog_id, row.title, row.slug, row.body,
    row.short_description, row.thumbnail, row.tags,
    row.series_name, row.display_date, row.original_date, row.synced_at,
  ).run();
}

// ─── 유틸 ───────────────────────────────────────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
