/**
 * 블로그 프론트엔드 JavaScript
 */
const API_BASE = 'https://blog-api.njwon19.workers.dev';
const POSTS_PER_PAGE = 5;

// ─── 상태 ───────────────────────────────────────────────────
let allPosts = [];
let currentTag = '';
let currentSearch = '';
let currentPage = 1;

// ─── 현재 페이지 판별 ───────────────────────────────────────
const isPostPage = window.location.pathname.includes('post.html');

if (isPostPage) {
  loadPost();
} else {
  initList();
}

// ─── 목록 페이지 초기화 ─────────────────────────────────────
async function initList() {
  const container = document.getElementById('postsContainer');
  const loading = document.getElementById('loading');

  try {
    const res = await fetch(`${API_BASE}/api/posts`);
    allPosts = await res.json();
    loading.style.display = 'none';

    if (!allPosts || allPosts.length === 0) {
      container.innerHTML = '<div class="empty-message">아직 글이 없습니다.</div>';
      return;
    }

    // 태그 목록 수집 및 렌더링
    const allTags = new Set();
    allPosts.forEach(p => (p.tags || []).forEach(t => allTags.add(t)));
    renderTags(allTags);

    // 검색 이벤트
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
      let debounceTimer;
      searchInput.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          currentSearch = searchInput.value.trim().toLowerCase();
          currentPage = 1;
          renderFiltered();
        }, 300);
      });
    }

    renderFiltered();
  } catch (err) {
    loading.textContent = 'Failed to load posts.';
    console.error(err);
  }
}

// ─── 필터링 + 페이지네이션 렌더링 ───────────────────────────
function renderFiltered() {
  let filtered = allPosts;

  // 태그 필터
  if (currentTag) {
    filtered = filtered.filter(p => (p.tags || []).includes(currentTag));
  }

  // 검색 필터
  if (currentSearch) {
    filtered = filtered.filter(p =>
      (p.title || '').toLowerCase().includes(currentSearch) ||
      (p.short_description || '').toLowerCase().includes(currentSearch)
    );
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / POSTS_PER_PAGE));
  if (currentPage > totalPages) currentPage = totalPages;

  const start = (currentPage - 1) * POSTS_PER_PAGE;
  const paginated = filtered.slice(start, start + POSTS_PER_PAGE);

  renderPostCards(paginated, filtered.length);
  renderPagination(totalPages);
}

// ─── 글 카드 렌더링 ─────────────────────────────────────────
function renderPostCards(posts, totalCount) {
  const container = document.getElementById('postsContainer');

  if (posts.length === 0) {
    container.innerHTML = '<div class="empty-message">검색 결과가 없습니다.</div>';
    return;
  }

  container.innerHTML = posts.map(post => {
    const date = formatDate(post.display_date);
    const tags = (post.tags || []).map(t => `<span class="post-card-tag">${escapeHtml(t)}</span>`).join('');
    const thumb = post.thumbnail
      ? `<img class="post-card-thumb" src="${escapeHtml(post.thumbnail)}" alt="" loading="lazy">`
      : '';

    return `
      <div class="post-card" onclick="goToPost('${escapeHtml(post.slug)}')">
        ${thumb}
        <div class="post-card-content">
          <div class="post-card-title">${escapeHtml(post.title)}</div>
          <div class="post-card-desc">${escapeHtml(post.short_description || '')}</div>
          <div class="post-card-footer">
            <span class="post-card-date">${date}</span>
            <div class="post-card-tags">${tags}</div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ─── 태그 버튼 렌더링 ───────────────────────────────────────
function renderTags(tagSet) {
  const tagList = document.getElementById('tagList');
  if (!tagList) return;

  let html = `<button class="tag-btn ${!currentTag ? 'active' : ''}" onclick="filterByTag('')">All</button>`;
  tagSet.forEach(tag => {
    const isActive = tag === currentTag ? 'active' : '';
    html += `<button class="tag-btn ${isActive}" onclick="filterByTag('${escapeHtml(tag)}')">${escapeHtml(tag)}</button>`;
  });
  tagList.innerHTML = html;
}

function filterByTag(tag) {
  currentTag = tag;
  currentPage = 1;

  // 태그 버튼 active 갱신
  document.querySelectorAll('.tag-btn').forEach(btn => {
    btn.classList.toggle('active', btn.textContent === (tag || 'All'));
  });

  renderFiltered();
}

// ─── 페이지네이션 렌더링 ────────────────────────────────────
function renderPagination(totalPages) {
  const pagination = document.getElementById('pagination');
  if (!pagination || totalPages <= 1) {
    if (pagination) pagination.innerHTML = '';
    return;
  }

  let html = '';

  // 이전 버튼
  html += `<button class="page-btn ${currentPage === 1 ? 'disabled' : ''}"
    onclick="goToPage(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''}>&laquo;</button>`;

  // 페이지 번호
  for (let i = 1; i <= totalPages; i++) {
    html += `<button class="page-btn ${i === currentPage ? 'active' : ''}" onclick="goToPage(${i})">${i}</button>`;
  }

  // 다음 버튼
  html += `<button class="page-btn ${currentPage === totalPages ? 'disabled' : ''}"
    onclick="goToPage(${currentPage + 1})" ${currentPage === totalPages ? 'disabled' : ''}>&raquo;</button>`;

  pagination.innerHTML = html;
}

function goToPage(page) {
  currentPage = page;
  renderFiltered();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─── 글 상세 로드 ───────────────────────────────────────────
async function loadPost() {
  const params = new URLSearchParams(window.location.search);
  const slug = params.get('slug');

  if (!slug) {
    window.location.href = './';
    return;
  }

  const loading = document.getElementById('loading');
  const article = document.getElementById('postArticle');

  try {
    const res = await fetch(`${API_BASE}/api/posts/${encodeURIComponent(slug)}`);
    const post = await res.json();

    if (post.error) {
      loading.textContent = 'Post not found.';
      return;
    }

    document.title = `${post.title} - HURT_ALBOCHILL.log`;
    document.getElementById('postTitle').textContent = post.title;
    document.getElementById('postDate').textContent = formatDate(post.display_date);

    const seriesEl = document.getElementById('postSeries');
    if (post.series_name) {
      seriesEl.textContent = post.series_name;
    } else {
      seriesEl.style.display = 'none';
    }

    const tagsEl = document.getElementById('postTags');
    tagsEl.innerHTML = (post.tags || [])
      .map(t => `<span class="post-tag">${escapeHtml(t)}</span>`)
      .join('');

    if (post.thumbnail) {
      document.getElementById('thumbnailWrap').style.display = 'block';
      document.getElementById('postThumbnail').src = post.thumbnail;
    }

    const bodyEl = document.getElementById('postBody');
    if (typeof marked !== 'undefined') {
      marked.setOptions({ breaks: true, gfm: true });
      bodyEl.innerHTML = marked.parse(post.body || '');
    } else {
      bodyEl.textContent = post.body || '';
    }

    if (typeof hljs !== 'undefined') {
      bodyEl.querySelectorAll('pre code').forEach(block => {
        hljs.highlightElement(block);
      });
    }

    loading.style.display = 'none';
    article.style.display = 'block';
  } catch (err) {
    loading.textContent = 'Failed to load post.';
    console.error(err);
  }
}

// ─── 유틸 ───────────────────────────────────────────────────
function goToPost(slug) {
  window.location.href = `post.html?slug=${encodeURIComponent(slug)}`;
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}. ${month}. ${day}.`;
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
