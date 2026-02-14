/**
 * Cloudflare Worker - Velog 동기화 & 블로그 API
 *
 * 환경변수 (Cloudflare Dashboard에서 설정):
 *   SUPABASE_URL      - Supabase 프로젝트 URL
 *   SUPABASE_KEY       - Supabase service_role 키
 *   VELOG_USERNAME     - Velog 유저네임 (njw)
 *   SYNC_SECRET        - 동기화 API 보호용 시크릿 키
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
        const slug = path.replace('/api/posts/', '');
        return await handleGetPost(slug, env);
      }
      return jsonResponse({ error: 'Not Found' }, 404);
    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }
  },
};

// ─── Velog에서 글 가져와서 Supabase에 동기화 ────────────────────
async function handleSync(request, env) {
  // 시크릿 키 검증
  const auth = request.headers.get('Authorization');
  if (auth !== `Bearer ${env.SYNC_SECRET}`) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  // 1. Velog에서 글 목록 가져오기
  const velogPosts = await fetchVelogPosts(env.VELOG_USERNAME);

  let synced = 0;
  for (const post of velogPosts) {
    // 2. 각 글의 상세 내용 가져오기
    const detail = await fetchVelogPost(env.VELOG_USERNAME, post.url_slug);
    if (!detail) continue;

    // 3. Supabase에 upsert
    const row = {
      velog_id: detail.id,
      title: detail.title,
      slug: detail.url_slug,
      body: detail.body,
      short_description: detail.short_description || post.short_description || '',
      thumbnail: detail.thumbnail || post.thumbnail || null,
      tags: detail.tags || [],
      series_name: detail.series?.name || null,
      display_date: detail.released_at,
      original_date: detail.released_at,
      synced_at: new Date().toISOString(),
    };

    await upsertPost(env, row);
    synced++;
  }

  return jsonResponse({ message: `${synced}개 글 동기화 완료` });
}

// ─── 글 목록 API ────────────────────────────────────────────
async function handleGetPosts(url, env) {
  const tag = url.searchParams.get('tag');

  let query = `${env.SUPABASE_URL}/rest/v1/posts?select=id,title,slug,short_description,thumbnail,tags,display_date,series_name&order=display_date.desc`;

  if (tag) {
    query += `&tags=cs.{${tag}}`;
  }

  const res = await fetch(query, {
    headers: {
      apikey: env.SUPABASE_KEY,
      Authorization: `Bearer ${env.SUPABASE_KEY}`,
    },
  });

  const data = await res.json();
  return jsonResponse(data);
}

// ─── 글 상세 API ────────────────────────────────────────────
async function handleGetPost(slug, env) {
  const query = `${env.SUPABASE_URL}/rest/v1/posts?slug=eq.${encodeURIComponent(slug)}&limit=1`;

  const res = await fetch(query, {
    headers: {
      apikey: env.SUPABASE_KEY,
      Authorization: `Bearer ${env.SUPABASE_KEY}`,
    },
  });

  const data = await res.json();
  if (!data || data.length === 0) {
    return jsonResponse({ error: 'Post not found' }, 404);
  }
  return jsonResponse(data[0]);
}

// ─── Velog GraphQL 호출 ─────────────────────────────────────
async function fetchVelogPosts(username) {
  const query = `
    query Posts($username: String!) {
      posts(username: $username) {
        id
        title
        url_slug
        short_description
        thumbnail
        released_at
        tags
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
        id
        title
        url_slug
        body
        short_description
        thumbnail
        released_at
        tags
        series {
          name
        }
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

// ─── Supabase upsert ────────────────────────────────────────
async function upsertPost(env, row) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/posts`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_KEY,
      Authorization: `Bearer ${env.SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('Upsert failed:', text);
  }
}

// ─── 유틸 ───────────────────────────────────────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}
