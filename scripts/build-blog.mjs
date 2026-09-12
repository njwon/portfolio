/**
 * 블로그 정적 페이지 빌드
 *
 * Worker API(D1)에서 글을 받아 blog/posts/<slug>/index.html 로 미리 렌더링하고
 * blog/sitemap.xml, blog/rss.xml 을 생성한다.
 * 루트 sitemap-pages.xml(홈·프로젝트 페이지)도 git 최종 수정일 기준으로 함께 갱신한다.
 * 검색엔진이 JS 없이도 글 본문·메타를 읽을 수 있게 하기 위한 용도.
 *
 *   cd scripts && npm install && node build-blog.mjs
 */
import { marked } from 'marked';
import hljs from 'highlight.js';
import { mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const API_BASE = 'https://blog-api.njwon19.workers.dev';
const SITE     = 'https://njw.kro.kr';
const ROOT     = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT      = join(ROOT, 'blog', 'posts');

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const encSlug = slug => encodeURIComponent(slug);
const cdata   = html => String(html).split(']]>').join(']]]]><![CDATA[>');
const postUrl = slug => `${SITE}/blog/posts/${encSlug(slug)}/`;
// 날짜는 실행 환경(로컬 KST / GitHub 러너 UTC)과 무관하게 항상 한국시간 기준으로 표기
const kstYmd  = iso => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 10);
const fmtDate = iso => kstYmd(iso).replace(/-/g, '.');
const stripMd = md => String(md ?? '')
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/[#>*_`~-]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// 본문 마크다운의 # 제목은 h2부터 시작(페이지 h1은 글 제목 하나만), 이미지는 lazy + alt 보완
let currentTitle = '';
marked.use({
  breaks: true,
  gfm: true,
  renderer: {
    heading(text, level) {                     // marked v9 시그니처
      const d = Math.min(level + 1, 6);
      return `<h${d}>${text}</h${d}>\n`;
    },
    // 코드 하이라이팅을 빌드 시점에 처리 → 클라이언트에서 highlight.js 실행 불필요
    code(code, infostring) {
      const lang = (infostring || '').trim().split(/\s+/)[0];
      const out = lang && hljs.getLanguage(lang)
        ? hljs.highlight(code, { language: lang, ignoreIllegals: true })
        : hljs.highlightAuto(code);
      const cls = out.language ? ` class="hljs language-${esc(out.language)}"` : ' class="hljs"';
      return `<pre><code${cls}>${out.value}</code></pre>\n`;
    },
    image(href, title, text) {
      const alt = text || currentTitle;
      const t = title ? ` title="${esc(title)}"` : '';
      return `<img src="${esc(href)}" alt="${esc(alt)}"${t} loading="lazy" decoding="async">`;
    },
  },
});

// description: 문장 경계에서 자르기 (단어 중간에서 끊기지 않게)
function summarize(post, max = 120) {
  const text = (post.short_description || stripMd(post.body)).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf('다.'), cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (end > max * 0.4) return cut.slice(0, end + (cut[end] === '다' ? 2 : 1)).trim();
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).trim() + '…';
}

function renderBody(post) {
  currentTitle = post.title;
  return marked.parse(post.body || '').replace(/<strong>/g, '<b>').replace(/<\/strong>/g, '</b>');
}

function renderPage(post) {
  const url   = postUrl(post.slug);
  const title = `${post.title} | nogarden.log`;
  const desc  = summarize(post);
  currentTitle = post.title;
  const tags  = post.tags || [];
  const image = post.thumbnail || `${SITE}/img/project/background.jpg`;
  const body  = renderBody(post);

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
    <link rel="alternate" type="application/rss+xml" title="nogarden.log — 노정원 개발 블로그" href="${SITE}/blog/rss.xml">
    <link rel="me" href="https://github.com/njwon">
    <link rel="me" href="https://velog.io/@njw">
    <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
    <link rel="preconnect" href="https://fastly.jsdelivr.net" crossorigin>
    <link rel="preconnect" href="https://velog.velcdn.com">
    <link rel="stylesheet" href="/css/font.css" />
    <link rel="stylesheet" href="https://fastly.jsdelivr.net/gh/orioncactus/pretendard@1.3.9/dist/web/static/pretendard-dynamic-subset.css">
    <link rel="stylesheet" href="/blog/blog.css" />
    <link rel="icon" href="${SITE}/favicon.ico" sizes="48x48">
    <link rel="icon" href="${SITE}/img/favicon.png" type="image/png" sizes="192x192">
    <link rel="apple-touch-icon" href="${SITE}/img/apple-touch-icon.png">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@5/github-markdown-dark.min.css" media="print" onload="this.media='all'">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/github-dark.min.css" media="print" onload="this.media='all'">
    <noscript>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@5/github-markdown-dark.min.css">
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/github-dark.min.css">
    </noscript>
</head>

<body>
    <div class="noise"></div>

    <header class="header" id="header">
        <div class="header-row">
            <div class="header-info">
                <a href="/blog/" class="back-link">&#8592; Blog</a>
                <p class="blog-title"><a href="/blog/" style="color:inherit;text-decoration:none">nogarden.log</a></p>
                <p class="blog-desc"><a href="/" rel="author" style="color:inherit">노정원(njwon)</a>의 개발 블로그 · 어제보다 더 나은 오늘, 오늘보다 더 나은 내일의 코드를 짠다.</p>
            </div>
        </div>
    </header>

    <main class="post-container">
        <article class="post-article">
            <div class="post-header">
                <h1 class="post-title">${esc(post.title)}</h1>
                <div class="post-meta">
                    <a class="post-author" href="/" rel="author">노정원</a>
                    <time class="post-date" datetime="${esc(post.display_date)}">${fmtDate(post.display_date)}</time>
                    ${post.series_name ? `<span class="post-series">${esc(post.series_name)}</span>` : ''}
                </div>
                <div class="post-tags">${tags.map(t => `<span class="post-tag">${esc(t)}</span>`).join('')}</div>
            </div>
            ${post.thumbnail ? `<div class="post-thumbnail-wrap"><img class="post-thumbnail" src="${esc(post.thumbnail)}" alt="${esc(post.title)} 썸네일"></div>` : ''}
            <div class="post-body markdown-body">
${body}
            </div>
            <aside class="author-box">
                <img src="/img/about/me.webp" width="56" height="56" alt="노정원 프로필 사진" loading="lazy">
                <div>
                    <strong>노정원 (njwon)</strong>
                    <p>수원정보과학고등학교에 재학 중인 네트워크·정보보안·백엔드·인프라 개발자.
                    <a href="/" rel="author">포트폴리오 보기</a> · <a href="https://github.com/njwon" rel="me noopener" target="_blank">GitHub</a> · <a href="https://velog.io/@njw" rel="me noopener" target="_blank">Velog</a></p>
                </div>
            </aside>
        </article>
    </main>

    <footer class="blog-footer">
        <div>Copyright &copy;2024–<span class="copy-year">${new Date().getFullYear()}</span> All rights reserved by jeongwon.</div>
    </footer>

    <script>
    document.querySelectorAll('.copy-year').forEach(function (el) { el.textContent = new Date().getFullYear(); });
    (function () {
        var header = document.getElementById('header');
        var scrolled = false;
        window.addEventListener('scroll', function () {
            if (!scrolled && window.scrollY > 120) { scrolled = true; header.classList.add('scrolled'); }
            else if (scrolled && window.scrollY < 30) { scrolled = false; header.classList.remove('scrolled'); }
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
    <lastmod>${kstYmd(p.display_date)}</lastmod>
  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE}/blog/</loc>
    <lastmod>${posts[0] ? kstYmd(posts[0].display_date) : kstYmd(Date.now())}</lastmod>
  </url>
${items}
</urlset>
`;
}

// 파일이 마지막으로 바뀐 커밋 날짜(YYYY-MM-DD). git 이력이 없으면 파일 mtime 으로 대체
async function lastMod(relPath) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', relPath], { cwd: ROOT }).toString().trim();
    if (out) return out;
  } catch {}
  return (await stat(join(ROOT, relPath))).mtime.toISOString().slice(0, 10);
}

// 홈 + projects/*/index.html 을 훑어 루트 사이트맵을 만든다
async function renderPagesSitemap() {
  const pages = [{ url: `${SITE}/`, path: 'index.html' }];
  const projDir = join(ROOT, 'projects');
  for (const d of (await readdir(projDir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort()) {
    try {
      await stat(join(projDir, d, 'index.html'));
      pages.push({ url: `${SITE}/projects/${d}/`, path: `projects/${d}/index.html` });
    } catch {}
  }
  const items = [];
  for (const p of pages) items.push(`  <url>
    <loc>${p.url}</loc>
    <lastmod>${await lastMod(p.path)}</lastmod>
  </url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${items.join('\n')}
</urlset>
`;
}

function renderRss(posts) {
  const items = posts.map(p => `    <item>
      <title>${esc(p.title)}</title>
      <link>${postUrl(p.slug)}</link>
      <guid isPermaLink="true">${postUrl(p.slug)}</guid>
      <pubDate>${new Date(p.display_date).toUTCString()}</pubDate>
      <description><![CDATA[${cdata(renderBody(p))}]]></description>
      <author>njwon19@gmail.com (노정원)</author>
      ${(p.tags || []).map(t => `<category>${esc(t)}</category>`).join('')}
    </item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>nogarden.log</title>
    <link>${SITE}/blog/</link>
    <description>노정원의 개발 블로그 - 네트워크·정보보안·백엔드</description>
    <language>ko</language>
    <lastBuildDate>${new Date(posts[0]?.display_date ?? Date.now()).toUTCString()}</lastBuildDate>
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
  const cards = `<!-- STATIC-CARDS:START -->
${posts.slice(0, 5).map((p, i) => `        <a class="post-card post-card-link" href="posts/${encSlug(p.slug)}/">
            ${p.thumbnail ? `<img class="post-card-thumb" src="${esc(p.thumbnail)}" alt="${esc(p.title)} 썸네일"${i < 2 ? ' fetchpriority="high"' : ' loading="lazy"'}>` : ''}
            <div class="post-card-content">
                ${p.series_name ? `<span class="post-card-series">${esc(p.series_name)}</span>` : ''}
                <div class="post-card-title">${esc(p.title)}</div>
                <div class="post-card-desc">${esc(summarize(p, 100))}</div>
                <div class="post-card-footer"><div class="post-card-tags">${(p.tags || []).map(t => `<span class="post-card-tag">${esc(t)}</span>`).join('')}</div></div>
            </div>
        </a>`).join('\n')}
        <!-- STATIC-CARDS:END -->`;
  await writeFile(indexPath, index
    .replace(/<!-- STATIC-POSTS:START -->[\s\S]*?<!-- STATIC-POSTS:END -->/, links)
    .replace(/<!-- STATIC-CARDS:START -->[\s\S]*?<!-- STATIC-CARDS:END -->/, cards));

  await writeFile(join(ROOT, 'blog', 'sitemap.xml'), renderSitemap(posts));
  await writeFile(join(ROOT, 'blog', 'rss.xml'), renderRss(posts));
  await writeFile(join(ROOT, 'sitemap-pages.xml'), await renderPagesSitemap());
  console.log(`${posts.length}개 글 빌드 완료`);
}

main().catch(err => { console.error(err); process.exit(1); });
