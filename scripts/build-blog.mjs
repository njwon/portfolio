/**
 * 블로그 정적 페이지 빌드
 *
 * Worker API(D1)에서 글을 받아 blog/posts/<slug>/index.html 로 미리 렌더링하고
 * blog/sitemap.xml, blog/rss.xml 을 생성한다.
 * 검색엔진이 JS 없이도 글 본문·메타를 읽을 수 있게 하기 위한 용도.
 *
 *   cd scripts && npm install && node build-blog.mjs
 */
import { marked } from 'marked';
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_BASE = 'https://blog-api.njwon19.workers.dev';
const SITE     = 'https://njw.kro.kr';
const ROOT     = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT      = join(ROOT, 'blog', 'posts');

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const encSlug = slug => encodeURIComponent(slug);
const postUrl = slug => `${SITE}/blog/posts/${encSlug(slug)}/`;
const fmtDate = iso => {
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
};
const stripMd = md => String(md ?? '')
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/[#>*_`~-]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

marked.use({ breaks: true, gfm: true });

function renderPage(post) {
  const url   = postUrl(post.slug);
  const title = `${post.title} | nogarden.log`;
  const desc  = (post.short_description || stripMd(post.body)).replace(/\s+/g, ' ').trim().slice(0, 150);
  const tags  = post.tags || [];
  const image = post.thumbnail || `${SITE}/img/project/background.jpg`;
  const body  = marked.parse(post.body || '')
    .replace(/<strong>/g, '<b>').replace(/<\/strong>/g, '</b>');

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    mainEntityOfPage: url,
    headline: post.title,
    description: desc,
    image,
    datePublished: post.original_date || post.display_date,
    dateModified: post.display_date,
    keywords: tags.join(', '),
    inLanguage: 'ko',
    author: { '@type': 'Person', '@id': `${SITE}/#person`, name: '노정원', url: SITE + '/' },
    publisher: { '@type': 'Person', name: '노정원', url: SITE + '/' },
  };

  return `<!DOCTYPE html>
<html lang="ko">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(desc)}">
    <meta name="author" content="노정원">
    <meta name="keywords" content="${esc(['노정원', ...tags].join(', '))}">
    <link rel="canonical" href="${url}">
    <meta property="og:type" content="article">
    <meta property="og:locale" content="ko_KR">
    <meta property="og:site_name" content="nogarden.log">
    <meta property="og:title" content="${esc(post.title)}">
    <meta property="og:description" content="${esc(desc)}">
    <meta property="og:image" content="${esc(image)}">
    <meta property="og:url" content="${url}">
    <meta property="article:published_time" content="${esc(post.original_date || post.display_date)}">
    <meta property="article:author" content="${SITE}/">
    ${tags.map(t => `<meta property="article:tag" content="${esc(t)}">`).join('\n    ')}
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(post.title)}">
    <meta name="twitter:description" content="${esc(desc)}">
    <meta name="twitter:image" content="${esc(image)}">
    <script type="application/ld+json">${JSON.stringify(ld)}</script>
    <link rel="alternate" type="application/rss+xml" title="nogarden.log" href="${SITE}/blog/rss.xml">
    <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
    <link rel="preconnect" href="https://fastly.jsdelivr.net" crossorigin>
    <link rel="stylesheet" href="/css/font.css" />
    <link rel="stylesheet" href="/blog/blog.css" />
    <link rel="icon" href="/img/noise/Sarah.webp" />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@5/github-markdown-dark.min.css">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/github-dark.min.css">
    <script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/highlight.min.js" defer></script>
</head>

<body>
    <div class="noise"></div>

    <header class="header" id="header">
        <div class="header-row">
            <div class="header-info">
                <a href="/blog/" class="back-link">&#8592; Blog</a>
                <p class="blog-title">nogarden.log</p>
                <p class="blog-desc">어제보다 더 나은 오늘, 오늘보다 더 나은 내일의 코드를 짠다.</p>
            </div>
        </div>
    </header>

    <main class="post-container">
        <article class="post-article">
            <div class="post-header">
                <h1 class="post-title">${esc(post.title)}</h1>
                <div class="post-meta">
                    <time class="post-date" datetime="${esc(post.display_date)}">${fmtDate(post.display_date)}</time>
                    ${post.series_name ? `<span class="post-series">${esc(post.series_name)}</span>` : ''}
                </div>
                <div class="post-tags">${tags.map(t => `<span class="post-tag">${esc(t)}</span>`).join('')}</div>
            </div>
            ${post.thumbnail ? `<div class="post-thumbnail-wrap"><img class="post-thumbnail" src="${esc(post.thumbnail)}" alt="${esc(post.title)} 썸네일"></div>` : ''}
            <div class="post-body markdown-body">
${body}
            </div>
        </article>
    </main>

    <footer class="blog-footer">
        <div>Copyright &copy;2024 All rights reserved by jeongwon.</div>
    </footer>

    <script>
    (function () {
        var header = document.getElementById('header');
        var scrolled = false;
        window.addEventListener('scroll', function () {
            if (!scrolled && window.scrollY > 120) { scrolled = true; header.classList.add('scrolled'); }
            else if (scrolled && window.scrollY < 30) { scrolled = false; header.classList.remove('scrolled'); }
        });
        window.addEventListener('DOMContentLoaded', function () {
            if (typeof hljs !== 'undefined') document.querySelectorAll('pre code').forEach(function (b) { hljs.highlightElement(b); });
        });
    })();
    </script>
</body>

</html>
`;
}

function renderSitemap(posts) {
  const items = posts.map(p => `  <url>
    <loc>${postUrl(p.slug)}</loc>
    <lastmod>${p.display_date.slice(0, 10)}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE}/blog/</loc>
    <lastmod>${new Date().toISOString().slice(0, 10)}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
${items}
</urlset>
`;
}

function renderRss(posts) {
  const items = posts.map(p => `    <item>
      <title>${esc(p.title)}</title>
      <link>${postUrl(p.slug)}</link>
      <guid isPermaLink="true">${postUrl(p.slug)}</guid>
      <pubDate>${new Date(p.display_date).toUTCString()}</pubDate>
      <description>${esc((p.short_description || stripMd(p.body)).replace(/\s+/g, ' ').trim().slice(0, 300))}</description>
      ${(p.tags || []).map(t => `<category>${esc(t)}</category>`).join('')}
    </item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>nogarden.log</title>
    <link>${SITE}/blog/</link>
    <description>노정원의 개발 블로그 - 네트워크·정보보안·백엔드</description>
    <language>ko</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${SITE}/blog/rss.xml" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`;
}

async function main() {
  const list = await (await fetch(`${API_BASE}/api/posts`)).json();
  if (!Array.isArray(list)) throw new Error('posts API 응답이 배열이 아님: ' + JSON.stringify(list).slice(0, 200));

  const posts = [];
  for (const p of list) {
    const detail = await (await fetch(`${API_BASE}/api/posts/${encSlug(p.slug)}`)).json();
    if (detail.error) { console.warn('skip', p.slug, detail.error); continue; }
    posts.push(detail);
  }
  posts.sort((a, b) => new Date(b.display_date) - new Date(a.display_date));

  // 삭제된 글의 디렉터리 정리
  await mkdir(OUT, { recursive: true });
  const keep = new Set(posts.map(p => p.slug));
  for (const d of await readdir(OUT)) if (!keep.has(d)) await rm(join(OUT, d), { recursive: true });

  for (const p of posts) {
    const dir = join(OUT, p.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.html'), renderPage(p));
  }
  // 목록 페이지는 JS로 그려지므로, 크롤러가 따라갈 수 있는 정적 링크 목록을 심어둔다
  const indexPath = join(ROOT, 'blog', 'index.html');
  const index = await readFile(indexPath, 'utf8');
  const links = `<!-- STATIC-POSTS:START -->
    <nav class="sr-only" aria-label="전체 글 목록">
        <ul>
${posts.map(p => `            <li><a href="posts/${encSlug(p.slug)}/">${esc(p.title)}</a></li>`).join('\n')}
        </ul>
    </nav>
    <!-- STATIC-POSTS:END -->`;
  await writeFile(indexPath, index.replace(/<!-- STATIC-POSTS:START -->[\s\S]*?<!-- STATIC-POSTS:END -->/, links));

  await writeFile(join(ROOT, 'blog', 'sitemap.xml'), renderSitemap(posts));
  await writeFile(join(ROOT, 'blog', 'rss.xml'), renderRss(posts));
  console.log(`${posts.length}개 글 빌드 완료`);
}

main().catch(err => { console.error(err); process.exit(1); });
