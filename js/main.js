let currentSection = 0, touchStartY = 0, touchStartX = 0, scrolling = false;

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

// deltaMode 가 줄(1)/페이지(2) 단위인 브라우저(Firefox 일부 설정)도 픽셀 기준으로 맞춘다
const wheelPx = e => e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1);
document.addEventListener('wheel', e => {
    if (scrolling) return;
    if (Math.abs(wheelPx(e)) < 40) return;
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

// 소개 섹션 안 링크: 목차 번호 → 해당 문단, 문단 번호 → 목차, 제목 → 맨 위. 소개 박스(.about) 안에서만 스크롤
function scrollAbout(id) {
    if (currentSection !== 1) setSection(1);
    const box = about;
    if (id === 'top') box.scrollTo({ top: 0, behavior: 'smooth' });
    else {
        const el = document.getElementById(id);
        if (el) box.scrollTo({ top: el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 12, behavior: 'smooth' });
    }
    return false;
}

// ── TV 영상 ──────────────────────────────────────────────────────
// img/tv/ 에 영상만 넣으면 됨: 목록(img/tv/videos.json)은 scripts/build-tv-list.py 가 만들고,
// 푸시하면 GitHub Actions(tv-videos.yml)가 자동 갱신. 클릭할 때마다 목록에서 방금 것만 빼고 무작위로 고름
const TV_DIR = 'img/tv/';
let tvVideoList = null, tvCurrentVideo = '';
const loadTvVideos = () => tvVideoList ??= fetch(TV_DIR + 'videos.json')
    .then(r => (r.ok ? r.json() : []))
    .then(list => (Array.isArray(list) ? list : []))
    .catch(() => []);

// ── TV 깨기 ──────────────────────────────────────────────────────
// 클릭한 자리에 거미줄 모양 금을 SVG 로 한 번 그려 쌓는다 (애니메이션 루프 없음, 새로고침하면 사라짐)
//
// 물리 모델 (브라운관 앞유리 = 두꺼운 서냉 유리)
//  · 한 번 맞으면 충격점에서 방사형 금 + 동심원 금이 생긴다. 금이 생겨도 조각들은 서로 맞물려(interlock)
//    마찰로 붙들려 있어 바로 떨어지지 않는다.
//  · 조각이 빠지려면 사방이 금으로 완전히 둘러싸여야 한다. 한 점에서 퍼진 방사형 금끼리는 서로 만나지 않으므로
//    충격 한 번으로는 잘 안 빠지고, 서로 다른 충격의 금이 같은 자리에서 교차·누적될수록 조각이 잘게 갇힌다.
//    → 화면을 50×50 칸으로 나눠 칸마다 "금 길이 밀도"(= 조각이 얼마나 잘게 갇혔는지)를 쌓는다.
//      충격 한 번이 한 칸에 주는 양은 TV_DMG_CAP 으로 제한(한 방사 계열만으로는 조각이 닫히지 않음),
//      다른 충격의 금이 이미 지나간 칸이면 교차점만큼 더 부서진다(TV_CROSS: 교차 수 ∝ 새 금 × 기존 금).
//      충격점 바로 아래는 분쇄 영역(Hertz 원뿔 균열)이라 TV_CORE 만큼 더 부서진다.
//  · 밀도가 TV_DETACH 를 넘은 칸은 떨어져 나간다. 이웃 대부분이 빠져 지지를 잃은 칸은 그보다 적게 금 가도 빠진다.
//    매 충격마다 화면 전체를 다시 보므로, 방금 친 곳이 아니어도 금이 많이 겹친 곳은 같이 빠진다.
//  · 금은 자유 경계(이미 뚫린 구멍)를 넘어 전파되지 못한다 → 새 금은 구멍 가장자리에서 멈춘다.
//    구멍 안을 치면 유리가 없으니 금도, 손상도, 모양 변화도 없다.
//  · 떨어지는 조각: 충격량에 따른 초기 속도 + 중력 포물선 + 회전·텀블링(scaleX/Y 로 흉내낸 3D 회전) + 원근.
//    화면 높이 ≈ 30cm 로 잡아 중력을 환산하고, 실제 속도는 너무 빨라 TV_SLOW 배속(슬로모션)으로 보여준다.
//    궤적은 클릭 때 한 번 계산해 WAAPI 키프레임으로 재생 → 끝나면 조각 DOM 삭제 (상시 루프/타이머 없음).
const TV_CRACK_MAX = 40;          // 이 이상은 더 안 그림 (DOM 이 무한히 커지지 않게)
const TV_N = 50, TV_CELL = 1000 / TV_N;   // 손상 격자 (칸 하나 = 20 단위 ≈ 8mm)
const TV_DMG_CAP = 26;            // 충격 한 번이 한 칸에 줄 수 있는 금 길이 상한
const TV_CROSS = 0.5;             // 교차 계수: 기존 금 1칸 길이당 새 금 손상이 이만큼 더 커짐 (최대 3칸 길이까지)
const TV_CORE = 18, TV_CORE_R = 30;       // 충격점 분쇄 영역: 세기, 반경(가우시안 σ)
const TV_DETACH = 165;            // 칸 손상이 이 이상이면 조각이 갇혀 떨어짐 (클수록 잘 안 뚫림)
const TV_LOOSE = 0.35;            // 옆이 빠져 자유 경계가 생긴 칸은 TV_DETACH×이 비율만 넘어도 떨어짐
const TV_PEEL = 6;                // 그렇게 연달아 벗겨지는 최대 겹 수 (한 번에 구멍이 너무 커지지 않게)
const TV_MIN_HOLE = 2;            // 기존 구멍에 붙지 않은 새 구멍의 최소 칸 수 (한 칸짜리 점 구멍 방지)
const TV_MM = 761 / 300;          // 보이는 화면 높이(y 87~848 = 761 단위) ≈ 30cm → 1mm = 2.54 단위
const TV_GRAV = 9810 * TV_MM;     // 중력 9.81 m/s² 를 단위/s² 로
const TV_SLOW = 0.2;              // 시간 배율: 실제 0.1~0.2초면 끝나는 낙하를 5배 느리게(슬로모션) 보여줌
const TV_SLOW_FLY = 0.11;         // TV 밖으로 튀어나와 떨어지는 조각은 약 9배 느리게 (화면 아래까지 가는 게 보이게)
const TV_EYE = 600 * TV_MM;       // 보는 사람까지 거리 60cm (원근 축소/확대)
const TV_VP = [478, 468];         // 원근 소실점 = 보이는 화면 가운데
const tvS = {
    count: 0,
    dmg: new Float32Array(TV_N * TV_N),   // 칸별 누적 손상
    len: new Float32Array(TV_N * TV_N),   // 칸별 누적 금 길이 (교차 계산용)
    gone: new Uint8Array(TV_N * TV_N),    // 칸별 떨어져 나감 여부
    pts: [],                              // 칸별 금 위의 점들 (구멍 테두리를 금 선에 붙일 때 씀)
    corners: new Map(),                   // 테두리 꼭짓점 → 금에 붙인 실제 위치 (한 번 정하면 고정 → 구멍 모양 불변)
};
const tvRnd = (a, b) => a + Math.random() * (b - a);
const tvF = n => n.toFixed(1);
function tvCellAt(x, y) {
    const i = Math.floor(x / TV_CELL), j = Math.floor(y / TV_CELL);
    return i < 0 || j < 0 || i >= TV_N || j >= TV_N ? -1 : j * TV_N + i;
}
const tvIsGone = (x, y) => { const c = tvCellAt(x, y); return c >= 0 && tvS.gone[c] === 1; };
// a→b 로 금이 뻗다가 구멍(자유 경계)을 만나면 그 직전에서 멈춤
function tvCut(a, b) {
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4));
    let prev = a;
    for (let k = 1; k <= n; k++) {
        const p = [a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n];
        if (tvIsGone(p[0], p[1])) return { p: prev, cut: true };
        prev = p;
    }
    return { p: b, cut: false };
}

function crackTV(e) {
    const tvBox = document.querySelector('.tv-container');
    if (tvBox) {                                                      // 흔들림 재시작
        tvBox.classList.remove('tv-hit');
        void tvBox.offsetWidth;
        tvBox.classList.add('tv-hit');
    }
    const svg = document.getElementById('tvCracks');
    if (!svg || tvS.count >= TV_CRACK_MAX) return;

    // 클릭 위치 → 화면(유리) 안 0~1000 좌표. 프레임을 눌렀으면 화면 가장자리 쪽으로 붙임
    const r = svg.getBoundingClientRect();
    const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
    // 보이는 화면 구멍은 대략 x 15~940, y 87~848 (CSS clip-path 와 같은 영역)
    const cx = e && r.width ? clamp((e.clientX - r.left) / r.width * 1000, 70, 890) : 200 + Math.random() * 600;
    const cy = e && r.height ? clamp((e.clientY - r.top) / r.height * 1000, 140, 790) : 250 + Math.random() * 450;
    if (tvIsGone(cx, cy)) return;                                     // 구멍 안: 유리가 없으니 아무 일도 없음
    tvS.count++;

    const rnd = tvRnd;
    const rays = Math.round(rnd(9, 14));
    const size = rnd(280, 500);
    const ringFracs = [0.18, 0.38, 0.62].filter(() => Math.random() < 0.85);
    const raysPts = [];                                                // 각 방사선의 꺾인 점들
    const polys = [];                                                  // 손상 계산용 금 선 목록
    let d = '';
    for (let i = 0; i < rays; i++) {
        const base = (i / rays) * Math.PI * 2 + rnd(-0.25, 0.25);
        const len = size * rnd(0.55, 1.15);
        const pts = [[cx, cy]];
        let ang = base, dist = 0;
        while (dist < len) {
            dist = Math.min(len, dist + rnd(28, 70));
            ang += rnd(-0.22, 0.22);
            const q = tvCut(pts[pts.length - 1], [cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist]);
            pts.push(q.p);
            if (q.cut) break;                                          // 구멍 가장자리에서 금이 멈춤
        }
        raysPts.push({ pts, len });
        polys.push(pts);
        d += 'M' + pts.map(p => tvF(p[0]) + ' ' + tvF(p[1])).join('L');
    }
    // 고리(방사선 사이를 잇는 금) — 방사선 위의 비슷한 거리 점끼리 연결
    const at = (ray, frac) => ray.pts[Math.min(ray.pts.length - 1, Math.max(1, Math.round(frac * (ray.pts.length - 1))))];
    for (const f of ringFracs) {
        for (let i = 0; i < rays; i++) {
            if (Math.random() < 0.3) continue;                            // 군데군데 끊어지게
            const a = at(raysPts[i], f * rnd(0.85, 1.15)), b = at(raysPts[(i + 1) % rays], f * rnd(0.85, 1.15));
            const m = [(a[0] + b[0]) / 2 + rnd(-12, 12), (a[1] + b[1]) / 2 + rnd(-12, 12)];
            if (tvCut(a, m).cut || tvCut(m, b).cut) continue;           // 구멍을 가로지르는 고리는 없음
            polys.push([a, m, b]);
            d += `M${tvF(a[0])} ${tvF(a[1])}L${tvF(m[0])} ${tvF(m[1])}L${tvF(b[0])} ${tvF(b[1])}`;
        }
    }
    // 충격점 주변 부서진 유리 조각 (옅은 흰 면)
    const shard = raysPts.map(ray => at(ray, 0.12)).map(p => tvF(p[0]) + ' ' + tvF(p[1])).join('L');

    const { cracks } = tvLayers(svg);
    const g = svgEl('g');
    for (const [cls, dd] of [['crack-shard', 'M' + shard + 'Z'], ['crack-shadow', d], ['crack-line', d]]) {
        g.appendChild(svgEl('path', { class: cls, d: dd }));
    }
    cracks.appendChild(g);

    tvAddDamage(polys, cx, cy);
    tvDetach(svg, cx, cy);
}

// 금 선 길이를 칸에 래스터화해 손상으로 누적 (+ 충격점 분쇄 영역)
function tvAddDamage(polys, cx, cy) {
    const acc = new Map();
    for (const pts of polys) {
        for (let k = 1; k < pts.length; k++) {
            const a = pts[k - 1], b = pts[k];
            const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
            const n = Math.max(1, Math.ceil(L / 5));
            for (let s = 0; s < n; s++) {
                const t = (s + 0.5) / n, x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
                const c = tvCellAt(x, y);
                if (c < 0) continue;
                acc.set(c, (acc.get(c) || 0) + L / n);
                (tvS.pts[c] || (tvS.pts[c] = [])).push(x, y);
            }
        }
    }
    // 손상 = 이번 금 길이(칸당 상한) × (1 + 교차 계수 × 이미 있던 금 길이)
    //  닫힌 조각 수는 서로 다른 금 계열의 교차점 수(≈ 새 금 길이 × 기존 금 길이)에 비례하므로,
    //  예전 충격의 금이 지나간 칸에 새 금이 겹칠수록 훨씬 빨리 부서진다. 첫 충격 혼자서는 교차 항이 0.
    for (const [c, v] of acc) {
        const a = Math.min(v, TV_DMG_CAP);
        tvS.dmg[c] += a * (1 + TV_CROSS * Math.min(tvS.len[c], 3 * TV_CELL) / TV_CELL);
    }
    for (const [c, v] of acc) tvS.len[c] += v;
    const R = TV_CORE_R, i0 = Math.floor((cx - 3 * R) / TV_CELL), i1 = Math.floor((cx + 3 * R) / TV_CELL);
    const j0 = Math.floor((cy - 3 * R) / TV_CELL), j1 = Math.floor((cy + 3 * R) / TV_CELL);
    for (let j = Math.max(0, j0); j <= Math.min(TV_N - 1, j1); j++) {
        for (let i = Math.max(0, i0); i <= Math.min(TV_N - 1, i1); i++) {
            const dx = (i + 0.5) * TV_CELL - cx, dy = (j + 0.5) * TV_CELL - cy;
            tvS.dmg[j * TV_N + i] += TV_CORE * Math.exp(-(dx * dx + dy * dy) / (2 * R * R));
        }
    }
}

// 구멍/조각 테두리는 칸 중심 격자에서 marching squares 로 뽑는다 (칸 사각형 그대로면 계단·격자 모양이 됨).
//  테두리 꼭짓점 = 안/밖 칸 사이 변의 중점 → 가까운 금 위의 점에 붙임 (테두리가 금 선을 따라감), 없으면 살짝 흔듦.
//  꼭짓점 사이에도 금에 붙인 점을 하나 더 넣어 들쭉날쭉하게.
//  한 번 정한 위치는 고정이라 이미 뚫린 구멍의 모양은 이후 어떤 클릭에도 바뀌지 않고, 구멍·가장자리·조각의 선이 정확히 맞는다.
function tvSnap(key, x0, y0, R, jx, jy) {
    let p = tvS.corners.get(key);
    if (p) return p;
    let bd = R * R;
    const i0 = Math.floor((x0 - R) / TV_CELL), i1 = Math.floor((x0 + R) / TV_CELL);
    const j0 = Math.floor((y0 - R) / TV_CELL), j1 = Math.floor((y0 + R) / TV_CELL);
    for (let jj = Math.max(0, j0); jj <= Math.min(TV_N - 1, j1); jj++) {
        for (let ii = Math.max(0, i0); ii <= Math.min(TV_N - 1, i1); ii++) {
            const a = tvS.pts[jj * TV_N + ii];
            if (!a) continue;
            for (let m = 0; m < a.length; m += 2) {
                const d2 = (a[m] - x0) ** 2 + (a[m + 1] - y0) ** 2;
                if (d2 < bd) { bd = d2; p = [a[m], a[m + 1]]; }
            }
        }
    }
    if (!p) { const k = tvRnd(-1, 1); p = [x0 + k * jx, y0 + k * jy]; }
    tvS.corners.set(key, p);
    return p;
}
// 칸 (i,j) 와 (i+1,j) 사이(dir 0) 또는 (i,j) 와 (i,j+1) 사이(dir 1) 변의 중점
function tvMid(i, j, dir) {
    const x0 = (i + (dir ? 0.5 : 1)) * TV_CELL, y0 = (j + (dir ? 1 : 0.5)) * TV_CELL;
    const r = TV_CELL * 0.3;
    return tvSnap(((j + 1) * (TV_N + 2) + i + 1) * 2 + dir, x0, y0, TV_CELL * 0.45, dir ? 0 : r, dir ? r : 0);
}
// 테두리 두 꼭짓점 사이에 넣는 들쭉날쭉한 점
function tvJag(a, b) {
    const key = a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]) ? `${a}|${b}` : `${b}|${a}`;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return tvSnap(key, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, L * 0.3, -(b[1] - a[1]) * 0.18, (b[0] - a[0]) * 0.18);
}
const tvPath = (pts, ox, oy) => pts.map(p => tvF(p[0] - ox) + ' ' + tvF(p[1] - oy)).join('L');
// cells 주변 사각형들(꼭짓점 = 칸 중심 4개)에서 inside 영역의 면(fill)과 깨진 가장자리 선(rim) 경로
function tvMarch(cells, inside, ox = 0, oy = 0) {
    const sq = new Set();
    for (const c of cells) {
        const i = c % TV_N, j = (c / TV_N) | 0;
        for (let dj = -1; dj <= 0; dj++) for (let di = -1; di <= 0; di++) sq.add((j + dj + 1) * (TV_N + 1) + i + di + 1);
    }
    const isIn = (i, j) => i >= 0 && j >= 0 && i < TV_N && j < TV_N && inside(j * TV_N + i);
    let fill = '', rim = '';
    for (const s of sq) {
        const i = s % (TV_N + 1) - 1, j = ((s / (TV_N + 1)) | 0) - 1;
        const cs = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
        const ins = cs.map(([a, b]) => isIn(a, b));
        if (!ins.some(Boolean)) continue;
        // 네 변의 중점: 위(→), 오른쪽(↓), 아래(→), 왼쪽(↓)
        const mid = k => [() => tvMid(i, j, 0), () => tvMid(i + 1, j, 1), () => tvMid(i, j + 1, 0), () => tvMid(i, j, 1)][k]();
        const pts = [];                                                // { p, m: 중점 여부 }
        for (let k = 0; k < 4; k++) {
            if (ins[k]) pts.push({ p: [(cs[k][0] + 0.5) * TV_CELL, (cs[k][1] + 0.5) * TV_CELL] });
            if (ins[k] !== ins[(k + 1) % 4]) pts.push({ p: mid(k), m: true });
        }
        const poly = [];
        pts.forEach((q, k) => {
            const n = pts[(k + 1) % pts.length];
            poly.push(q.p);
            if (q.m && n.m) {                                          // 중점 → 중점 = 깨진 가장자리
                const jag = tvJag(q.p, n.p);
                poly.push(jag);
                rim += 'M' + tvPath([q.p, jag, n.p], ox, oy);
            }
        });
        fill += 'M' + tvPath(poly, ox, oy) + 'Z';
    }
    return { fill, rim };
}
function tvNbrs(c, diag) {
    const i = c % TV_N, j = (c / TV_N) | 0, out = [];
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if ((!di && !dj) || (!diag && di && dj)) continue;
        const ii = i + di, jj = j + dj;
        if (ii >= 0 && jj >= 0 && ii < TV_N && jj < TV_N) out.push(jj * TV_N + ii);
    }
    return out;
}

// 화면 전체에서 떨어질 칸을 찾아 구멍으로 만들고 조각을 떨어뜨림
function tvDetach(svg, cx, cy) {
    const N2 = TV_N * TV_N, cand = new Uint8Array(N2);
    let any = false;
    for (let c = 0; c < N2; c++) if (!tvS.gone[c] && tvS.dmg[c] >= TV_DETACH) { cand[c] = 1; any = true; }
    if (!any) return;
    // 지지 상실: 옆 조각이 빠져 자유 경계가 생기면 맞물림(압축으로 버티던 힘)이 풀려 더 적게 금 간 조각도 빠짐.
    //  한 변이 비면 TV_DETACH×TV_LOOSE, 이웃 8칸 중 5칸 이상 비면 그 절반만 넘어도 떨어짐. 한 겹씩 TV_PEEL 겹까지
    for (let pass = 0; pass < TV_PEEL; pass++) {
        const snap = cand.slice(), add = [];
        const free = n => tvS.gone[n] || snap[n];
        for (let c = 0; c < N2; c++) {
            if (tvS.gone[c] || snap[c] || tvS.dmg[c] < TV_DETACH * TV_LOOSE * 0.5) continue;
            if (!tvNbrs(c, false).some(n => snap[n])) continue;            // 이번 충격으로 빠지는 조각 바로 옆만 (먼 옛 구멍 가장자리는 그대로)
            if (tvS.dmg[c] >= TV_DETACH * TV_LOOSE || tvNbrs(c, true).filter(free).length >= 5) add.push(c);
        }
        if (!add.length) break;
        for (const c of add) cand[c] = 1;
    }
    // 이어진 덩어리별로: 너무 작고 기존 구멍에도 안 붙은 건 아직 붙들려 있음
    const seen = new Uint8Array(N2), fresh = [];
    for (let c = 0; c < N2; c++) {
        if (!cand[c] || seen[c]) continue;
        const comp = [c];
        seen[c] = 1;
        let touches = false;
        for (let k = 0; k < comp.length; k++) {
            for (const n of tvNbrs(comp[k], false)) {
                if (tvS.gone[n]) touches = true;
                else if (cand[n] && !seen[n]) { seen[n] = 1; comp.push(n); }
            }
        }
        if (touches || comp.length >= TV_MIN_HOLE) fresh.push(...comp);
    }
    if (!fresh.length) return;
    for (const c of fresh) tvS.gone[c] = 1;

    const L = tvLayers(svg);
    // 새로 빠진 칸 주변 사각형만 다시 그려 덧붙임 (그 밖의 사각형은 예전 구멍 요소가 이미 덮고 있음)
    const holeD = tvMarch(fresh, n => tvS.gone[n] === 1).fill;
    L.holes.appendChild(svgEl('path', { class: 'crack-hole', d: holeD }));      // 새 구멍만 추가 (기존 구멍 요소는 그대로)
    L.clip.appendChild(svgEl('path', { d: holeD }));
    const all = [];
    for (let c = 0; c < N2; c++) if (tvS.gone[c]) all.push(c);
    const rimD = tvMarch(all, n => tvS.gone[n] === 1).rim;                    // 전체 구멍의 깨진 가장자리
    L.edge.setAttribute('d', rimD);
    L.rim.setAttribute('d', rimD);
    tvDropFragments(L, fresh, cx, cy);
}

// 떨어진 영역을 조각으로 나눔: 많이 부서진 곳일수록 잘게 (금 밀도 ∝ 1/조각 크기)
function tvSplit(cells) {
    const left = new Set(cells), out = [];
    const order = cells.slice().sort(() => Math.random() - 0.5);
    for (const s of order) {
        if (!left.has(s)) continue;
        const over = tvS.dmg[s] / TV_DETACH;
        const target = over > 1.6 ? 1 + Math.floor(Math.random() * 2) : 2 + Math.floor(Math.random() * 4);
        const frag = [s];
        left.delete(s);
        for (let k = 0; k < frag.length && frag.length < target; k++) {
            for (const n of tvNbrs(frag[k], false).sort(() => Math.random() - 0.5)) {
                if (frag.length < target && left.has(n)) { left.delete(n); frag.push(n); }
            }
        }
        out.push(frag);
    }
    return out;
}

// 조각 하나의 궤적을 미리 계산해 WAAPI 로 재생 (유한, 끝나면 DOM 삭제)
//  위치: 면내 초기속도 + 중력 포물선, 깊이 z: 충격 방향(안쪽 +, 바깥쪽 −) 등속, 화면엔 원근 투영
//  자세: 면내 회전 ω, 앞뒤로 뒤집히는 텀블링(cos 로 scaleX/scaleY) — 조각이 모서리로 서면 얇은 선이 됨
function tvLaunch(layer, shape, ox, oy, v, spin, inward, yMax = 1000) {
    const frames = [];
    // 앞으로 튀어나오는 조각은 TV 밖 화면을 가로질러 떨어지는 게 보이도록 더 느리게(TV_SLOW_FLY),
    // 보는 사람 쪽 접근도 덜 확대(최대 ×1.5)해서 순식간에 화면 밖으로 사라지지 않게
    const slow = inward ? TV_SLOW : TV_SLOW_FLY;
    const dt = 1 / 40 * slow;                                          // 보여주는 시간 기준 초당 40 프레임
    const tMax = inward ? 0.42 : 0.7;                                  // 실제 시간 상한(초). 앞으로 떨어지는 조각은 화면 아래 끝까지
    const zMin = (inward ? -0.6 : -0.33) * TV_EYE;
    let t = 0;
    for (;;) {
        const x = ox + v[0] * t, y = oy + v[1] * t + 0.5 * TV_GRAV * t * t;
        const z = Math.max(zMin, v[2] * t);
        const s = TV_EYE / (TV_EYE + z);
        const X = TV_VP[0] + (x - TV_VP[0]) * s, Y = TV_VP[1] + (y - TV_VP[1]) * s;
        const keep = c => (Math.abs(c) < 0.06 ? (c < 0 ? -0.06 : 0.06) : c);   // 모서리로 서도 두께만큼은 보임
        const sx = s * keep(Math.cos(spin[1] * t)), sy = s * keep(Math.cos(spin[2] * t));
        frames.push({
            transform: `translate(${tvF(X)}px, ${tvF(Y)}px) rotate(${tvF(spin[0] * t * 57.3)}deg) scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`,
            opacity: inward ? Math.max(0, Math.min(1, (s - 0.45) / 0.45)).toFixed(2) : 1,  // 브라운관 속으로 멀어질수록 어두워짐
        });
        if (t >= tMax || Y > yMax || (inward && s < 0.5)) break;
        t += dt;
    }
    shape.style.transform = frames[0].transform;
    layer.appendChild(shape);
    const anim = shape.animate(frames, { duration: t / slow * 1000, delay: tvRnd(0, 60), easing: 'linear', fill: 'both' });
    anim.onfinish = () => shape.remove();
}

function tvDropFragments(L, cells, cx, cy) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !svgEl('g').animate) return;
    const rnd = tvRnd, sign = () => (Math.random() < 0.5 ? -1 : 1);
    const { fly, yMax } = tvFlyLayer();                                // 앞으로 떨어지는 조각: TV 밖까지 보이는 레이어
    for (const frag of tvSplit(cells)) {
        let ox = 0, oy = 0;
        for (const c of frag) { ox += (c % TV_N + 0.5) * TV_CELL; oy += (((c / TV_N) | 0) + 0.5) * TV_CELL; }
        ox /= frag.length; oy /= frag.length;
        const inFrag = new Set(frag);
        const g = svgEl('g', { class: 'crack-fall' });
        const m = tvMarch(frag, n => inFrag.has(n), ox, oy);
        g.appendChild(svgEl('path', { class: 'fall-face', d: m.fill }));
        g.appendChild(svgEl('path', { class: 'fall-edge', d: m.rim }));
        // 충격량: 충격점에서 멀수록 지수적으로 약해짐. 가까운 조각은 도끼에 밀려 브라운관 안쪽으로,
        // 멀리서 맞물림만 풀린 조각은 거의 제자리에서 앞/뒤로 기울며 중력으로 떨어짐
        const dx = ox - cx, dy = oy - cy, dist = Math.hypot(dx, dy) || 1;
        const f = Math.exp(-dist / 140);
        const inward = Math.random() < 0.15 + 0.45 * f;
        const vr = (80 + 600 * f) * rnd(0.5, 1) * TV_MM;                // 면내 방사 방향 속도 (mm/s → 단위/s)
        const v = [dx / dist * vr, dy / dist * vr - rnd(0, 250) * f * TV_MM,
            (inward ? 1 : -1) * (250 + 1500 * f) * rnd(0.7, 1.2) * TV_MM];
        const spin = [sign() * rnd(2, 4 + 14 * f), sign() * rnd(3, 6 + 22 * f), sign() * rnd(3, 6 + 22 * f)];  // rad/s
        if (inward) tvLaunch(L.back, g, ox, oy, v, spin, true);
        else tvLaunch(fly, g, ox, oy, v, spin, false, yMax);
    }
    // 충격점이 뚫렸으면: 부스러기(작은 파편·반짝임)가 앞으로 튐 (앞면 박리 파편)
    if (tvIsGone(cx, cy)) {
        for (let k = 0; k < 8; k++) {
            const a = rnd(0, Math.PI * 2), sz = rnd(3, 8);
            const tri = svgEl('path', { class: 'crack-chip', d: `M0 ${-sz}L${tvF(sz * rnd(0.5, 1))} ${tvF(sz * 0.6)}L${tvF(-sz * rnd(0.4, 1))} ${tvF(sz * rnd(0.2, 0.7))}Z` });
            const sp = rnd(400, 1400) * TV_MM;
            tvLaunch(fly, tri, cx + rnd(-8, 8), cy + rnd(-8, 8), [Math.cos(a) * sp, Math.sin(a) * sp - 300 * TV_MM, -rnd(800, 2000) * TV_MM],
                [sign() * rnd(10, 30), sign() * rnd(15, 40), sign() * rnd(15, 40)], false, yMax);
        }
    }
}

// TV 밖으로 튀어나오는 조각용 레이어. .tv-container 는 overflow:hidden 이고 유리 svg 는 화면 구멍으로 잘려 있어서,
// body 에 fixed svg 를 하나 두고 매번 유리 위치·크기에 맞춘다 (viewBox 가 같아서 조각 좌표를 그대로 씀).
// yMax: 유리 좌표계로 본 브라우저 창 아래 끝 (+여유) → 조각이 창 밖으로 나가면 끝
function tvFlyLayer() {
    const glass = document.getElementById('tvCracks').getBoundingClientRect();
    let fly = document.getElementById('tvFly');
    if (!fly) {
        fly = svgEl('svg', { id: 'tvFly', class: 'tv-fly', viewBox: '0 0 1000 1000', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
        document.body.appendChild(fly);
    }
    Object.assign(fly.style, { left: `${glass.left}px`, top: `${glass.top}px`, width: `${glass.width}px`, height: `${glass.height}px` });
    const yMax = glass.height ? (window.innerHeight - glass.top) / glass.height * 1000 + 80 : 1000;
    return { fly, yMax };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
}
// 금(맨 아래) → 구멍 → 안쪽으로 떨어지는 조각(구멍 안에서만 보임) → 깨진 가장자리 → 앞으로 떨어지는 조각(맨 위)
function tvLayers(svg) {
    if (!svg._layers) {
        const defs = svgEl('defs'), clip = svgEl('clipPath', { id: 'tvHoleClip', clipPathUnits: 'userSpaceOnUse' });
        defs.appendChild(clip);
        const cracks = svgEl('g'), holes = svgEl('g'), back = svgEl('g', { 'clip-path': 'url(#tvHoleClip)' });
        const edge = svgEl('path', { class: 'crack-edge' }), rim = svgEl('path', { class: 'crack-rim' }), front = svgEl('g');
        svg.append(defs, cracks, holes, back, edge, rim, front);
        svg._layers = { clip, cracks, holes, back, edge, rim, front };
    }
    return svg._layers;
}

async function changeVideo(e) {
    crackTV(e);                                                        // 클릭 좌표를 쓰므로 기다리기 전에 먼저
    const pool = (await loadTvVideos()).filter(name => name !== tvCurrentVideo);
    if (!pool.length) return;
    tvCurrentVideo = pool[Math.floor(Math.random() * pool.length)];
    const v = document.getElementById('tvVideo');
    v.pause();
    v.src = TV_DIR + tvCurrentVideo;
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
// 프로젝트는 index.html 의 .proj-slide 블록만 추가/삭제/이동하면 됨.
// 개수·카운터·진행바·폴라로이드 기울기·링크는 전부 DOM 에서 계산한다.
let projCurrent = 0, projX = 0, projTarget = 0, projRaf = null, projReady = false;
let projTrack, projFillEl, projCounterEl, projSlideEls = [], projNumEls;
let PROJ_N = 0;

// 폴라로이드 기울기 기본값 (인라인 --rot 이 없을 때 순서대로 돌려 씀)
const PROJ_ROTS = [3.5, -2.5, -3, 2.5, 2, -4.5, 1.5, -2];

function initProjSlider() {
    if (projReady) return;
    projReady     = true;
    projTrack     = document.getElementById('projTrack');
    projFillEl    = document.getElementById('projFill');
    projCounterEl = document.getElementById('projCounter');
    projSlideEls  = projTrack ? projTrack.querySelectorAll('.proj-slide') : [];
    projNumEls    = document.querySelectorAll('.proj-num');
    PROJ_N        = projSlideEls.length;
    projSlideEls.forEach((s, i) => {
        s.classList.toggle('active', i === 0);
        const pol = s.querySelector('.proj-polaroid');
        if (!pol) return;
        if (!pol.style.getPropertyValue('--rot')) pol.style.setProperty('--rot', `${PROJ_ROTS[i % PROJ_ROTS.length]}deg`);
        const link = s.querySelector('.proj-link');
        if (link && !pol.getAttribute('href')) {
            pol.href = link.getAttribute('href');
            pol.target = '_blank';
            pol.rel = 'noopener';
        }
        if (!pol.hasAttribute('aria-label')) {
            const title = s.querySelector('.proj-title')?.textContent.trim() ?? '';
            const label = link?.textContent.replace(/->/, '').trim() ?? '';
            pol.setAttribute('aria-label', label ? `${title} — ${label}` : title);
        }
    });
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

// ── 소개 본문의 <br> 분류 ─────────────────────────────────────────
// 데스크톱 폭에 맞춰 문장 중간에 넣은 <br>(soft)과, 소제목 뒤·문단 사이의 <br>(hard)을 구분해
// 좁은 화면에서는 soft 만 숨긴다 (CSS 형제 선택자는 사이의 텍스트를 못 보므로 여기서 판정)
(function classifyAboutBreaks() {
    const isWs = n => n && n.nodeType === 3 && !n.textContent.trim();
    const prevEl = n => { let x = n.previousSibling; while (isWs(x)) x = x.previousSibling; return x; };
    const nextEl = n => { let x = n.nextSibling; while (isWs(x)) x = x.nextSibling; return x; };
    document.querySelectorAll('.realtext br').forEach(br => {
        const p = prevEl(br), q = nextEl(br);
        const hard = (p && p.nodeType === 1 && (p.tagName === 'B' || p.tagName === 'BR')) || (q && q.nodeType === 1 && q.tagName === 'BR');
        if (!hard) br.classList.add('br-soft');
    });
})();

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
    const portraitTablet = !mobile && vw <= 1024 && vh > vw;    // 세로로 든 태블릿: 모바일처럼 위아래로 쌓되 크게
    if (mobile) {
        // 모바일은 차트 영역(.charts-wrap)이 화면 전체를 차지하고 안에서 스크롤되므로 높이에 맞춰 줄이지 않는다
        const radar  = Math.round(Math.min(240, vw * 0.66));
        const langW  = Math.round(Math.min(320, vw - 70));      // 좌측 메뉴 아이콘 열(≈35px)과 겹치지 않게
        return { mobile, tablet, dpr: window.devicePixelRatio || 1, radar, langW, langMaxH: Infinity };
    }
    if (portraitTablet) {
        const radar  = Math.round(Math.min(360, vw * 0.48));
        const langW  = Math.round(Math.min(480, vw * 0.66));
        // 제목 2줄·간격·위아래 여백(≈300px)을 뺀 높이 안에 막대 차트가 들어가게
        return { mobile, tablet, dpr: window.devicePixelRatio || 1, radar, langW, langMaxH: Math.max(300, vh - radar - 300) };
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
    const rowH   = Math.max(15, Math.min(mobile ? 24 : tablet ? 28 : 36, (w * 0.95) / langs.length, rowByH));
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

// ── 블로그 안내 대화상자 ─────────────────────────────────────────
// 처음 온 방문자에겐 블로그 소개를, 이미 봤던 방문자에겐 그 뒤로 새 글이 올라왔을 때만 "새 글" 버전을 띄운다.
// localStorage.blogDialogSeenSlug = 마지막으로 대화상자에서 보여준 글의 slug (닫을 때 저장)
(function () {
    const dialog = document.getElementById('blogDialog');
    if (!dialog) return;
    const seenSlug = localStorage.getItem('blogDialogSeenSlug');
    const legacySeen = localStorage.getItem('blogDialogShown');   // 예전 키(제목만 저장하던 시절) 호환
    let latest = null;

    const close = () => {
        localStorage.setItem('blogDialogSeenSlug', latest?.slug || seenSlug || '');
        localStorage.removeItem('blogDialogShown');
        dialog.classList.remove('is-open');
        setTimeout(() => { dialog.hidden = true; }, 300);
    };
    dialog.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', close));
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !dialog.hidden) close(); });

    const open = (mode) => {
        dialog.classList.toggle('is-new-post', mode === 'new');
        const latestEl = document.getElementById('blogDialogLatest');
        if (latest?.title) {
            latestEl.textContent = mode === 'new' ? '새 글: ' : '최신 글: ';
            const b = document.createElement('b'); b.textContent = latest.title; latestEl.appendChild(b);
            if (latest.slug) dialog.querySelector('.blog-dialog-btn-primary').href = `blog/posts/${encodeURIComponent(latest.slug)}/`;
        }
        // 로딩 타이틀이 어느 정도 걷힌 뒤에 띄운다
        const show = () => setTimeout(() => {
            dialog.hidden = false;
            requestAnimationFrame(() => requestAnimationFrame(() => dialog.classList.add('is-open')));
        }, 4000);
        document.readyState === 'complete' ? show() : window.addEventListener('load', show);
    };

    // 빌드가 만든 blog/latest.json(수백 B)으로 최신 글을 확인한 뒤 어떤 버전을 띄울지 정한다
    fetch('blog/latest.json').then(r => r.json()).then(data => {
        latest = data && data.title ? data : null;
        if (!seenSlug && !legacySeen) open('intro');                                   // 첫 방문
        else if (!seenSlug && legacySeen) {                                              // 예전 키만 있는 방문자: 지금 글을 본 것으로 기록만
            if (latest?.slug) localStorage.setItem('blogDialogSeenSlug', latest.slug);
            localStorage.removeItem('blogDialogShown');
        }
        else if (latest?.slug && latest.slug !== seenSlug) open('new');                  // 마지막으로 본 글과 다르면 새 글
    }).catch(() => { if (!seenSlug && !legacySeen) open('intro'); });
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

    // 작은 화면: 아래로 스크롤(휠·터치 이동)하면 가장자리로 숨고, 위로 스크롤하면 다시 나오며 말풍선·통통 재생
    const small = window.matchMedia('(max-width: 1024px)');
    let tucked = false, lastTouchY = 0, wasActive = false;
    const setTucked = down => {
        if (!small.matches) down = false;
        if (down === tucked) return;
        tucked = down;
        document.body.classList.toggle('clippy-tucked', down);
        if (down) wasActive = link.classList.contains('clippy-active');
        else if (wasActive) {                          // 숨기 전에 말풍선·통통이 있었을 때만 처음부터 재생
            link.classList.remove('clippy-active');
            void link.offsetWidth;
            link.classList.add('clippy-active');
        }
    };
    document.addEventListener('wheel', e => { const d = wheelPx(e); if (Math.abs(d) > 4) setTucked(d > 0); }, { passive: true });
    document.addEventListener('touchstart', e => { lastTouchY = e.touches[0].clientY; }, { passive: true });
    document.addEventListener('touchmove', e => {
        const y = e.touches[0].clientY;
        if (Math.abs(y - lastTouchY) > 8) { setTucked(y < lastTouchY); lastTouchY = y; }
    }, { passive: true });
    // 안쪽 스크롤 영역의 scroll 이벤트는 쓰지 않는다 — 끝에서 튕겨 되돌아올 때(iOS rubber-band) 위로 스크롤한 것처럼
    // 읽혀 섹션 전환 순간 Clippy 가 나왔다 들어감. 터치 이동·휠 방향만으로 판정
    small.addEventListener('change', () => { if (!small.matches) setTucked(false); });
})();

// 저작권 연도 자동 갱신
document.querySelectorAll('.copy-year').forEach(el => { el.textContent = new Date().getFullYear(); });
