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
    () => { cards.classList.add('scrollAnimation6'); drawRadarChart(); drawLangChart(); },
    () => { initProjSlider(); },
    () => contactItems.forEach(el => el.classList.add('scrollAnimation9')),
];

if (cursor) {
    const move = e => { cursor.style.left = `${e.clientX}px`; cursor.style.top = `${e.clientY}px`; };
    const sync = () => {
        const wide = window.innerWidth > 1279;
        cursor.style.display = wide ? 'block' : 'none';
        window[wide ? 'addEventListener' : 'removeEventListener']('mousemove', move);
    };
    sync();
    window.addEventListener('resize', sync);
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

document.addEventListener('touchstart', e => {
    touchStartY = e.touches[0].clientY;
    touchStartX = e.touches[0].clientX;
});
document.addEventListener('touchend', e => {
    const diffY = touchStartY - e.changedTouches[0].clientY;
    const diffX = touchStartX - e.changedTouches[0].clientX;
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

function scrollToSection(idx) {
    sections.forEach((s, i) => {
        s.style.transform = `translateY(-${idx * 100}vh)`;
        s.classList.toggle('active', i === idx);
    });
    sectionAnimations[idx]?.();
}

function setSection(idx) { scrollToSection(currentSection = idx); }

const videos = ['img/home/core1.webm', 'img/home/core2.webm', 'img/home/core3.webm', 'img/home/core4.webm', 'img/home/core5.webm', 'img/home/core6.webm', 'img/home/core7.webm', 'img/home/core8.webm', 'img/home/core9.webm'];

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

const PROJ_N = 9;

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

function drawProjPattern(canvas, idx) {
    const w = window.innerWidth, h = window.innerHeight;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = '#161617';
    ctx.fillStyle   = '#161617';

    if (idx === 0) {
        // scanlines
        ctx.lineWidth = 0.8;
        for (let y = 0; y < h; y += 4) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        }
    } else if (idx === 1) {
        // diagonal crosshatch
        ctx.lineWidth = 0.6;
        for (let x = -h; x < w + h; x += 28) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + h, h); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x - h, h); ctx.stroke();
        }
    } else if (idx === 2) {
        // dot grid
        for (let x = 24; x < w; x += 24) {
            for (let y = 24; y < h; y += 24) {
                ctx.beginPath(); ctx.arc(x, y, 1, 0, Math.PI * 2); ctx.fill();
            }
        }
    } else if (idx === 3) {
        // circuit board
        ctx.lineWidth = 1;
        const g = 32;
        for (let x = g; x < w - g; x += g) {
            for (let y = g; y < h - g; y += g) {
                if (Math.random() > 0.55) {
                    const dir = Math.floor(Math.random() * 4);
                    ctx.beginPath(); ctx.moveTo(x, y);
                    if      (dir === 0) { ctx.lineTo(x + g, y); ctx.lineTo(x + g, y - g * 0.5); }
                    else if (dir === 1) { ctx.lineTo(x, y + g); ctx.lineTo(x + g * 0.5, y + g); }
                    else if (dir === 2) { ctx.lineTo(x - g, y); ctx.lineTo(x - g, y + g * 0.5); }
                    else               { ctx.lineTo(x, y - g); ctx.lineTo(x + g * 0.5, y - g); }
                    ctx.stroke();
                    ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
                }
            }
        }
    } else if (idx === 4) {
        // hexagonal grid
        ctx.lineWidth = 0.8;
        const r = 30, wr = r * Math.sqrt(3), hr = r * 1.5;
        for (let row = -1; row < h / hr + 2; row++) {
            for (let col = -1; col < w / wr + 2; col++) {
                const cx = col * wr + (row % 2 === 0 ? 0 : wr / 2);
                const cy = row * hr;
                ctx.beginPath();
                for (let i = 0; i < 6; i++) {
                    const a = Math.PI / 3 * i - Math.PI / 6;
                    i === 0 ? ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a))
                            : ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
                }
                ctx.closePath(); ctx.stroke();
            }
        }
    } else if (idx === 5) {
        // graph paper (DB schema feel)
        ctx.lineWidth = 0.4;
        const minor = 16, major = 80;
        for (let x = 0; x < w; x += minor) {
            ctx.strokeStyle = x % major === 0 ? 'rgba(22,22,23,0.18)' : 'rgba(22,22,23,0.06)';
            ctx.lineWidth   = x % major === 0 ? 0.8 : 0.4;
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        }
        for (let y = 0; y < h; y += minor) {
            ctx.strokeStyle = y % major === 0 ? 'rgba(22,22,23,0.18)' : 'rgba(22,22,23,0.06)';
            ctx.lineWidth   = y % major === 0 ? 0.8 : 0.4;
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        }
    } else if (idx === 6) {
        // glitch scanlines (cyberpunk / text RPG feel)
        ctx.lineWidth = 1;
        for (let y = 0; y < h; y += 3) {
            const alpha = Math.random() > 0.85 ? 0.12 : 0.04;
            ctx.strokeStyle = `rgba(22,22,23,${alpha})`;
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        }
        for (let i = 0; i < 18; i++) {
            const gy = Math.random() * h;
            const gh = Math.random() * 6 + 1;
            const gx = Math.random() * w * 0.4;
            ctx.fillStyle = 'rgba(22,22,23,0.07)';
            ctx.fillRect(gx, gy, w * (0.3 + Math.random() * 0.5), gh);
        }
    }
}

// ── Radar Chart ───────────────────────────────────────────────────
function drawRadarChart() {
    const canvas = document.getElementById('radarChart');
    if (!canvas) return;

    const mobile = window.innerWidth <= 700;
    const tablet = !mobile && window.innerWidth <= 1023;
    const size = mobile
        ? Math.min(210, window.innerWidth * 0.65)
        : tablet
        ? Math.min(250, window.innerWidth * 0.33)
        : Math.min(340, window.innerWidth * 0.36);
    canvas.width  = size;
    canvas.height = size;

    const ctx = canvas.getContext('2d');
    const cx  = size / 2;
    const cy  = size / 2;
    const maxR   = size * (mobile ? 0.28 : tablet ? 0.31 : 0.34);
    const labelR = maxR + size * (mobile ? 0.13 : tablet ? 0.115 : 0.10);

    const easeOut = t => 1 - Math.pow(1 - t, 3);

    const skills = [
        { label: '네트워크',      value: 95, speed: 0.008 + Math.random() * 0.010 },
        { label: '정보보안',      value: 83, speed: 0.008 + Math.random() * 0.010 },
        { label: '백엔드',        value: 90, speed: 0.008 + Math.random() * 0.010 },
        { label: '언어, 알고리즘',value: 79, speed: 0.008 + Math.random() * 0.010 },
        { label: '암호학',        value: 76, speed: 0.008 + Math.random() * 0.010 },
        { label: '웹 프론트엔드', value: 85, speed: 0.008 + Math.random() * 0.010 },
    ];
    const n        = skills.length;
    const levels   = 5;
    const fontSize = Math.max(mobile ? 13 : tablet ? 12 : 11, size * (mobile ? 0.042 : tablet ? 0.034 : 0.026));
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
            const { x, y } = pt(labelR, i);
            ctx.font      = `${fontSize}px PartialSansKR-Regular, serif`;
            ctx.fillStyle = '#161617';
            ctx.fillText(skills[i].label, x, y - fontSize * 0.6);
            ctx.font      = `bold ${fontSize * 0.82}px PartialSansKR-Regular, serif`;
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

    const mobile = window.innerWidth <= 700;
    const tablet = !mobile && window.innerWidth <= 1023;
    const w = mobile
        ? Math.min(260, window.innerWidth * 0.75)
        : tablet
        ? Math.min(280, window.innerWidth * 0.38)
        : Math.min(380, window.innerWidth * 0.42);
    const langs = [
        { label: 'JavaScript',  value: 90, speed: 0.008 + Math.random() * 0.010 },
        { label: 'SQL',         value: 89, speed: 0.008 + Math.random() * 0.010 },
        { label: 'JPA',         value: 89, speed: 0.008 + Math.random() * 0.010 },
        { label: 'Spring',      value: 88, speed: 0.008 + Math.random() * 0.010 },
        { label: 'JSP',         value: 88, speed: 0.008 + Math.random() * 0.010 },
        { label: 'HTML / CSS',  value: 87, speed: 0.008 + Math.random() * 0.010 },
        { label: 'Java',        value: 86, speed: 0.008 + Math.random() * 0.010 },
        { label: 'Git',         value: 83, speed: 0.008 + Math.random() * 0.010 },
        { label: 'C',           value: 82, speed: 0.008 + Math.random() * 0.010 },
        { label: 'Python',      value: 81, speed: 0.008 + Math.random() * 0.010 },
    ];

    const rowH = Math.min(52, (w * 0.95) / langs.length);
    const h    = rowH * langs.length + 20;
    canvas.width  = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d');
    const barX     = w * (mobile ? 0.42 : 0.30);
    const barW     = w * (mobile ? 0.44 : 0.56);
    const fontSize = Math.max(mobile ? 9 : 10, w * (mobile ? 0.030 : 0.032));
    const easeOut  = t => 1 - Math.pow(1 - t, 3);
    const progs    = langs.map(() => 0);

    const draw = () => {
        let allDone = true;
        for (let i = 0; i < langs.length; i++) {
            progs[i] = Math.min(1, progs[i] + langs[i].speed);
            if (progs[i] < 1) allDone = false;
        }

        ctx.clearRect(0, 0, w, h);

        for (let i = 0; i < langs.length; i++) {
            const y      = i * rowH + rowH * 0.5;
            const filled = barW * (langs[i].value / 100) * easeOut(progs[i]);

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
            ctx.font         = `${fontSize}px PartialSansKR-Regular, serif`;
            ctx.fillStyle    = '#161617';
            ctx.fillText(langs[i].label, barX - 10, y);

            ctx.textAlign = 'left';
            ctx.font      = `${fontSize * 0.82}px PartialSansKR-Regular, serif`;
            ctx.fillStyle = 'rgba(22,22,23,0.45)';
            ctx.fillText(langs[i].value + '%', barX + barW + 8, y);
        }

        if (!allDone) requestAnimationFrame(draw);
    };

    draw();
}

// ── Clippy ────────────────────────────────────────────────────────
(function () {
    if (!localStorage.getItem('clippyAlertShown')) {
        alert('왼쪽 하단에 클릭하면 블로그로 갈 수 있는 클리피 버튼이 있어요!');
        localStorage.setItem('clippyAlertShown', '1');
    }
    const link = document.getElementById('clippyLink');
    if (!link) return;
    const today = new Date().toDateString();
    if (localStorage.getItem('clippyClickedDate') !== today) link.classList.add('clippy-active');
    link.addEventListener('click', () => {
        localStorage.setItem('clippyClickedDate', today);
        link.classList.remove('clippy-active');
    });
})();
