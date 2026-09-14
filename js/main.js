let currentSection = 0, touchStartY = 0, touchStartX = 0, scrolling = false, currentVideoIndex = 0;

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

const load         = document.getElementById('load');
const about        = $('.about');
const tapeTop      = $('.tape3');
const tapeBottom   = $('.tape2');
const tv           = $('.tv');
const aboutContent = $('.amain');
const aboutBanner  = $('.about-banner');
const cards        = $('.charts-wrap');
const cursor       = $('.cursor');
const sections     = $$('.section');
const contactItems = $$('.con');
const totalSections = sections.length;

const sectionAnimations = [
    () => { tapeTop.classList.add('scrollAnimation1'); tapeBottom.classList.add('scrollAnimation2'); tv.classList.add('scrollAnimation3'); },
    () => { aboutContent.classList.add('scrollAnimation4'); aboutBanner?.classList.add('scrollAnimation10'); },
    // 캔버스는 폰트가 아직 안 내려왔으면 대체 폰트로 굳어 버리므로, 로드 보장 후 그린다
    () => { cards.classList.add('scrollAnimation6'); document.fonts.load('16px Paperlogy-8ExtraBold').finally(() => { drawRadarChart(); drawLangChart(); }); },
    () => { initProjSlider(); },
    () => contactItems.forEach(el => el.classList.add('scrollAnimation9')),
];

if (cursor) {
    const move = e => { cursor.style.left = `${e.clientX}px`; cursor.style.top = `${e.clientY}px`; };
    // innerWidth 는 스크립트 실행 중 전체 페이지 레이아웃을 강제하므로 matchMedia 로 판정
    const mq = window.matchMedia('(min-width: 1280px)');
    const sync = () => {
        cursor.style.display = mq.matches ? 'block' : 'none';
        window[mq.matches ? 'addEventListener' : 'removeEventListener']('mousemove', move);
    };
    sync();
    mq.addEventListener('change', sync);
}

window.addEventListener('load', () => {
    Object.assign(load.style, { opacity: '0', zIndex: '10003', backgroundColor: '#dbe3e311' });
    setTimeout(() => Object.assign(load.style, { zIndex: '-1', display: 'none' }), 10000);
    window.scrollTo(0, 0);
    scrollToSection(0);
});

document.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' && currentSection < totalSections - 1) scrollToSection(++currentSection);
    if (e.key === 'ArrowUp'   && currentSection > 0)                 scrollToSection(--currentSection);
    if (e.key === 'ArrowRight' && currentSection === 3) navigateProj(1);
    if (e.key === 'ArrowLeft'  && currentSection === 3) navigateProj(-1);
});

document.addEventListener('wheel', e => {
    if (scrolling) return;
    if (Math.abs(e.deltaY) < 40) return;
    scrolling = true;
    handleScroll(e.deltaY > 0);
    setTimeout(() => { scrolling = false; }, 900);
});

let touchScrollBox = null;   // 터치가 시작된 내부 스크롤 영역(차트 목록 등)
document.addEventListener('touchstart', e => {
    touchStartY = e.touches[0].clientY;
    touchStartX = e.touches[0].clientX;
    touchScrollBox = e.target.closest?.('.charts-wrap') || null;
});
document.addEventListener('touchend', e => {
    const diffY = touchStartY - e.changedTouches[0].clientY;
    const diffX = touchStartX - e.changedTouches[0].clientX;
    // 내부 스크롤 영역이 아직 그 방향으로 더 스크롤될 수 있으면 섹션 전환 대신 내부 스크롤로 처리
    if (touchScrollBox && Math.abs(diffY) > Math.abs(diffX)) {
        const b = touchScrollBox, canDown = b.scrollTop + b.clientHeight < b.scrollHeight - 1, canUp = b.scrollTop > 0;
        if ((diffY > 0 && canDown) || (diffY < 0 && canUp)) return;
    }
    if (currentSection === 3 && Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > 30) {
        navigateProj(diffX > 0 ? 1 : -1);
    } else if (Math.abs(diffY) > 30) {
        handleScroll(diffY > 0);
    }
});
document.addEventListener('touchmove', e => {
    if (currentSection === totalSections - 1) e.preventDefault();
}, { passive: false });

function handleScroll(down) {
    const atAbout = currentSection === 1;
    const atProj  = currentSection === 3;
    if (atProj && navigateProj(down ? 1 : -1)) return;
    const canMove = down
        ? (atAbout ? about.scrollHeight - about.clientHeight <= about.scrollTop + 5 : currentSection < totalSections - 1)
        : (atAbout ? about.scrollTop <= 5 : currentSection > 0);
    if (canMove) scrollToSection(currentSection += down ? 1 : -1);
}

// 섹션 높이 단위: iOS 는 100vh 가 주소창 포함 높이라 실제 보이는 영역과 어긋남 → 지원되면 dvh
const VH_UNIT = (window.CSS && CSS.supports('height', '100dvh')) ? 'dvh' : 'vh';
function scrollToSection(idx) {
    sections.forEach((s, i) => {
        s.style.transform = `translateY(-${idx * 100}${VH_UNIT})`;
        s.classList.toggle('active', i === idx);
    });
    sectionAnimations[idx]?.();
}

function setSection(idx) { scrollToSection(currentSection = idx); }

const videos = ['img/home/core1.webm', 'img/home/core2.webm', 'img/home/core3.webm', 'img/home/core4.webm', 'img/home/core5.webm', 'img/home/core6.webm', 'img/home/core7.webm', 'img/home/core8.webm', 'img/home/core9.webm', 'img/home/core10.webm'];

function changeVideo() {
    const v = document.getElementById('tvVideo');
    v.pause();
    v.src = videos[currentVideoIndex = (currentVideoIndex + 1) % videos.length];
    v.load();
    v.onloadeddata = () => v.play();
}

function updateDateTime() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const [Y, M, D, h, m, s] = [d.getFullYear(), p(d.getMonth()+1), p(d.getDate()), p(d.getHours()), p(d.getMinutes()), p(d.getSeconds())];
    document.getElementById('datetime').innerText = `${Y}-${M}-${D} ${h}:${m}:${s}`;
}
setInterval(updateDateTime, 1000);
updateDateTime();

// ── Project Slider ────────────────────────────────────────────────
let projCurrent = 0, projX = 0, projTarget = 0, projRaf = null, projReady = false;
let projTrack, projFillEl, projCounterEl, projSlideEls, projNumEls;

const PROJ_N = 11;

function initProjSlider() {
    if (projReady) return;
    projReady     = true;
    projTrack     = document.getElementById('projTrack');
    projFillEl    = document.getElementById('projFill');
    projCounterEl = document.getElementById('projCounter');
    projSlideEls  = document.querySelectorAll('.proj-slide');
    projNumEls    = document.querySelectorAll('.proj-num');
    document.querySelectorAll('.proj-canvas').forEach((c, i) => drawProjPattern(c, i));
    projSlideEls.forEach((s, i) => s.classList.toggle('active', i === 0));
    updateProjUI();
}

function navigateProj(dir) {
    const next = projCurrent + dir;
    if (next < 0 || next >= PROJ_N) return false;
    projSlideEls[projCurrent]?.classList.remove('active');
    projCurrent = projTarget = next;
    animProjTrack();
    updateProjUI();
    setTimeout(() => projSlideEls[projCurrent]?.classList.add('active'), 350);
    return true;
}

function animProjTrack() {
    if (projRaf) cancelAnimationFrame(projRaf);
    const step = () => {
        projX += (projTarget - projX) * 0.12;
        if (Math.abs(projTarget - projX) < 0.0005) projX = projTarget;
        if (projTrack) projTrack.style.transform = `translateX(${-projX * 100}vw)`;
        projNumEls?.forEach((el, i) => { el.style.transform = `translateX(${(projX - i) * 15}vw)`; });
        if (projX !== projTarget) projRaf = requestAnimationFrame(step);
    };
    projRaf = requestAnimationFrame(step);
}

function updateProjUI() {
    if (projFillEl)    projFillEl.style.width = `${((projCurrent + 1) / PROJ_N) * 100}%`;
    if (projCounterEl) projCounterEl.textContent = `${String(projCurrent + 1).padStart(2, '0')} — ${String(PROJ_N).padStart(2, '0')}`;
}

// ── 블러 선택 해제 (style.css '블러' 주석 참고) ─────────────────────
(function applyBlurOptOut() {
    // getComputedStyle 은 쓰지 않는다 — 스크립트 도중 전체 페이지 스타일 계산을 강제해 로드가 느려짐.
    // 형제에 자기 filter 가 있으면 .blur-sib 가 그것을 덮어쓰므로, 그런 요소는 CSS 에서 직접 합성할 것.
    document.querySelectorAll('.section [data-blur="off"]').forEach(el => {
        for (let node = el; node.parentElement && !node.classList.contains('section'); node = node.parentElement) {
            for (const sib of node.parentElement.children) if (sib !== node) sib.classList.add('blur-sib');
        }
        el.closest('.section')?.classList.add('blur-off');
    });
})();

// ── 차트 공통 ─────────────────────────────────────────────────────
// 화면 폭·높이로 두 차트의 CSS 크기를 정하고, 캔버스는 devicePixelRatio 배로 잡아 선명하게 그린다.
// 모바일은 세로로 쌓이므로(라벨 2줄 + 간격 포함) 스와이프로 섹션이 넘어가는 구조상 스크롤 없이 한 화면에 다 들어가야 한다.
function chartLayout() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const mobile = vw <= 700, tablet = !mobile && vw <= 1023;
    if (mobile) {
        const avail  = vh * 0.86 - 140 - 72;                    // charts-wrap(top 14%) 안, 우하단 Clippy+말풍선(≈140px)·라벨 2줄·간격(≈72px) 제외
        // 레이더는 170px 아래로는 안 줄인다 — 아주 짧은 화면은 차트 영역이 내부 스크롤되도록 둠 (터치 핸들러가 스크롤을 우선 처리)
        const radar  = Math.round(Math.max(170, Math.min(220, vw * 0.62, avail * 0.40)));
        const langW  = Math.round(Math.min(320, vw - 70));      // 좌측 메뉴 아이콘 열(≈35px)과 겹치지 않게
        return { mobile, tablet, dpr: window.devicePixelRatio || 1, radar, langW, langMaxH: avail - radar };
    }
    const radar = Math.round(tablet ? Math.min(300, vw * 0.36) : Math.min(480, vw * 0.36, vh * 0.62));
    const langW = Math.round(tablet ? Math.min(320, vw * 0.40) : Math.min(480, vw * 0.40));
    return { mobile, tablet, dpr: window.devicePixelRatio || 1, radar, langW, langMaxH: vh * 0.72 };
}
function setupCanvas(canvas, cssW, cssH, dpr) {
    canvas.width  = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width  = cssW + 'px';
    canvas.style.height = cssH + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
}

// ── Radar Chart ───────────────────────────────────────────────────
function drawRadarChart() {
    const canvas = document.getElementById('radarChart');
    if (!canvas) return;

    const { mobile, tablet, dpr, radar: size } = chartLayout();
    const ctx = setupCanvas(canvas, size, size, dpr);
    const cx  = size / 2;
    const cy  = size / 2;
    const maxR   = size * (mobile ? 0.28 : tablet ? 0.31 : 0.34);
    const labelR = maxR + size * (mobile ? 0.13 : tablet ? 0.115 : 0.10);

    const easeOut = t => 1 - Math.pow(1 - t, 3);

    const skills = [
        { label: '네트워크',      value: 95, speed: 0.008 + Math.random() * 0.010 },
        { label: '정보보안',      value: 94, speed: 0.008 + Math.random() * 0.010 },
        { label: '백엔드',        value: 90, speed: 0.008 + Math.random() * 0.010 },
        { label: '프론트엔드',    value: 85, speed: 0.008 + Math.random() * 0.010 },
        { label: '운영체제',     value: 79, speed: 0.008 + Math.random() * 0.010 },
        { label: '코딩',        value: 89, speed: 0.008 + Math.random() * 0.010 },
        { label: '알고리즘',     value: 80, speed: 0.008 + Math.random() * 0.010 },
        { label: '데이터베이스', value: 90, speed: 0.008 + Math.random() * 0.010 },
    ];
    const n        = skills.length;
    const levels   = 5;
    const fontSize = Math.max(mobile ? 12 : tablet ? 13 : 15, size * (mobile ? 0.055 : tablet ? 0.045 : 0.034));
    const progs    = skills.map(() => 0);

    const angle = i => (Math.PI * 2 * i / n) - Math.PI / 2;
    const pt    = (r, i) => ({ x: cx + r * Math.cos(angle(i)), y: cy + r * Math.sin(angle(i)) });

    const draw = () => {
        let allDone = true;
        for (let i = 0; i < n; i++) {
            progs[i] = Math.min(1, progs[i] + skills[i].speed);
            if (progs[i] < 1) allDone = false;
        }

        ctx.clearRect(0, 0, size, size);

        for (let l = 1; l <= levels; l++) {
            const r = maxR * l / levels;
            ctx.beginPath();
            for (let i = 0; i < n; i++) {
                const { x, y } = pt(r, i);
                i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            }
            ctx.closePath();
            ctx.strokeStyle = l === levels ? 'rgba(22,22,23,0.25)' : 'rgba(22,22,23,0.1)';
            ctx.lineWidth   = l === levels ? 1.5 : 1;
            ctx.stroke();
        }

        for (let i = 0; i < n; i++) {
            const { x, y } = pt(maxR, i);
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(x, y);
            ctx.strokeStyle = 'rgba(22,22,23,0.15)';
            ctx.setLineDash([3, 4]);
            ctx.lineWidth   = 1;
            ctx.stroke();
            ctx.setLineDash([]);
        }

        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            const { x, y } = pt(maxR * (skills[i].value / 100) * easeOut(progs[i]), i);
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fillStyle   = 'rgba(22,22,23,0.12)';
        ctx.fill();
        ctx.strokeStyle = '#161617';
        ctx.lineWidth   = 2;
        ctx.stroke();

        for (let i = 0; i < n; i++) {
            const { x, y } = pt(maxR * (skills[i].value / 100) * easeOut(progs[i]), i);
            ctx.beginPath();
            ctx.arc(x, y, 3.5, 0, Math.PI * 2);
            ctx.fillStyle   = '#161617';
            ctx.fill();
        }

        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        for (let i = 0; i < n; i++) {
            let { x, y } = pt(labelR, i);
            ctx.font      = `${fontSize}px Paperlogy-8ExtraBold, serif`;
            const halfW   = ctx.measureText(skills[i].label).width / 2 + 2;
            x = Math.min(size - halfW, Math.max(halfW, x));
            ctx.fillStyle = '#161617';
            ctx.fillText(skills[i].label, x, y - fontSize * 0.6);
            ctx.font      = `bold ${fontSize * 0.82}px Paperlogy-8ExtraBold, serif`;
            ctx.fillStyle = 'rgba(22,22,23,0.55)';
            ctx.fillText(skills[i].value + '%', x, y + fontSize * 0.75);
        }

        if (!allDone) requestAnimationFrame(draw);
    };

    draw();
}

// ── Language Bar Chart ────────────────────────────────────────────
function drawLangChart() {
    const canvas = document.getElementById('langChart');
    if (!canvas) return;

    const { mobile, tablet, dpr, langW: w, langMaxH } = chartLayout();
    const groups = [
        { title: '언어', items: [
            { label: 'JavaScript',  value: 90 },
            { label: 'Python',      value: 85 },
            { label: 'HTML / CSS',  value: 83 },
            { label: 'SQL',         value: 80 },
            { label: 'C',           value: 79 },
            { label: 'Java',        value: 75 },
        ]},
        { title: '프레임워크', items: [
            { label: 'FastAPI',     value: 80 },
            { label: 'Spring',      value: 79 },
            { label: 'JPA',         value: 78 },
            { label: 'JSP',         value: 78 },
        ]},
        { title: '인프라 · 도구', items: [
            { label: 'Linux',       value: 85 },
            { label: 'Burp Suite', value: 83 },
            { label: 'Git',         value: 80 },
            { label: 'Redis', value: 60 },
        ]},
    ];
    const langs = groups.flatMap(g => g.items);
    langs.forEach(l => { l.speed = 0.008 + Math.random() * 0.010; });

    // 행 높이: 폭 기준 상한과 '허용 높이 안에 전부 들어가는' 상한 중 작은 값 (h = rowH·행수 + 0.85·rowH·그룹수 + 20)
    const rowByH = (langMaxH - 20) / (langs.length + 0.85 * groups.length);
    const rowH   = Math.max(15, Math.min(mobile ? 26 : 36, (w * 0.95) / langs.length, rowByH));
    const headH  = rowH * 0.85;
    const h      = Math.round(rowH * langs.length + headH * groups.length + 20);
    const ctx    = setupCanvas(canvas, w, h, dpr);
    const barX     = w * (mobile ? 0.36 : 0.30);
    const barW     = w * (mobile ? 0.48 : 0.56);
    const fontSize = Math.min(mobile ? 13 : 16, Math.max(mobile ? 11 : 12, rowH * 0.5));
    const easeOut  = t => 1 - Math.pow(1 - t, 3);
    const progs    = langs.map(() => 0);

    const draw = () => {
        let allDone = true;
        for (let i = 0; i < langs.length; i++) {
            progs[i] = Math.min(1, progs[i] + langs[i].speed);
            if (progs[i] < 1) allDone = false;
        }

        ctx.clearRect(0, 0, w, h);

        let cursor = 0;
        let i      = 0;
        for (const g of groups) {
            const hy = cursor + headH * 0.6;
            ctx.textAlign    = 'left';
            ctx.textBaseline = 'middle';
            ctx.font         = `bold ${fontSize * 0.8}px Paperlogy-8ExtraBold, serif`;
            ctx.fillStyle    = 'rgba(22,22,23,0.45)';
            ctx.fillText(g.title, 0, hy);
            ctx.beginPath();
            ctx.moveTo(0, cursor + headH - 2);
            ctx.lineTo(w, cursor + headH - 2);
            ctx.strokeStyle = 'rgba(22,22,23,0.12)';
            ctx.lineWidth   = 1;
            ctx.stroke();
            cursor += headH;

            for (const item of g.items) {
                const y      = cursor + rowH * 0.5;
                const filled = barW * (item.value / 100) * easeOut(progs[i]);

                ctx.beginPath();
                ctx.roundRect(barX, y - rowH * 0.18, barW, rowH * 0.36, 3);
                ctx.fillStyle = 'rgba(22,22,23,0.08)';
                ctx.fill();

                if (filled > 0) {
                    ctx.beginPath();
                    ctx.roundRect(barX, y - rowH * 0.18, filled, rowH * 0.36, 3);
                    ctx.fillStyle = 'rgba(22,22,23,0.75)';
                    ctx.fill();
                }

                ctx.textAlign    = 'right';
                ctx.textBaseline = 'middle';
                ctx.font         = `${fontSize}px Paperlogy-8ExtraBold, serif`;
                const maxLabelW  = barX - 14;
                const labelW     = ctx.measureText(item.label).width;
                if (labelW > maxLabelW) ctx.font = `${fontSize * maxLabelW / labelW}px Paperlogy-8ExtraBold, serif`;
                ctx.fillStyle    = '#161617';
                ctx.fillText(item.label, barX - 10, y);

                ctx.textAlign = 'left';
                ctx.font      = `${fontSize * 0.82}px Paperlogy-8ExtraBold, serif`;
                ctx.fillStyle = 'rgba(22,22,23,0.45)';
                ctx.fillText(item.value + '%', barX + barW + 8, y);

                cursor += rowH;
                i++;
            }
        }

        if (!allDone) requestAnimationFrame(draw);
    };

    draw();
}

// ── 첫 방문 블로그 안내 대화상자 ───────────────────────────────────
(function () {
    const dialog = document.getElementById('blogDialog');
    if (!dialog || localStorage.getItem('blogDialogShown')) return;

    const close = () => {
        localStorage.setItem('blogDialogShown', '1');
        dialog.classList.remove('is-open');
        setTimeout(() => { dialog.hidden = true; }, 300);
    };
    dialog.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', close));
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !dialog.hidden) close(); });

    // 빌드가 만든 blog/latest.json(수백 B)으로 최신 글 제목을 채운다 (실패해도 대화상자는 그대로 표시)
    fetch('blog/latest.json').then(r => r.json()).then(({ title }) => {
        if (!title) return;
        const latest = document.getElementById('blogDialogLatest');
        latest.textContent = '최신 글: ';
        const b = document.createElement('b'); b.textContent = title; latest.appendChild(b);
    }).catch(() => {});

    // 로딩 타이틀이 어느 정도 걷힌 뒤에 띄운다
    window.addEventListener('load', () => setTimeout(() => {
        dialog.hidden = false;
        requestAnimationFrame(() => requestAnimationFrame(() => dialog.classList.add('is-open')));
    }, 4000));
})();

// ── Clippy ────────────────────────────────────────────────────────
(function () {
    const link = document.getElementById('clippyLink');
    if (!link) return;
    const today = new Date().toDateString();
    if (localStorage.getItem('clippyClickedDate') !== today) link.classList.add('clippy-active');
    link.addEventListener('click', () => {
        localStorage.setItem('clippyClickedDate', today);
        link.classList.remove('clippy-active');
    });
})();

// 저작권 연도 자동 갱신
document.querySelectorAll('.copy-year').forEach(el => { el.textContent = new Date().getFullYear(); });
