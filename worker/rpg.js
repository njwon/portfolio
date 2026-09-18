/**
 * DREAM RPG 백엔드 — 규칙 엔진(결정적) + Workers AI(Gemma 3 12B, 심사·서술만) + D1(한도·캐릭터·전투·대전 방)
 *
 * 설계 원칙 (AI 심판 오류를 없애기 위해):
 *   1. 숫자는 코드가 정한다. 주사위·명중·피해·크리티컬·방어·승패 전부 서버 규칙 엔진. AI 가 낸 숫자는 쓰지 않는다.
 *   2. AI 는 두 가지만: (a) 캐릭터 생성 때 설정을 읽어 '스탯 배분 비율'과 '일관성(coherence)' 을 매김 → 서버가 동일 예산으로
 *      스탯화 (먼치킨 불가), (b) 이미 계산된 턴 결과를 서술 + 행동 문장이 설정에 맞는 정도(fit 0~1) 만 매김 → 피해 ±15% 로만 반영.
 *   3. 서버 권위: 캐릭터·전투 상태는 D1 에 있고 클라이언트는 행동(공격/방어/필살기 + 문장)만 보낸다.
 *   4. AI 가 실패해도 게임은 진행된다 (fit 0.5, 템플릿 서술). 재시도로 한도를 태우지 않는다.
 *
 * 무료 한도 강제 (서버):
 *   Workers AI 무료 = 하루 10,000 뉴런. Gemma 3 12B 입력 31,371 / 출력 50,560 뉴런 per 1M 토큰.
 *   호출 전 '오늘 누적 + 최악 추정치 > 예산' 이면 429, 호출 후 usage 로 실제 누적. IP 별 하루 횟수 제한.
 *
 * 라우트:
 *   GET  /api/rpg/quota                          → 제공자별 남은 횟수 · exhausted (전부 소진 시 클라이언트가 크롬 내장 AI 로 대체)
 *   GET  /api/rpg/leaderboard?charId=            → 승점 상위 20 + 내 순위 (승점 = PvE 승 1 + PvP 승 3)
 *   POST /api/rpg/auth/google                    { credential, charId?, token? } → Google ID 토큰 검증 → { session, user, chars }  (캐릭터를 계정에 연결)
 *   GET  /api/rpg/me?session=                    → { user, chars }   (다른 기기에서 캐릭터 복구)
 *   POST /api/rpg/auth/logout                    { session }
 *   POST /api/rpg/chars/:id/link                 { token, session }  (기존 캐릭터를 로그인 계정에 연결)
 *   POST /api/rpg/chars/:id/delete               { token, session }  (계정 캐릭터 삭제)
 *   GET  /api/rpg/prompts                        → 클라이언트 로컬 AI 가 쓸 시스템 프롬프트 (서버와 동일)
 *   POST /api/rpg/chars                          { name, setting }            → { char, token }
 *   GET  /api/rpg/chars/:id?token=
 *   POST /api/rpg/battles                        { charId, token }            → { battle }   (AI 상대, 호출 없음)
 *   POST /api/rpg/battles/:id/turn               { token, type, text, local? } → { battle }  (규칙 엔진 + 서술 1회; local = 서버 AI 소진 시 클라이언트 심사 결과)
 *   POST /api/rpg/battles/:id/narrate            { token, turn, narration }   (서버 서술이 없던 턴에 클라이언트 로컬 AI 서술을 채움)
 *   GET  /api/rpg/battles/:id?token=             (재접속)
 *   POST /api/rpg/battles/:id/leave              { token }                    (도망: 속도·회피·등급으로 실패 확률 → 실패하면 능력치 손실 + 패배)
 *   POST /api/rpg/battles                        { charId, token, mode: 'auto' } → 자동 생사결에 참가한 다른 플레이어 캐릭터(AI 조종)와 전투
 *   POST /api/rpg/chars/:id/auto                 { token, on }                (자동 생사결 참가 on/off — 꺼져 있는 동안 서버가 매시간 참가자끼리 붙임)
 *   GET  /api/rpg/auto?charId=                   → { on, participants, recent: [...] } 부재 중 자동 생사결 결과
 *   POST /api/rpg/rooms                          { charId, token }            → { code, roomToken, state }
 *   POST /api/rpg/match                          { charId, token }            → 랜덤 대전: 기다리는 공개 방이 있으면 들어가 바로 시작, 없으면 공개 방을 만들고 대기
 *   POST /api/rpg/rooms/:code/join               { charId, token }            (같은 캐릭터가 다시 오면 기존 자리로 재접속)
 *   GET  /api/rpg/rooms/:code?token=
 *   POST /api/rpg/rooms/:code/start              { token }                    (방장, 2명 이상)
 *   POST /api/rpg/rooms/:code/action             { token, type, text, target } | { token, skip: true }   (전원 제출 시 판정, 60초 미제출은 건너뛰기, 3연속이면 기권)
 *   POST /api/rpg/rooms/:code/narrate            { token, round, narration }  (위와 같음, 방 전원에게 공유)
 *   POST /api/rpg/rooms/:code/leave              { token }                    (대기 중: 자리 비움·방장 승계 / 진행 중: 기권 / 마지막 사람이면 방 삭제)
 */

// 모델 후보 (앞에서부터 시도, 계정에서 막힌 모델(5018)이면 다음으로). 뉴런 = 달러 / 0.011 per 1k 뉴런
//   gemma-4-26b-a4b-it  $0.10 / $0.30 per M  → 한국어 품질 좋고 가장 저렴한 편
//   llama-3.1-8b-fp8    $0.152 / $0.287      → 폴백
const MODELS = [
  { name: '@cf/google/gemma-4-26b-a4b-it', nin: 0.10 / 0.011 / 1000, nout: 0.30 / 0.011 / 1000 },
  { name: '@cf/meta/llama-3.1-8b-instruct-fp8', nin: 0.152 / 0.011 / 1000, nout: 0.287 / 0.011 / 1000 },
];
let modelIdx = 0;
const MAX_TOKENS = 380;
// 무료 제공자 체인: 앞에서부터 남은 횟수가 있는 곳을 쓴다. 키는 워커 시크릿(wrangler secret put <key>) — 없으면 건너뜀.
//   2026-09-15 실제 키로 호출해 확인한 값(응답 헤더·오류) 기준. 한도는 모델별로 따로 계산되는 곳이 많아 모델 단위로 항목을 둔다.
//   · Gemini API: 모델별 RPD 독립. 2.5-flash-lite 는 신규 계정 불가 → 3.5/3.1 flash-lite. Gemma 4 는 <thought> 를 끌 수 없어 max_tokens 크게 + 잘라냄(약 12초).
//   · Groq: 모델별 1,000 RPD · 8,000 TPM (헤더 x-ratelimit-limit-requests 확인). llama 계열은 사라짐 → qwen3.8/3.6-27b, gpt-oss-120b/20b.
//   · OpenRouter: 키당 무료 50 RPD (모델 무관). gemma :free 는 상류 429 잦음 → nemotron 우선, models 배열로 자동 폴백.
//   · Cerebras: 결제 탭 활성화 전엔 402 · Mistral: 콘솔에서 무료 Experiment 플랜 켜기 전엔 429(limit 0) → 켜지면 자동 합류.
//   · GitHub Models: 서비스 종료(brownout 410) → 제외.
//   전부 소진되면 클라이언트가 크롬 내장 AI(Gemini Nano)로 이어간다.
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const PROVIDERS = [
  { id: 'cf', name: 'Workers AI', kind: 'cf' },
  { id: 'gemini-lite35', name: 'Gemini 3.5 Flash-Lite', key: 'GEMINI_API_KEY', url: GEMINI_URL, model: 'gemini-3.5-flash-lite', daily: 950 },
  { id: 'gemini-lite31', name: 'Gemini 3.1 Flash-Lite', key: 'GEMINI_API_KEY', url: GEMINI_URL, model: 'gemini-3.1-flash-lite', daily: 950, extra: { reasoning_effort: 'none' } },
  { id: 'groq-qwen38', name: 'Groq Qwen3.8 27B', key: 'GROQ_API_KEY', url: GROQ_URL, model: 'qwen/qwen3.8-27b', daily: 950, extra: { reasoning_effort: 'none' } },
  { id: 'groq-qwen36', name: 'Groq Qwen3.6 27B', key: 'GROQ_API_KEY', url: GROQ_URL, model: 'qwen/qwen3.6-27b', daily: 950, extra: { reasoning_effort: 'none' } },
  { id: 'groq-oss120', name: 'Groq gpt-oss 120B', key: 'GROQ_API_KEY', url: GROQ_URL, model: 'openai/gpt-oss-120b', daily: 950, extra: { reasoning_effort: 'low' } },
  { id: 'groq-oss20', name: 'Groq gpt-oss 20B', key: 'GROQ_API_KEY', url: GROQ_URL, model: 'openai/gpt-oss-20b', daily: 950, extra: { reasoning_effort: 'low' } },
  { id: 'gemini-flash25', name: 'Gemini 2.5 Flash', key: 'GEMINI_API_KEY', url: GEMINI_URL, model: 'gemini-2.5-flash', daily: 230, extra: { extra_body: { google: { thinking_config: { thinking_budget: 0 } } } } },
  // gemini-3.5-flash 는 생각을 끌 수 없어 답이 잘림(230/일뿐이라 제외). Gemma 4 도 생각을 끌 수 없지만 한도가 커서 크게 받고 잘라 씀 (12~25초)
  { id: 'gemma4', name: 'Gemini Gemma 4 26B', key: 'GEMINI_API_KEY', url: GEMINI_URL, model: 'gemma-4-26b-a4b-it', daily: 6000, noSystem: true, maxTokens: 1800, timeout: 45e3 },   // 문서상 14,400 이나 보수적으로
  { id: 'openrouter', name: 'OpenRouter', key: 'OPENROUTER_API_KEY', url: 'https://openrouter.ai/api/v1/chat/completions', model: 'nvidia/nemotron-3-super-120b-a12b:free', daily: 45, extra: { models: ['nvidia/nemotron-3-super-120b-a12b:free', 'nvidia/nemotron-3.5-lightning:free', 'google/gemma-4-26b-a4b-it:free'], reasoning: { enabled: false } } },
  // Cerebras 는 2026-09 현재 무료 티어 없음(PayGo, 잔액 0 이면 402) → 크레딧을 넣을 때만 아래 줄을 살린다
  // { id: 'cerebras', name: 'Cerebras', key: 'CEREBRAS_API_KEY', url: 'https://api.cerebras.ai/v1/chat/completions', model: 'qwen-3.8-27b', daily: 3000, extra: { reasoning_effort: 'none' } },
  // Mistral Free 플랜: 월 $10 포함 API 사용량. mistral-small 은 무료 플랜에서 요청 한도 0(429) → ministral 계열만 열려 있음(14b 30 RPM · 8b 188 RPM, 헤더 확인).
  //   호출당 ≈ $0.0003 → 하루 1,200회면 월 $10 안. 14b(품질) 먼저, 8b 로 이어감
  { id: 'mistral-14b', name: 'Mistral Ministral 14B', key: 'MISTRAL_API_KEY', url: 'https://api.mistral.ai/v1/chat/completions', model: 'ministral-14b-2512', daily: 700 },
  { id: 'mistral-8b', name: 'Mistral Ministral 8B', key: 'MISTRAL_API_KEY', url: 'https://api.mistral.ai/v1/chat/completions', model: 'ministral-8b-2512', daily: 500 },
];
const failedAt = {};   // 제공자별 { at, until } — 실패 뒤 until 까지 건너뜀 (일시 오류 10분, 결제·플랜 미활성(402, 한도 0) 6시간)
const PROVIDER_COOLDOWN = 10 * 60e3, PLAN_COOLDOWN = 6 * 3600e3;
const paused = id => !!failedAt[id] && Date.now() < failedAt[id].until;
const MAX_NEURONS_PER_CALL = Math.ceil(1500 * MODELS[0].nin + MAX_TOKENS * MODELS[0].nout);   // ≈ 24
const DAILY_BUDGET = 9000;
// 사용자(IP)별 몫: 전체 무료 용량을 '최근 24시간 활동 IP 수'(하한 USERS_MIN)로 나눠 배분하고, 제공자별 초기화 시각에 맞춰 충전한다.
//   · Workers AI·OpenRouter: UTC 자정(한국 09:00)에 하루 몫 충전   · Gemini: 태평양 자정(한국 16~17시)에 충전
//   이용자 수는 최근 24시간에 AI 를 호출한 주체(계정·기기·IP) 수(하한 1). 혼자면 상한(IP_CAP_MAX)까지, 늘어나면 자동으로 나뉜다
//   · Groq·Mistral: 토큰 버킷(1 요청/86.4초/모델)이라 시간에 비례해 계속 충전
//   버킷 상한 = 하루 몫(IP_CAP_MIN~IP_CAP_MAX). 새 IP 는 상한만큼 갖고 시작.
const USERS_MIN = 1, IP_CAP_MIN = 20, IP_CAP_MAX = 1200;   // 이용자 수 = 최근 24시간에 실제로 AI 를 호출한 IP 수 (본인 포함)
const ROOM_TTL = 3 * 3600e3, BATTLE_TTL = 6 * 3600e3;
const LEN = { name: 20, setting: 200, text: 120, fiction: 30, ultName: 24, ultEffect: 100 };

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Device, X-Session, X-Token' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });
const today = () => new Date().toISOString().slice(0, 10);
const clip = (s, n) => String(s ?? '').replace(/[<>]/g, '').trim().slice(0, n);
const num = (v, lo, hi, d = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const rnd = () => Math.random();
const uid = () => crypto.randomUUID();

const MAX_BODY = 64 * 1024;
const DEV_PER_IP = 5, DEV_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function identity(env, request, ip, body) {
  const session = request.headers.get('X-Session') || body.session;
  if (session) { const sub = await sessionUser(env, session); if (sub) return 'acct:' + sub; }
  const dev = String(request.headers.get('X-Device') || body.device || '');
  if (DEV_ID_RE.test(dev)) {
    const now = Date.now();
    const known = await env.DB.prepare('SELECT ip FROM rpg_device WHERE device = ?').bind(dev).first();
    if (known) return 'dev:' + dev;
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM rpg_device WHERE ip = ? AND created > ?').bind(ip, now - 86400e3).first();
    if ((n?.n ?? 0) < DEV_PER_IP) { await env.DB.prepare('INSERT OR IGNORE INTO rpg_device (device, ip, created) VALUES (?, ?, ?)').bind(dev, ip, now).run(); return 'dev:' + dev; }
  }
  return 'ip:' + ip;   // 기기 ID 없음(옛 클라이언트·봇) 또는 한 IP 에서 기기 ID 남발 → IP 공용 몫
}
const rl = new Map();   // ip|group → [timestamps]
function rateLimited(ip, group, limit, windowMs = 60e3) {
  const k = ip + '|' + group, now = Date.now(), arr = (rl.get(k) || []).filter(t => now - t < windowMs);
  if (arr.length >= limit) { rl.set(k, arr); return true; }
  arr.push(now); rl.set(k, arr); if (rl.size > 5000) rl.delete(rl.keys().next().value);
  return false;
}
export async function handleRpg(request, env, path) {
  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  const url = new URL(request.url), m = request.method;
  let body = {};
  if (m === 'POST') {
    if (Number(request.headers.get('content-length') || 0) > MAX_BODY) return json({ error: 'too_large' }, 413);
    const raw = await request.text().catch(() => '');
    if (raw.length > MAX_BODY) return json({ error: 'too_large' }, 413);
    try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};   // null·배열 본문으로 TypeError 나지 않게
    // 쓰기 요청 속도 제한 (분당): 생성·방·로그인은 빡빡하게, 턴·행동은 넉넉하게
    const group = /\/chars$/.test(path) ? ['create', 12] : /\/(rooms|match)$/.test(path) ? ['room', 20] : /\/auth\//.test(path) ? ['auth', 10] : ['act', 150];
    if (rateLimited(ip, group[0], group[1])) return json({ error: 'rate', retryAfter: 60 }, 429);
  }
  // 개인 몫의 주인: 로그인했으면 계정(sub) → 아니면 브라우저가 만든 기기 ID → 그것도 없거나 한 IP 에서 기기 ID 를 너무 많이 만들면 IP
  //   (MAC 주소는 브라우저·서버 어디서도 볼 수 없다. 기기 ID 는 저장소를 지우면 새로 생기므로 IP 당 하루 DEV_PER_IP 개까지만 인정)
  const who = await identity(env, request, ip, body);
  let mm;
  if (path === '/api/rpg/quota' && m === 'GET') return json(pubQuota(await quota(env, who)));
  if (path === '/api/rpg/aitest' && m === 'GET') {   // 운영자 점검: 특정 제공자로 서술 1회 (RPG_ADMIN_KEY 시크릿 필요, 한도에 포함)
    if (!env.RPG_ADMIN_KEY || url.searchParams.get('key') !== env.RPG_ADMIN_KEY) return json({ error: 'forbidden' }, 403);
    const pv = PROVIDERS.find(x => x.id === url.searchParams.get('provider'));
    if (!pv) return json({ error: 'no_provider', ids: PROVIDERS.map(x => x.id) }, 404);
    const t0 = Date.now();
    try { const out = await ask(env, pv, SYS_NARRATE, '[p1] 노정원 (평범한 고등학생) — 설정: 유도를 한다\n행동: 공격 → 대상: 검사 / 선언: "업어치기"\n\n[확정된 결과]\n노정원 → 검사: 공격 명중(70%, 난이도 쉬움) → 피해 87\n남은 HP: 노정원 600/600, 검사 433/520', 0.9); return json({ ok: true, provider: pv.id, ms: Date.now() - t0, parsed: out.parsed, raw: out.raw, usage: out.usage }); }
    catch (e) { return json({ ok: false, provider: pv.id, ms: Date.now() - t0, error: e.message }, 502); }
  }
  if (path === '/api/rpg/leaderboard' && m === 'GET') return leaderboard(env, url.searchParams.get('charId'));
  if (path === '/api/rpg/auth/google' && m === 'POST') return authGoogle(body, env);
  if (path === '/api/rpg/auth/logout' && m === 'POST') { await env.DB.prepare('DELETE FROM rpg_sessions WHERE token = ?').bind(String(body.session || '')).run(); return json({ ok: true }); }
  if (path === '/api/rpg/me' && m === 'GET') return me(env, url.searchParams.get('session'));
  if ((mm = path.match(/^\/api\/rpg\/chars\/([\w-]{36})\/link$/)) && m === 'POST') return linkChar(mm[1], body, env);
  if ((mm = path.match(/^\/api\/rpg\/chars\/([\w-]{36})\/delete$/)) && m === 'POST') return deleteChar(mm[1], body, env);
  if ((mm = path.match(/^\/api\/rpg\/chars\/([\w-]{36})\/auto$/)) && m === 'POST') return setAuto(mm[1], body, env);
  if (path === '/api/rpg/auto' && m === 'GET') return autoInfo(env, url.searchParams.get('charId'));
  if (path === '/api/rpg/prompts' && m === 'GET') return json({ judgeChar: SYS_JUDGE, judgeAction: SYS_JUDGE_ACTION, narrate: SYS_NARRATE });
  if (path === '/api/rpg/chars' && m === 'POST') return createChar(body, env, who);
  const qtok = request.headers.get('X-Token') || url.searchParams.get('token');   // 토큰은 헤더로 (쿼리는 로그에 남으므로 호환용)
  if ((mm = path.match(/^\/api\/rpg\/chars\/([\w-]{36})$/)) && m === 'GET') return getChar(mm[1], qtok, env);
  if (path === '/api/rpg/battles' && m === 'POST') return createBattle(body, env);
  if ((mm = path.match(/^\/api\/rpg\/battles\/([\w-]{36})(?:\/(turn|leave|narrate))?$/))) {
    const [, id, sub] = mm;
    if (!sub && m === 'GET') return getBattle(id, qtok, env);
    if (sub === 'turn' && m === 'POST') return battleTurn(id, body, env, who);
    if (sub === 'leave' && m === 'POST') return leaveBattle(id, body, env);
    if (sub === 'narrate' && m === 'POST') return narrateBattle(id, body, env);
  }
  if (path === '/api/rpg/rooms' && m === 'POST') return createRoom(body, env, false, who);
  if (path === '/api/rpg/match' && m === 'POST') return matchRoom(body, env, who);
  if ((mm = path.match(/^\/api\/rpg\/rooms\/([A-Z0-9]{6})(?:\/(join|action|start|leave|narrate))?$/))) {
    const [, code, sub] = mm;
    if (!sub && m === 'GET') return getRoom(code, qtok, env);
    if (sub === 'join' && m === 'POST') return joinRoom(code, body, env, who);
    if (sub === 'start' && m === 'POST') return startRoom(code, body, env);
    if (sub === 'action' && m === 'POST') return roomAction(code, body, env, who);
    if (sub === 'leave' && m === 'POST') return leaveRoom(code, body, env, who);
    if (sub === 'narrate' && m === 'POST') return narrateRoom(code, body, env);
  }
  return json({ error: 'Not Found' }, 404);
}

// ─── 한도 (제공자별 일일 카운터 + IP 카운터) ────────────────────────
async function quota(env, ip) {
  const day = today();
  const g = await env.DB.prepare('SELECT neurons, requests FROM rpg_quota WHERE day = ?').bind(day).first();
  const pr = await env.DB.prepare('SELECT provider, requests FROM rpg_provider WHERE day = ?').bind(day).all();
  const usedBy = {}; for (const r of (pr?.results || [])) usedBy[r.provider] = r.requests;
  const used = g?.neurons ?? 0, remaining = Math.max(0, DAILY_BUDGET - used);
  const perCall = (g?.requests ?? 0) >= 20 && used > 0 ? Math.max(6, used / g.requests) : MAX_NEURONS_PER_CALL;   // 실측 평균 (요청 20건 이상부터)
  const providers = PROVIDERS.map(p => {
    if (p.kind === 'cf') return { id: p.id, name: p.name, configured: !!env.AI, limit: Math.floor(DAILY_BUDGET / perCall), used: g?.requests ?? 0, remaining: remaining < MAX_NEURONS_PER_CALL ? 0 : Math.floor(remaining / perCall) };
    const u = usedBy[p.id] ?? 0;
    // 쿨다운 중(결제 미활성 등)이면 남은 횟수를 0 으로 보여 준다 — 활성화되면 쿨다운이 끝난 뒤 자동 합류
    const probe = p.unverified && u === 0;   // 아직 오늘 성공한 적 없는 미검증 제공자: 용량 0 으로 보이되, 체인 끝에서 한 번은 시도
    return { id: p.id, name: p.name, configured: !!env[p.key], limit: probe ? 0 : p.daily, used: u, remaining: paused(p.id) || probe ? 0 : Math.max(0, p.daily - u), paused: paused(p.id) || undefined, probe: probe && !paused(p.id) || undefined };
  });
  const active = providers.find(p => p.configured && p.remaining > 0);
  const estCalls = providers.reduce((n, p) => n + (p.configured ? p.remaining : 0), 0);
  const capacity = providers.reduce((n, p) => n + (p.configured ? p.limit : 0), 0);
  const b = await ipBucket(env, ip, providers);
  return {
    day, resetsAt: Date.parse(day + 'T00:00:00Z') + 86400e3,
    global: { budget: DAILY_BUDGET, used: Math.round(used), remaining: Math.round(remaining), estCalls, capacity, perCall: Math.round(perCall * 10) / 10, requests: g?.requests ?? 0 },
    ip: { limit: b.cap, used: b.used, remaining: Math.floor(b.tokens), users: b.users, refills: b.refills, scope: ip.startsWith('acct:') ? 'account' : ip.startsWith('dev:') ? 'device' : 'ip' },
    providers, active: active?.id || null, exhausted: estCalls <= 0, _bucket: b,
  };
}
const pubQuota = q => { const { _bucket, ...rest } = q; return rest; };
// 초기화 시각 묶음: 각 제공자 그룹의 하루 용량과 마지막·다음 초기화 시각
const RESET_GROUP = { cf: 'utc', openrouter: 'utc', 'gemini-lite35': 'pt', 'gemini-lite31': 'pt', 'gemini-flash25': 'pt', gemma4: 'pt' };   // 나머지(groq·mistral)는 연속 충전
function lastMidnight(tz, now) {
  // tz 기준 오늘 0시의 UTC 시각 (DST 반영)
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(now)).map(x => [x.type, x.value]));
  const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  const offset = local - now;                       // tz 가 UTC 보다 앞선 양
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day) - offset;
}
function resetGroups(providers, now) {
  const cap = g => providers.filter(p => p.configured && !p.paused && RESET_GROUP[p.id] === g).reduce((n, p) => n + p.limit, 0);
  const cont = providers.filter(p => p.configured && !p.paused && !RESET_GROUP[p.id]).reduce((n, p) => n + p.limit, 0);
  const utc = lastMidnight('UTC', now), pt = lastMidnight('America/Los_Angeles', now);
  return {
    utc: { name: 'Workers AI·OpenRouter', cap: cap('utc'), last: utc, next: utc + 86400e3 },
    pt: { name: 'Gemini', cap: cap('pt'), last: pt, next: pt + 86400e3 },
    cont: { name: 'Groq·Mistral', perDay: cont },
  };
}
async function ipBucket(env, ip, providers) {
  const now = Date.now();
  const row = await env.DB.prepare('SELECT tokens, updated, used FROM rpg_ip_bucket WHERE ip = ?').bind(ip).first();
  const act = await env.DB.prepare('SELECT COUNT(*) AS n FROM rpg_ip_bucket WHERE updated > ?').bind(now - 86400e3).first();
  const users = Math.max(USERS_MIN, (act?.n ?? 0) + (row && row.updated > now - 86400e3 ? 0 : 1));   // 본인이 아직 집계에 없으면 +1
  const g = resetGroups(providers, now);
  const cap = Math.max(IP_CAP_MIN, Math.min(IP_CAP_MAX, Math.floor((g.utc.cap + g.pt.cap + g.cont.perDay) / users)));
  let tokens = cap;
  if (row) {
    tokens = row.tokens;
    for (const k of ['utc', 'pt']) if (row.updated < g[k].last && g[k].last <= now) tokens += g[k].cap / users;   // 초기화 시각을 지났으면 그 그룹의 하루 몫 충전
    tokens += g.cont.perDay / users * (now - row.updated) / 86400e3;                                                 // 연속 충전분
    tokens = Math.min(cap, tokens);
  }
  const share = k => Math.min(cap, Math.round(g[k].cap / users));
  return { tokens, cap, users, used: row?.used ?? 0, exists: !!row, now,
    refills: [{ name: g.utc.name, at: g.utc.next, add: share('utc') }, { name: g.pt.name, at: g.pt.next, add: share('pt') }, { name: g.cont.name, perHour: Math.round(g.cont.perDay / users / 24 * 10) / 10 }] };
}
// 카운터 증감 (delta = +1 예약 / -1 환불). Workers AI 는 rpg_quota, 나머지는 rpg_provider. IP 는 공통
async function bumpProvider(env, day, providerId, delta) { const stmts = []; pushProviderStmt(stmts, env, day, providerId, delta); await env.DB.batch(stmts); }
function pushProviderStmt(stmts, env, day, providerId, delta) {
  if (providerId === 'cf') stmts.push(delta > 0
    ? env.DB.prepare('INSERT INTO rpg_quota (day, neurons, requests) VALUES (?, 0, 1) ON CONFLICT(day) DO UPDATE SET requests = requests + 1').bind(day)
    : env.DB.prepare('UPDATE rpg_quota SET requests = MAX(0, requests - 1) WHERE day = ?').bind(day));
  else stmts.push(delta > 0
    ? env.DB.prepare('INSERT INTO rpg_provider (day, provider, requests) VALUES (?, ?, 1) ON CONFLICT(day, provider) DO UPDATE SET requests = requests + 1').bind(day, providerId)
    : env.DB.prepare('UPDATE rpg_provider SET requests = MAX(0, requests - 1) WHERE day = ? AND provider = ?').bind(day, providerId));
}
// 분담 결제: 충전 반영한 현재 값에서 share 만큼 빼서 저장 (환불이면 더함)
async function chargeShare(env, who, b, amount) {
  await env.DB.prepare('INSERT INTO rpg_ip_bucket (ip, tokens, updated, used) VALUES (?, ?, ?, 1) ON CONFLICT(ip) DO UPDATE SET tokens = ?, updated = ?, used = used + ?')
    .bind(who, b.tokens - amount, b.now, b.tokens - amount, b.now, amount > 0 ? 1 : 0).run();
  b.tokens -= amount;
}
async function bump(env, day, ip, providerId, delta, b) {
  const stmts = [];
  pushProviderStmt(stmts, env, day, providerId, delta);
  // 사용자 버킷: 예약이면 (충전 반영한 값 - 1) 로 저장, 환불이면 +1
  stmts.push(delta > 0
    ? env.DB.prepare('INSERT INTO rpg_ip_bucket (ip, tokens, updated, used) VALUES (?, ?, ?, 1) ON CONFLICT(ip) DO UPDATE SET tokens = ?, updated = ?, used = used + 1').bind(ip, b.tokens - 1, b.now, b.tokens - 1, b.now)
    : env.DB.prepare('UPDATE rpg_ip_bucket SET tokens = tokens + 1, used = MAX(0, used - 1) WHERE ip = ?').bind(ip));
  await env.DB.batch(stmts);
}
async function record(env, usage, model) {
  const inTok = usage?.prompt_tokens ?? 1200, outTok = usage?.completion_tokens ?? MAX_TOKENS;
  const neurons = Number.isFinite(usage?.neurons) ? usage.neurons : inTok * model.nin + outTok * model.nout;   // Workers AI 가 뉴런을 직접 주면 그 값
  await env.DB.prepare('UPDATE rpg_quota SET neurons = neurons + ? WHERE day = ?').bind(neurons, today()).run();
}
// AI 호출 한 번: IP 한도 확인 → 남은 제공자 순서대로 예약·호출, 실패하면 환불하고 다음 제공자 (최대 3곳)
//   → { ok, parsed, raw, provider } | { ok: false, reason: 'ip' | 'exhausted' | 'failed' }
// ip 가 배열이면(방 판정) 참가자 전원이 1/N 씩 낸다 — 몫이 남은 사람들끼리 나누고, 아무도 없으면 'ip' 사유로 막힘
async function aiCall(env, ip, system, user, temperature) {
  const payers = Array.isArray(ip) ? [...new Set(ip.filter(Boolean))] : null;
  const q = await quota(env, payers ? payers[0] : ip);
  let split = null;
  if (payers) {
    const buckets = await Promise.all(payers.map(async w => [w, await ipBucket(env, w, q.providers)]));
    const able = buckets.filter(([, b]) => b.tokens > 0);
    if (!able.length) return { ok: false, reason: 'ip' };
    split = able.map(([w, b]) => [w, b, 1 / able.length]);
  } else if (q.ip.remaining <= 0) return { ok: false, reason: 'ip' };
  const charge = async delta => { for (const [w, b, share] of split) await chargeShare(env, w, b, delta * share); };
  let tried = 0;
  for (const p of q.providers) {
    if (!p.configured || (p.remaining <= 0 && !p.probe) || paused(p.id)) continue;
    if (split) { await bumpProvider(env, q.day, p.id, +1); await charge(+1); }
    else { await bump(env, q.day, ip, p.id, +1, q._bucket); q._bucket = { ...q._bucket, tokens: q._bucket.tokens - 1 }; }
    try {
      const out = await ask(env, PROVIDERS.find(x => x.id === p.id), system, user, temperature);
      if (p.id === 'cf') await record(env, out.usage, out.model);
      return { ok: true, parsed: out.parsed, raw: out.raw, provider: p.id };
    } catch (e) {
      if (split) { await bumpProvider(env, q.day, p.id, -1); await charge(-1); } else await bump(env, q.day, ip, p.id, -1, q._bucket);
      // 지역 불가(Gemini, 송신 지점에 따라 간헐적)는 쿨다운 없이 다음 제공자로 — 다음 호출은 다른 지점에서 나가 성공할 수 있다
      if (!/User location/i.test(e.message) && (p.id !== 'cf' || !/quota|limit|429/i.test(e.message))) {
        const plan = / 402 |payment_required|limit-req-minute: 0|"code":"1300"/i.test(e.message);   // 결제·플랜 문제 → 길게 쉼
        failedAt[p.id] = { at: Date.now(), until: Date.now() + (plan ? PLAN_COOLDOWN : PROVIDER_COOLDOWN), why: e.message.slice(0, 120) };
      }
      if (++tried >= 3) break;
    }
  }
  return { ok: false, reason: tried ? 'failed' : 'exhausted' };
}

// ─── 자동 생사결 ─────────────────────────────────────────────────
// 캐릭터에 auto 를 켜 두면: ① 매시간(cron) 서버가 참가자끼리 무작위로 짝지어 규칙 엔진만으로(AI 없음) 싸우게 하고 결과를 남긴다
//   ② 온라인인 사람은 '자동 생사결 상대' 메뉴로 참가자 중 한 명(AI 조종)과 실시간 전투를 한다. 승리는 순위 승점에 PvE 와 PvP 사이(2점)로 반영
async function setAuto(id, body, env) {
  const c = await loadChar(env, id, body.token);
  if (!c) return json({ error: 'forbidden' }, 403);
  c.auto = !!body.on;
  await env.DB.prepare('UPDATE rpg_chars SET json = ?, auto = ? WHERE id = ?').bind(JSON.stringify(c), c.auto ? 1 : 0, id).run();
  return json({ ok: true, auto: c.auto });
}
async function autoInfo(env, charId) {
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM rpg_chars WHERE auto = 1').first();
  let recent = [], on = false;
  if (charId) {
    const r = await env.DB.prepare('SELECT a_id, a_name, b_id, b_name, winner, rounds, mode, created FROM rpg_auto_log WHERE a_id = ? OR b_id = ? ORDER BY created DESC LIMIT 8').bind(charId, charId).all();
    recent = (r?.results || []).map(x => ({ me: x.a_id === charId ? x.a_name : x.b_name, foe: x.a_id === charId ? x.b_name : x.a_name, won: x.winner === charId, draw: !x.winner, rounds: x.rounds, mode: x.mode, at: x.created }));
    const row = await env.DB.prepare('SELECT auto FROM rpg_chars WHERE id = ?').bind(charId).first(); on = !!row?.auto;
  }
  return json({ on, participants: n?.n ?? 0, recent });
}
async function recordAutoResult(env, st, c) {
  await env.DB.prepare('INSERT INTO rpg_auto_log (id, a_id, a_name, b_id, b_name, winner, rounds, mode, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(uid(), c.id, c.name, st.foeId, st.foe.char.name, st.winner === 1 ? c.id : st.foeId, st.turn, 'online', Date.now()).run();
  // 상대(AI 조종)도 전적에 반영
  const row = await env.DB.prepare('SELECT json FROM rpg_chars WHERE id = ?').bind(st.foeId).first();
  if (row) { const f = JSON.parse(row.json); if (st.winner === 1) { f.losses++; f.autoLosses = (f.autoLosses || 0) + 1; } else { f.wins++; f.autoWins = (f.autoWins || 0) + 1; f.pvpWins = (f.pvpWins || 0) + 0.5; } await saveChar(env, f); }
}
// cron: 참가자 최대 30명을 섞어 짝지어 최대 40라운드 자동 전투 (템플릿 서술만, AI 호출 없음)
export async function runAutoBattles(env) {
  const r = await env.DB.prepare('SELECT id, json FROM rpg_chars WHERE auto = 1 ORDER BY RANDOM() LIMIT 30').all();
  const list = (r?.results || []).map(x => ({ id: x.id, c: JSON.parse(x.json) }));
  let played = 0;
  for (let i = 0; i + 1 < list.length; i += 2) {
    const A = list[i], B = list[i + 1];
    const players = { 1: { char: A.c, hp: A.c.stats.hp, gauge: 0, guard: false }, 2: { char: B.c, hp: B.c.stats.hp, gauge: 0, guard: false } };
    let round = 0;
    while (round < 40 && players[1].hp > 0 && players[2].hp > 0) { round++; resolveRound(players, { 1: { ...enemyDecide(players[1], players[2]), target: 2 }, 2: { ...enemyDecide(players[2], players[1]), target: 1 } }, {}); }
    const winner = players[1].hp > 0 && players[2].hp <= 0 ? A : players[2].hp > 0 && players[1].hp <= 0 ? B : null;
    for (const X of [A, B]) {
      if (!winner) continue;
      if (X === winner) { X.c.wins++; X.c.autoWins = (X.c.autoWins || 0) + 1; X.c.pvpWins = (X.c.pvpWins || 0) + 0.5; const rw = rollReward(X.c, (X === A ? B : A).c, 'auto'); X.c.stats.hp = Math.min(6000, X.c.stats.hp + rw.hp); X.c.stats.atk = Math.min(800, X.c.stats.atk + rw.atk); }
      else { X.c.losses++; X.c.autoLosses = (X.c.autoLosses || 0) + 1; }
      await saveChar(env, X.c);
    }
    await env.DB.prepare('INSERT INTO rpg_auto_log (id, a_id, a_name, b_id, b_name, winner, rounds, mode, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(uid(), A.id, A.c.name, B.id, B.c.name, winner ? winner.id : null, round, 'offline', Date.now()).run();
    played++;
  }
  await env.DB.prepare('DELETE FROM rpg_auto_log WHERE created < ?').bind(Date.now() - 30 * 86400e3).run();
  return played;
}

// ─── 순위표 · Google 로그인 ────────────────────────────────────────
let lbCache = { at: 0, rows: [] };
async function leaderboard(env, charId) {
  if (Date.now() - lbCache.at > 20e3) {
    const r = await env.DB.prepare('SELECT c.id, c.name, c.score, c.json, u.name AS owner, u.picture FROM rpg_chars c LEFT JOIN rpg_users u ON u.sub = c.user_sub WHERE c.score > 0 ORDER BY c.score DESC, c.created ASC LIMIT 20').all();
    lbCache = { at: Date.now(), rows: (r?.results || []).map((row, i) => { const c = JSON.parse(row.json); return { rank: i + 1, id: row.id, name: c.name, owner: row.owner || null, picture: row.picture || null, score: row.score, tier: c.stats?.tier || null, fiction: c.fiction, wins: c.wins || 0, losses: c.losses || 0, pvpWins: c.pvpWins || 0 }; }) };
  }
  let mine = null;
  if (charId) {
    const row = await env.DB.prepare('SELECT score FROM rpg_chars WHERE id = ?').bind(charId).first();
    if (row) { const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM rpg_chars WHERE score > ?').bind(row.score).first(); mine = { rank: (n?.n ?? 0) + 1, score: row.score }; }
  }
  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM rpg_chars WHERE score > 0').first();
  return json({ rows: lbCache.rows, mine, total: total?.n ?? 0 });
}
async function sessionUser(env, session) {
  if (!session) return null;
  const row = await env.DB.prepare('SELECT sub FROM rpg_sessions WHERE token = ? AND created > ?').bind(String(session), Date.now() - 90 * 86400e3).first();
  return row?.sub || null;
}
async function userChars(env, sub) {
  const r = await env.DB.prepare('SELECT id, token, json FROM rpg_chars WHERE user_sub = ? ORDER BY created DESC LIMIT 10').bind(sub).all();
  return (r?.results || []).map(row => { const c = JSON.parse(row.json); return { id: row.id, token: row.token, name: c.name, fiction: c.fiction, tier: c.stats?.tier, wins: c.wins, losses: c.losses, created: c.created }; });
}
async function userInfo(env, sub) {
  const u = await env.DB.prepare('SELECT sub, email, name, picture FROM rpg_users WHERE sub = ?').bind(sub).first();
  return u ? { name: u.name, picture: u.picture, email: u.email } : null;
}
// Google Identity Services 가 준 ID 토큰을 구글 tokeninfo 로 검증 (서명·만료 확인은 구글이 함) → aud 가 우리 클라이언트 ID 인지 확인
async function authGoogle(body, env) {
  if (!env.GOOGLE_CLIENT_ID) return json({ error: 'auth_disabled' }, 503);   // 클라이언트 ID 없이는 aud 를 검증할 수 없으므로 로그인 자체를 막는다
  const cred = String(body.credential || ''), at = String(body.access_token || '');
  if (!cred && !at) return json({ error: 'bad_request' }, 400);
  let info;
  try {
    if (cred) { const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(cred)); if (!r.ok) return json({ error: 'bad_token' }, 401); info = await r.json(); }
    else {   // 맞춤 버튼(OAuth2 token client)이 준 접근 토큰: tokeninfo 로 aud·sub 확인 → userinfo 로 이름·사진
      const r = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(at)); if (!r.ok) return json({ error: 'bad_token' }, 401); info = await r.json();
      const u = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + at } }); if (u.ok) { const ui = await u.json(); info = { ...info, sub: ui.sub || info.sub, email: ui.email || info.email, name: ui.name, picture: ui.picture, email_verified: String(ui.email_verified ?? info.email_verified ?? 'true') }; }
      if (info.expires_in !== undefined && Number(info.expires_in) <= 0) return json({ error: 'bad_token' }, 401);
    }
  } catch { return json({ error: 'ai_failed' }, 502); }
  if (info.aud !== env.GOOGLE_CLIENT_ID) return json({ error: 'bad_aud' }, 401);
  if (!info.sub || (info.exp && Number(info.exp) * 1000 < Date.now())) return json({ error: 'bad_token' }, 401);
  const now = Date.now();
  await env.DB.prepare('INSERT INTO rpg_users (sub, email, name, picture, created, last) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(sub) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture, last = excluded.last')
    .bind(info.sub, info.email || null, clip(info.name || info.email || '플레이어', 40), info.picture || null, now, now).run();
  if (info.email_verified === 'false') return json({ error: 'bad_token' }, 401);
  const session = uid();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM rpg_sessions WHERE created < ?').bind(now - 90 * 86400e3),   // 만료 세션 정리
    env.DB.prepare('INSERT INTO rpg_sessions (token, sub, created) VALUES (?, ?, ?)').bind(session, info.sub, now),
  ]);
  // 최초 로그인(계정에 캐릭터가 없음)이면 지금 쓰던 손님 캐릭터가 계정 캐릭터가 된다. 이미 캐릭터가 있으면 손님 캐릭터는 그대로 두고(로그아웃하면 다시 씀) 계정 캐릭터로 전환
  const existing = await userChars(env, info.sub);
  if (!existing.length && body.charId && body.token) { const c = await loadChar(env, body.charId, body.token); if (c) await env.DB.prepare('UPDATE rpg_chars SET user_sub = ? WHERE id = ? AND user_sub IS NULL').bind(info.sub, c.id).run(); }   // 이미 다른 계정 것이면 안 가져감
  lbCache.at = 0;   // 순위표 소유자 이름 갱신
  return json({ session, user: await userInfo(env, info.sub), chars: await userChars(env, info.sub), firstLogin: !existing.length });
}
// 계정 캐릭터 삭제 (본인 세션 + 캐릭터 토큰 둘 다 맞아야)
async function deleteChar(id, body, env) {
  const sub = await sessionUser(env, body.session);
  const c = await loadChar(env, id, body.token);
  if (!sub || !c) return json({ error: 'forbidden' }, 403);
  const row = await env.DB.prepare('SELECT user_sub FROM rpg_chars WHERE id = ?').bind(id).first();
  if (row?.user_sub !== sub) return json({ error: 'forbidden' }, 403);
  await env.DB.prepare('DELETE FROM rpg_chars WHERE id = ?').bind(id).run(); lbCache.at = 0;
  return json({ ok: true });
}
async function me(env, session) {
  const sub = await sessionUser(env, session);
  if (!sub) return json({ error: 'forbidden' }, 403);
  return json({ user: await userInfo(env, sub), chars: await userChars(env, sub) });
}
async function linkChar(id, body, env) {
  const sub = await sessionUser(env, body.session);
  const c = await loadChar(env, id, body.token);
  if (!sub || !c) return json({ error: 'forbidden' }, 403);
  const row = await env.DB.prepare('SELECT user_sub FROM rpg_chars WHERE id = ?').bind(id).first();
  if (row?.user_sub && row.user_sub !== sub) return json({ error: 'owned' }, 409);   // 다른 계정의 캐릭터는 못 가져감
  await env.DB.prepare('UPDATE rpg_chars SET user_sub = ? WHERE id = ?').bind(sub, id).run(); lbCache.at = 0;
  return json({ ok: true });
}

// ─── 검열 (이용 정책) ─────────────────────────────────────────────
// 플레이어가 쓴 글(캐릭터 이름·설정, 행동 선언, 로컬 AI 서술)을 AI 제공자에게 보내기 전에 거른다.
//   1) 규칙: 미성년 성적 묘사·노골적 성행위·욕설/혐오처럼 문맥이 필요 없는 것만 즉시 차단 (API 호출 없음). 오탐 소지 있는 단어는 넣지 않는다
//   2) Mistral Moderation API(mistral-moderation-latest, 무료 플랜 100 RPM): 성적·혐오·자해·위험/범죄 정보·개인정보 점수로 판정
//   전투 게임이므로 '폭력'(violence_and_threats)은 차단 사유가 아니다. Mistral 을 못 쓰면 규칙만으로 진행
const POLICY_RULES = [
  [/(초등|중학|고등|미성년|어린|아동|소녀|소년|학생|로리|쇼타)[^\n]{0,24}(성관계|성행위|섹스|강간|벗기|나체|알몸|자위|음란|성기|보지|자지)/, 'minor_sexual'],
  [/(성관계|성행위|섹스|강간|윤간|자위|음란물|포르노|성기|정액|보지|자지|딸딸이|ㅅㅅ|야동)/, 'sexual'],
  [/(씨발|시발|병신|좆|니미|느금|개새끼|창녀|장애인새끼|흑형|짱깨|쪽바리|틀딱|한남|김치녀)/, 'hate'],
  // 자해·자살은 "자해 공격을 해라" 같은 게임 표현과 겹쳐 규칙으로 안 잡고 Mistral selfharm 점수(문맥 판단)에만 맡긴다
  [/\b(rape|porn|creampie|hentai|loli|shota|nigg\w*|faggot|kike|chink)\b/i, 'sexual_or_hate'],
];
const POLICY_LIMIT = { sexual: 0.5, hate_and_discrimination: 0.5, selfharm: 0.5, dangerous_and_criminal_content: 0.85, pii: 0.8 };
const POLICY_KO = { minor_sexual: '미성년자 성적 묘사', sexual: '노골적 성적 내용', hate: '욕설·혐오 표현', selfharm: '자해·자살 조장', sexual_or_hate: '성적·혐오 표현', hate_and_discrimination: '혐오·차별 표현', dangerous_and_criminal_content: '위험·범죄 정보', pii: '개인정보' };
const modCache = new Map();
async function moderate(env, text) {
  const t = String(text || '').trim();
  if (!t) return { ok: true };
  if (modCache.has(t)) return modCache.get(t);
  let res = { ok: true };
  for (const [re, why] of POLICY_RULES) if (re.test(t)) { res = { ok: false, reason: why, label: POLICY_KO[why], src: 'rule' }; break; }
  if (res.ok && env.MISTRAL_API_KEY && !paused('mistral-mod')) {
    try {
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 8e3);
      const r = await fetch('https://api.mistral.ai/v1/moderations', { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.MISTRAL_API_KEY, 'User-Agent': 'dream-rpg/1.0' }, body: JSON.stringify({ model: 'mistral-moderation-latest', input: [t] }) });
      clearTimeout(timer);
      if (r.ok) {
        const sc = (await r.json()).results?.[0]?.category_scores || {};
        for (const [cat, lim] of Object.entries(POLICY_LIMIT)) if ((sc[cat] ?? 0) >= lim) { res = { ok: false, reason: cat, label: POLICY_KO[cat], src: 'mistral', score: Math.round(sc[cat] * 100) / 100 }; break; }
      } else if (r.status === 429 || r.status === 402) failedAt['mistral-mod'] = { at: Date.now(), until: Date.now() + PROVIDER_COOLDOWN, why: 'moderation ' + r.status };
    } catch { /* 검열 API 실패 → 규칙 결과로 진행 */ }
  }
  if (modCache.size > 500) modCache.delete(modCache.keys().next().value);
  modCache.set(t, res);
  return res;
}

// ─── AI (심사·서술 전용) ─────────────────────────────────────────────
// 모델이 낸 JSON 이 문자열 안의 따옴표·줄바꿈 때문에 깨지는 일이 잦다 → 관대하게 복구
function lenientJson(text) {
  let mt = text.match(/\{[\s\S]*\}/);
  if (!mt) {
    // 닫는 괄호가 없음 = max_tokens 에 잘린 출력. 서술이면 잘린 채로라도 살린다
    const i = text.indexOf('{'); if (i < 0) return null;
    mt = [text.slice(i).replace(/[\s"]*$/, '') + '…"}'];
  }
  let t = mt[0];
  try { return JSON.parse(t); } catch {}
  t = t.replace(/([:{,\[])\s*\r?\n\s*/g, '$1').replace(/\s*\r?\n\s*([}\]])/g, '$1')   // 구조상의 줄바꿈(키 뒤·괄호 앞)은 지우고
    .replace(/\r?\n/g, '<br>').replace(new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + ']', 'g'), ' ');          // 1) 문자열 안 줄바꿈 → <br>
  try { return JSON.parse(t); } catch {}
  const nm = t.match(/"narration"\s*:\s*"([\s\S]*?)"\s*\}?\s*$/);           // 2) 서술: 값을 통째로 회수
  if (nm) return { narration: nm[1].replace(/\\"/g, '"') };
  const out = {}; let any = false;                                          // 3) 심사: 필드별 회수
  for (let i = 1; i <= 6; i++) {
    const k = 'p' + i;
    const seg = t.match(new RegExp('"' + k + '"\\s*:\\s*\\{([\\s\\S]*?)\\}\\s*(?:,\\s*"p' + (i + 1) + '"|\\}\\s*$)'));
    if (!seg) continue;
    const g = seg[1], f = re => (g.match(re) || [])[1];
    out[k] = { allowed: f(/"allowed"\s*:\s*(true|false)/) !== 'false', difficulty: f(/"difficulty"\s*:\s*"(\w+)"/), fit: Number(f(/"fit"\s*:\s*([\d.]+)/)), verdict: cleanVerdict(f(/"verdict"\s*:\s*"([\s\S]*?)"\s*(?:,\s*"(?:allowed|difficulty|fit)"\s*:|$)/)) };
    any = true;
  }
  return any ? out : null;
}
// 서술은 innerHTML 로 그려지므로 태그를 막고 <br> 만 허용 (모델 출력이든 클라이언트 로컬 AI 출력이든)
const safeHtml = v => String(v || '').trim().replace(/<\/?p>|<\/?div>|\n/g, '<br>').replace(/(<br>\s*){2,}/g, '<br>').replace(/^(<br>)+|(<br>)+$/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&lt;br\s*\/?&gt;/gi, '<br>').slice(0, 1500);
// 판정문에 JSON 조각("fit":0.9 …)이나 중괄호가 섞여 나오면 그 앞까지만 남긴다
function cleanVerdict(v) {
  return String(v || '').replace(/\\"/g, '"').replace(/\s*[,{}]?\s*"?(allowed|difficulty|fit|verdict|p\d)"?\s*:[\s\S]*$/, '').replace(/[{}]/g, '').replace(/[\s,]+$/, '').replace(/"$/, m => (v.match(/"/g) || []).length % 2 ? '' : m).trim().slice(0, 300);
}
async function ask(env, provider, system, user, temperature) {
  let maxTokens = system === SYS_JUDGE_ACTION ? 260 : MAX_TOKENS;
  if (provider.kind !== 'cf') {
    if (provider.maxTokens) maxTokens = provider.maxTokens;   // 생각을 끌 수 없는 모델은 생각 + 답이 다 들어갈 만큼
    // OpenAI 호환 채팅 엔드포인트 (Groq · Gemini · Cerebras · Mistral · GitHub Models · OpenRouter 모두 같은 형식)
    for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), provider.timeout || 25e3);
    try {
      const res = await fetch(provider.url, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env[provider.key], 'User-Agent': 'dream-rpg/1.0 (+https://njw.kro.kr)', 'HTTP-Referer': 'https://njw.kro.kr', 'X-Title': 'DREAM RPG' },
        body: JSON.stringify({ model: provider.model, messages: provider.noSystem ? [{ role: 'user', content: system + '\n\n---\n\n' + user }] : [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens, temperature, ...(provider.extra || {}) }) });
      if (!res.ok) {
        const msg = (await res.text()).slice(0, 200);
        // Gemini 는 워커 요청의 송신 지역에 따라 간헐적으로 "User location is not supported" → 같은 요청을 바로 다시 (다른 경로로 나감)
        if (res.status === 400 && /User location/i.test(msg) && attempt < 2) { clearTimeout(timer); continue; }
        throw new Error(provider.id + ' ' + res.status + ' ' + msg);
      }
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content ?? '';
      if (!text) throw new Error(provider.id + ' empty');
      const clean = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<thought>[\s\S]*?<\/thought>/g, '').replace(/^[\s\S]*<\/thought>/, '');   // Gemma 4 · qwen 생각 블록 제거
      return { parsed: lenientJson(clean), usage: data.usage, model: provider, raw: clean.slice(0, 400) };
    } finally { clearTimeout(timer); }
    }
  }
  for (let i = modelIdx; i < MODELS.length; i++) {
    const model = MODELS[i];
    try {
      // gemma-4 는 기본이 '생각(reasoning_content)' 모드라 max_tokens 를 생각에 다 쓰고 답이 비어 나온다 → 생각 끄기 요청
      const res = await env.AI.run(model.name, { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens, temperature, enable_thinking: false, reasoning: { effort: 'none' }, chat_template_kwargs: { enable_thinking: false } });
      modelIdx = i;
      // 모델마다 응답 형태가 다르다: { response } | OpenAI 호환 { choices:[{message:{content}}] } | { output_text }
      const text = typeof res === 'string' ? res
        : (res.response ?? res.choices?.[0]?.message?.content ?? res.output_text ?? res.result?.response ?? '');
      const parsed = lenientJson(text.replace(/<think>[\s\S]*?<\/think>/g, ''));
      return { parsed, usage: res?.usage, model, raw: text.slice(0, 400) };
    } catch (e) {
      if (/5018|not allowed|No such model|not found/i.test(e.message) && i + 1 < MODELS.length) continue;   // 이 계정에서 막힌 모델 → 다음 후보
      throw e;
    }
  }
  throw new Error('no model available');
}

const SYS_JUDGE = `당신은 텍스트 RPG 캐릭터 심사관입니다. 사용자가 쓴 캐릭터 설정을 읽고 아래만 정합니다. 숫자 능력치는 정하지 않습니다(서버가 정함).
1) concept: 설정을 요약한 수식어 (예: 평범한 고등학생, 바다의 신, 은퇴한 검사)
2) alloc: 이 캐릭터의 성향을 6개 항목에 합계 100으로 배분. atk(공격) hp(체력) def(방어) spd(속도) acc(명중) eva(회피). 설정에 근거해서만.
3) coherence 0~100: 설정의 내적 일관성. 앞뒤가 맞고 한계·약점이 분명하면 높음(80~100). 짧거나 막연하면 중간(40~60). "무엇이든 다 한다", 모순, 근거 없는 전능은 낮음(5~25). 현실적/비현실적 여부와 무관. 낮은 점수는 거절 사유가 아니라 그냥 점수입니다.
4) ult: 필살기 하나. name(짧게), effect(한 문장), style 은 burst(한 방)·precise(명중 위주)·drain(피해+회복)·shield(피해+다음 턴 방어) 중 하나. 설정이 짧으면 설정에서 자연스럽게 유추해 만드세요(고양이 → 할퀴기).
5) power 0~100: 설정이 근거하는 위력 등급. 엄격하게: 낮게 주기는 쉽고 높게 주기는 어렵습니다.
   0~30 평범한 존재(학생·직장인·동물·일반인, 기본값 20) / 31~50 훈련된 전문가·격투가·무기 숙련자·평범한 마법 견습 / 51~70 초인(명확한 초능력·마법·만화 주인공급, 능력이 구체적이고 한계가 적혀 있을 때만)
   71~85 전설(도시 하나를 뒤흔들 급, 신화의 영웅. 능력·대가·약점이 모두 구체적일 때만) / 86~100 신급·개념적 존재(설정이 길고 구체적이며 명확한 제약·대가가 있을 때만. 극히 드묾)
   "최강" "무적" "뭐든 다 한다" "우주를 파괴" 같은 주장만으로는 절대 올리지 마세요 — 근거 없는 과장은 30 이하 + coherence 낮게. 화려한 수식어보다 구체성·한계·대가가 근거입니다. powerReason 에 한 문장으로 근거.
어떤 설정이든 거절하지 말고 반드시 이 JSON 하나만 출력:
{"concept":"...","alloc":{"atk":0,"hp":0,"def":0,"spd":0,"acc":0,"eva":0},"coherence":0,"power":20,"powerReason":"...","ult":{"name":"...","effect":"...","style":"burst"}}`;

const SYS_JUDGE_ACTION = `당신은 텍스트 RPG의 심사관입니다. 여러 플레이어가 말로 선언한 이번 라운드 행동을 각자의 캐릭터 설정에 비추어 심사합니다. 성공 여부와 피해는 주사위와 규칙이 정하므로 당신은 아래만 정합니다.
각 플레이어(p1, p2, …)에 대해:
- allowed: 게임 안에서 시도 가능한 행동인지 (true/false). 메타 발언("내가 이겼다", "상대 HP 0"), 규칙 조작, 행동이 아닌 말은 false.
- difficulty: 그 캐릭터의 설정으로 그 행동을 해낼 난이도. easy(설정에 딱 맞는 특기) / normal(할 법한 행동) / hard(설정에 없거나 무리한 시도) / impossible(설정상 절대 불가, 예: 평범한 학생이 운석 소환).
- fit 0.0~1.0: 행동 문장이 캐릭터 설정·필살기와 어울리는 정도.
- verdict: 판정 근거를 캐릭터 설정을 인용해 한두 문장으로. 심사관 말투(간결, 존댓말).
문장이 비었거나 '기본 공격'이면 allowed true, difficulty normal, fit 0.5, verdict "기본 공격으로 진행합니다."
성적 내용·혐오 표현·실존 인물 비방이 담긴 선언은 allowed false 로 기각합니다.
반드시 플레이어 수만큼 키를 넣은 이 JSON 하나만 출력:
{"p1":{"allowed":true,"difficulty":"normal","fit":0.5,"verdict":"..."},"p2":{...}}`;

const SYS_NARRATE = `당신은 텍스트 RPG 게임 마스터입니다. 전투 1라운드의 결과가 이미 계산되어 주어집니다. 결과를 바꾸지 말고 서술만 하세요.
주어진 사실(행동 순서, 심사관 판정, 누가 누구를 노렸는지, 명중/빗나감/크리티컬/방어/피해, 쓰러진 사람)을 정확히 반영해 4~7문장으로 생생하게. 현재 라운드 번호와 직전 라운드 요약이 주어지면 그 흐름을 이어서 서술하세요(2라운드 이후엔 전투 시작 장면을 다시 쓰지 말 것). 플레이어가 말로 선언한 행동을 그대로 살려서 묘사하고, 캐릭터 설정을 근거로 왜 그렇게 됐는지 언급. 줄바꿈은 <br>. 새로운 수치를 만들지 마세요. 성적 묘사·혐오 표현·실존 인물 비방은 쓰지 않습니다(전투 묘사는 만화 수준으로).
반드시 이 JSON 하나만 출력: {"narration":"..."}`;

// ─── 규칙 엔진 ───────────────────────────────────────────────────────
// 동일 예산: 모든 캐릭터는 alloc(합 100)을 같은 공식으로 스탯화한다. 설정이 아무리 세도 예산은 같다.
const ULT_STYLES = { burst: { mult: 2.4 }, precise: { mult: 1.6, accBonus: 25 }, drain: { mult: 1.5, heal: 0.5 }, shield: { mult: 1.4, guard: true } };
// 위력 등급 → 예산 배율. 비대칭: 30 이하는 완만하게 깎이고(0.6~1.0), 30 위는 제곱 곡선이라 높은 점수일수록 배율이 급히 커진다(최대 3.0).
//   코드에서도 상한을 건다: 일관성이 낮으면(막연한 전능) 위력을 45 로 자르고, 클라이언트 로컬 AI 심사면 50 으로 자른다 → AI 가 후해도 서버가 막음
function powerMult(power) { return power <= 30 ? 0.6 + power / 30 * 0.4 : 1 + Math.pow((power - 30) / 70, 2) * 2; }
const POWER_TIER = p => p <= 30 ? '평범' : p <= 50 ? '숙련' : p <= 70 ? '초인' : p <= 85 ? '전설' : '신화';
// 등급 주사위: 심사관이 매긴 위력 P 를 중심으로 등급을 확률적으로 뽑는다.
//   세게 묘사할수록(P 높음) 높은 등급이 나올 확률이 커지고, 약하게 묘사하면 낮은 등급이 대부분.
//   위쪽 등급 가중치는 ×0.35, 아래쪽은 ×1.5 → 올라가기가 내려가기보다 어렵다. 결과와 확률표를 모두 돌려줘 플레이어에게 보여 준다
const TIERS = [['평범', 0, 30], ['숙련', 31, 50], ['초인', 51, 70], ['전설', 71, 85], ['신화', 86, 100]];
function rollTier(P) {
  const w = TIERS.map(([, lo, hi]) => { const c = (lo + hi) / 2, base = Math.exp(-0.5 * Math.pow((c - P) / 14, 2)); return base * (lo > P ? 0.35 : hi < P ? 1.5 : 1); });
  const sum = w.reduce((a, b) => a + b, 0), probs = w.map(x => x / sum);
  let r = rnd(), idx = probs.length - 1;
  for (let i = 0; i < probs.length; i++) { r -= probs[i]; if (r <= 0) { idx = i; break; } }
  const [name, lo, hi] = TIERS[idx];
  let power;
  if (P >= lo && P <= hi) power = P + Math.round((rnd() - 0.5) * 8);                         // 같은 등급: 소폭 흔들림
  else if (lo > P) power = lo + Math.round(rnd() * (hi - lo) * 0.5);                          // 올라감: 그 등급의 아래쪽 절반
  else power = hi - Math.round(rnd() * (hi - lo) * 0.5);                                      // 내려감: 그 등급의 위쪽 절반
  power = Math.max(lo, Math.min(hi, power));
  return { judged: P, power, tier: name, table: TIERS.map(([n], i) => ({ tier: n, p: Math.round(probs[i] * 100) })), moved: lo > P ? 'up' : hi < P ? 'down' : 'same' };
}
function buildStats(alloc, coherence, tier = 1, power = 20, jitter = false) {
  const a = {}; let sum = 0;
  for (const k of ['atk', 'hp', 'def', 'spd', 'acc', 'eva']) { a[k] = num(alloc?.[k], 0, 100, 16.6); sum += a[k]; }
  for (const k in a) a[k] = a[k] / (sum || 1) * 100;                // 합 100 으로 정규화 (성향 배분은 예산 안에서)
  const c = num(coherence, 0, 100, 50);
  const pw = Math.round(num(power, 0, 100, 20)), m = powerMult(pw) * tier;
  const j = () => jitter ? 0.92 + rnd() * 0.16 : 1;                 // 항목별 ±8% 흔들림 (플레이어 캐릭터만)
  return {
    hp: Math.round((400 + a.hp * 8) * m * j()),                      // 기본 400 ~ 1200 × 배율
    atk: Math.round((40 + a.atk * 1.6) * m * j()),                   // 기본 40 ~ 200 × 배율
    def: Math.min(60, Math.round(a.def * 0.4 + Math.max(0, m - 1) * 8)),   // 피해 감소 % (강할수록 조금 더)
    spd: Math.round(a.spd),                                          // 선공 판정
    acc: Math.round(60 + a.acc * 0.35),                              // 60 ~ 95
    eva: Math.min(45, Math.round(a.eva * 0.3 + Math.max(0, m - 1) * 5)),
    stability: Math.round((0.55 + c / 100 * 0.45) * 100) / 100,      // 일관성 → 기술 발동 안정성 0.55 ~ 1.0 (명중률 계수)
    coherence: c, power: pw, tier: POWER_TIER(pw), mult: Math.round(m * 100) / 100,
  };
}
const ULT_COST = 3;

// 한 턴 판정. a/b = { char, hp, gauge, guard }, act = { type: 'attack'|'ult'|'defend', text }
const DIFF_MOD = { easy: 0.10, normal: 0, hard: -0.15, impossible: -1 };
const aliveSlots = players => Object.keys(players).map(Number).filter(k => players[k] && players[k].hp > 0);

// 한 라운드 판정 (N명). players = { slot: {char, hp, gauge, guard} }, acts = { slot: {type, text, target} }, judge = { slot: {allowed, difficulty, fit} }
// 대상(target)이 없거나 죽었으면 살아 있는 다른 사람 중 무작위. 행동 순서 = 속도 + 주사위.
function resolveRound(players, acts, judge = {}) {
  const slots = aliveSlots(players);
  const order = slots.map(k => [k, players[k].char.stats.spd + rnd() * 30]).sort((x, y) => y[1] - x[1]).map(x => x[0]);
  const events = [];
  for (const k of slots) if ((acts[k] || {}).type === 'defend') players[k].guard = true;   // 방어 선언은 라운드 내내 유효
  for (const k of order) {
    const me = players[k]; if (me.hp <= 0) continue;
    const act = acts[k] || { type: 'attack' }, j = judge[k] || {};
    const fit = num(j.fit, 0, 1, 0.5), diff = DIFF_MOD[j.difficulty] ?? 0, allowed = j.allowed !== false;
    if (act.type === 'defend') { me.gauge = Math.min(ULT_COST, me.gauge + 2); events.push({ who: k, type: 'defend' }); continue; }
    const others = aliveSlots(players).filter(x => x !== k);
    if (!others.length) break;
    const tk = others.includes(Number(act.target)) ? Number(act.target) : others[Math.floor(rnd() * others.length)];
    const foe = players[tk];
    const isUlt = act.type === 'ult' && me.gauge >= ULT_COST;
    if (act.type === 'ult' && !isUlt) events.push({ who: k, type: 'ult_fail' });
    const s = me.char.stats, t = foe.char.stats, style = ULT_STYLES[me.char.ult.style] || ULT_STYLES.burst;
    const acc = s.acc + (isUlt && style.accBonus ? style.accBonus : 0);
    const dmod = diff <= -1 ? -1 : (!allowed ? DIFF_MOD.hard : diff);   // 불가능 → 자동 실패, 불허 → 기본 공격 + 어려움
    const chance = dmod <= -1 ? 0 : Math.min(0.95, Math.max(0.05, (acc - t.eva) / 100 * s.stability + dmod));
    const hit = rnd() < chance, crit = hit && rnd() < 0.1;
    let dmg = 0;
    if (hit) {
      dmg = s.atk * (isUlt ? style.mult : 1) * (0.9 + rnd() * 0.2) * (crit ? 1.5 : 1) * (0.85 + fit * 0.3);
      dmg *= 1 - t.def / 100; if (foe.guard) dmg *= 0.5;
      dmg = Math.max(1, Math.round(dmg));
      foe.hp = Math.max(0, foe.hp - dmg);
      if (isUlt && style.heal) me.hp = Math.min(me.char.stats.hp, me.hp + Math.round(dmg * style.heal));
      if (isUlt && style.guard) me.guardNext = true;
    }
    if (isUlt) me.gauge -= ULT_COST; else me.gauge = Math.min(ULT_COST, me.gauge + 1);
    events.push({ who: k, target: tk, type: isUlt ? 'ult' : 'attack', hit, crit, dmg, chance: Math.round(chance * 100), guarded: hit && foe.guard, fit, difficulty: allowed ? (j.difficulty || 'normal') : 'denied', killed: foe.hp <= 0 });
    if (aliveSlots(players).length <= 1) break;
  }
  for (const k of slots) { const p = players[k]; p.guard = !!p.guardNext; p.guardNext = false; }
  return { order, events };
}
const DIFF_KO = { easy: '쉬움', normal: '보통', hard: '어려움', impossible: '불가', denied: '불허' };
function factsText(names, events) {
  return events.map(e => {
    const n = names[e.who];
    if (e.type === 'defend') return `${n}: 방어 태세 (받는 피해 절반, 게이지 +2)`;
    if (e.type === 'ult_fail') return `${n}: 필살기를 쓰려 했으나 게이지 부족 → 기본 공격`;
    const k = e.type === 'ult' ? '필살기' : '공격', d = DIFF_KO[e.difficulty] || '보통';
    return e.hit ? `${n} → ${names[e.target]}: ${k} 명중(${e.chance}%, 난이도 ${d})${e.crit ? ' 크리티컬!' : ''}${e.guarded ? ' (상대 방어로 절반)' : ''} → 피해 ${e.dmg}${e.killed ? ' — ' + names[e.target] + ' 쓰러짐' : ''}` : `${n} → ${names[e.target]}: ${k} 실패(명중률 ${e.chance}%, 난이도 ${d})`;
  }).join('\n');
}
function templateNarration(names, events) {
  return factsText(names, events).replace(/\n/g, '<br>') + '<br>(게임 마스터의 목소리가 닿지 않아 사실만 기록합니다)';
}

// 한 라운드 = 심사관(AI, 짧음) → 규칙 엔진 → 게임 마스터 서술(AI). 어느 AI 호출이든 실패/한도면 그 단계만 기본값으로 진행.
const actLabel = t => t === 'defend' ? '방어' : t === 'ult' ? '필살기' : '공격';
function charLine(k, p, act, names) {
  const tgt = act.target && names[act.target] ? ` → 대상: ${names[act.target]}` : '';
  return `[p${k}] ${p.char.name} (${p.char.fiction}) — 설정: ${p.char.info} / 필살기 ${p.char.ult.name}: ${p.char.ult.effect}
행동: ${actLabel(act.type)}${tgt} / 선언: "${act.text || '기본 공격'}"`;
}
// ctx: { round, prev } — 라운드 번호와 직전 라운드 요약을 GM 에게 넘겨 "첫 라운드"라고 반복하지 않게 한다
async function runRound(env, ip, players, acts, ctx = {}) {
  const names = {}; for (const k in players) if (players[k]) names[k] = players[k].char.name;
  const slots = aliveSlots(players);
  const judge = {}; for (const k of slots) judge[k] = acts[k]?.policy
    ? { allowed: false, difficulty: 'hard', fit: 0.3, verdict: `선언이 이용 정책(${acts[k].policy})에 어긋나 심사하지 않습니다. 기본 공격으로 처리합니다.`, policy: true }
    : { allowed: true, difficulty: 'normal', fit: 0.5, verdict: '' };
  let usedAi = false, quotaBlocked = null, provider = null;
  const clampJudge = p => ({ allowed: p.allowed !== false, difficulty: DIFF_MOD[p.difficulty] !== undefined ? p.difficulty : 'normal', fit: num(p.fit, 0, 1, 0.5), verdict: cleanVerdict(p.verdict) });
  const needJudge = slots.some(k => acts[k]?.text);
  if (needJudge) {
    const user = slots.map(k => charLine(k, players[k], acts[k] || { type: 'attack' }, names)).join('\n\n');
    const r = await aiCall(env, ip, SYS_JUDGE_ACTION, user, 0.2);
    if (r.ok) { provider = r.provider; for (const k of slots) { const p = r.parsed?.['p' + k]; if (p && !judge[k].policy) judge[k] = clampJudge(p); } }
    else {
      quotaBlocked = r.reason;
      // 서버 AI 가 없으면 각 플레이어가 자기 크롬 내장 AI 로 심사해 보낸 결과를 쓴다 (수치는 규칙 엔진이 정하므로 영향 범위는 난이도·적합도뿐)
      for (const k of slots) if (acts[k]?.local && typeof acts[k].local === 'object' && !judge[k].policy) judge[k] = { ...clampJudge(acts[k].local), src: 'local' };
    }
  }
  const res = resolveRound(players, acts, judge);
  let narration = templateNarration(names, res.events);
  const head = ctx.round ? `현재 ${ctx.round}라운드${ctx.round === 1 ? ' (전투 시작)' : ' (전투는 이미 진행 중 — "첫 라운드"·"전투가 시작되자" 같은 표현 금지)'}${ctx.prev ? `\n직전 라운드 요약: ${ctx.prev}` : ''}\n\n` : '';
  const narrateUser = head + slots.map(k => `${charLine(k, players[k], acts[k] || { type: 'attack' }, names)}\n심사관 판정: ${judge[k].allowed ? '' : '불허 — '}${judge[k].verdict || '기본 공격'}`).join('\n\n')
    + `\n\n행동 순서: ${res.order.map(k => names[k]).join(' → ')}\n[확정된 결과]\n${factsText(names, res.events)}\n남은 HP: ${slots.map(k => `${names[k]} ${players[k].hp}/${players[k].char.stats.hp}`).join(', ')}`;
  const r2 = await aiCall(env, ip, SYS_NARRATE, narrateUser, 0.9);
  if (r2.ok) { provider = provider || r2.provider; if (r2.parsed?.narration) { narration = safeHtml(r2.parsed.narration); usedAi = true; } }
  else quotaBlocked = quotaBlocked || r2.reason;
  // 서술을 못 얻었으면 클라이언트 로컬 AI 가 이어받을 수 있게 프롬프트를 남긴다 (서술이 채워지면 제거)
  return { events: res.events, order: res.order, judge, narration, usedAi, provider, quotaBlocked, narrateUser: usedAi ? undefined : narrateUser };
}
// 클라이언트 로컬 AI 서술을 로그에 채움 (서버 서술이 없던 항목만, 먼저 온 것이 이김)
async function fillNarration(entry, narration, env) {
  if (!entry || entry.ai) return false;
  if (!(await moderate(env, narration)).ok) return false;
  entry.narration = safeHtml(narration); entry.ai = 'local'; delete entry.narrateUser;
  return true;
}
async function narrateBattle(id, body, env) {
  const row = await env.DB.prepare('SELECT state FROM rpg_battles WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'no_battle' }, 404);
  const st = JSON.parse(row.state);
  if (!(await loadChar(env, st.charId, body.token))) return json({ error: 'forbidden' }, 403);
  const ok = await fillNarration(st.log.find(l => l.turn === Number(body.turn)), body.narration, env);
  if (ok) await env.DB.prepare('UPDATE rpg_battles SET state = ? WHERE id = ?').bind(JSON.stringify(st), id).run();
  return json({ ok });
}
async function narrateRoom(code, body, env) {
  for (let i = 0; i < 3; i++) {
    const r = await loadRoom(env, code);
    if (!r) return json({ error: 'no_room' }, 404);
    const mySlot = slotOf(r.s, body.token);
    if (!mySlot) return json({ error: 'forbidden' }, 403);
    const entry = r.s.log.find(l => l.round === Number(body.round));
    if (entry && entry.resolver && mySlot !== entry.resolver && mySlot !== r.s.host) return json({ error: 'forbidden' }, 403);   // 판정 요청자나 방장만 서술을 채울 수 있다
    const ok = await fillNarration(entry, body.narration, env);
    if (!ok) return json({ ok: false });
    if (await saveRoom(env, code, r.s, r.v)) return json({ ok: true });
  }
  return json({ error: 'retry' }, 409);
}

// ─── 캐릭터 ─────────────────────────────────────────────────────────
function publicChar(c) { return c; }
async function loadChar(env, id, token) {
  const row = await env.DB.prepare('SELECT token, json FROM rpg_chars WHERE id = ?').bind(id).first();
  if (!row || row.token !== token) return null;
  return JSON.parse(row.json);
}
// 승점 = PvE 승 1점 + PvP 승 3점 (순위표). 컬럼에 같이 써서 정렬 쿼리가 JSON 을 열지 않게 한다
const scoreOf = c => Math.round((c.wins || 0) + (c.pvpWins || 0) * 2);   // 자동 생사결 승 = pvpWins 0.5 → 총 2점
async function saveChar(env, c) { await env.DB.prepare('UPDATE rpg_chars SET json = ?, score = ?, name = ?, updated = ? WHERE id = ?').bind(JSON.stringify(c), scoreOf(c), c.name, Date.now(), c.id).run(); lbCache.at = 0; }   // 승점이 바뀌었을 수 있으니 순위표 캐시 비움

async function createChar(body, env, ip) {
  const name = clip(body.name, LEN.name), setting = clip(body.setting, LEN.setting);
  if (!name || !setting) return json({ error: 'bad_request' }, 400);
  if (Math.random() < 0.05) await env.DB.prepare('DELETE FROM rpg_chars WHERE user_sub IS NULL AND score = 0 AND COALESCE(updated, created) < ?').bind(Date.now() - 90 * 86400e3).run();   // 손님·무승·90일 미사용 캐릭터 정리
  const mod = await moderate(env, name + '\n' + setting);
  if (!mod.ok) return json({ error: 'policy', reason: mod.reason, label: mod.label }, 400);
  const r = await aiCall(env, ip, SYS_JUDGE, `이름: ${name}\n설정: ${setting}`, 0.2);
  let parsed, judgedBy = r.provider;
  if (r.ok) parsed = r.parsed;
  else if (body.local && typeof body.local === 'object') { parsed = body.local; judgedBy = 'local'; }   // 서버 AI 소진 → 클라이언트 크롬 내장 AI 의 심사 결과 (buildStats 가 예산·범위를 강제)
  else if (r.reason === 'failed') return json({ error: 'ai_failed', quota: pubQuota(await quota(env, ip)) }, 502);
  else return json({ error: 'quota', reason: r.reason, quota: pubQuota(await quota(env, ip)) }, 429);
  // 심사관이 형식을 어기거나 거절해도 플레이어를 막지 않는다: 균등 배분 + 낮은 일관성(불명확한 설정)으로 진행
  if (!parsed || !parsed.alloc) parsed = { concept: parsed?.concept, alloc: null, coherence: 30, ult: parsed?.ult, fallback: true };
  const ult = parsed.ult || {};
  const luck = rollTier(Math.round(num(parsed.power, 0, 100, 20)));
  const c = {
    id: uid(), name, info: setting, fiction: clip(parsed.concept, LEN.fiction) || (parsed.fallback ? '정체불명의 몽상가' : '이름 없는 몽상가'), judged: parsed.fallback ? false : judgedBy,
    stats: buildStats(parsed.alloc, parsed.coherence, 1, Math.min(luck.power, num(parsed.coherence, 0, 100, 50) < 60 ? 45 : 100, judgedBy === 'local' ? 50 : 100), true),
    powerReason: clip(parsed.powerReason, 120), luck,
    ult: { name: clip(ult.name, LEN.ultName) || '혼신의 일격', effect: clip(ult.effect, LEN.ultEffect) || '온 힘을 담은 한 방', style: ULT_STYLES[ult.style] ? ult.style : 'burst' },
    wins: 0, losses: 0, created: Date.now(),
  };
  const token = uid();
  // 로그인 세션이 있으면 캐릭터를 계정에 연결 (다른 기기에서 복구·순위표 이름 표시)
  const sub = body.session ? await sessionUser(env, body.session) : null;
  await env.DB.prepare('INSERT INTO rpg_chars (id, token, json, created, score, name, user_sub) VALUES (?, ?, ?, ?, 0, ?, ?)').bind(c.id, token, JSON.stringify(c), c.created, c.name, sub).run();
  return json({ char: publicChar(c), token, quota: pubQuota(await quota(env, ip)) });
}
async function getChar(id, token, env) {
  const c = await loadChar(env, id, token);
  return c ? json({ char: publicChar(c) }) : json({ error: 'forbidden' }, 403);
}

// ─── AI 상대 전투 ──────────────────────────────────────────────────
// 상대는 같은 예산 공식으로 만들되 tier 로 강함을 조절 (1.0 보통, 1.3 강적, 1.8 보스). 설정은 서술용.
const ENEMIES = [
  ['노정원', '평범한 고등학생', { atk: 15, hp: 25, def: 10, spd: 20, acc: 20, eva: 10 }, 80, ['업어치기', '온 힘을 다해 메친다', 'burst'], '대한민국의 평범한 고등학생. 컴퓨터를 배우고 유도를 한다.', 0.9],
  ['탄지로 가마도', '물의 호흡 귀살대', { atk: 20, hp: 20, def: 10, spd: 20, acc: 20, eva: 10 }, 85, ['히노카미 카구라', '불꽃의 춤으로 베어낸다', 'burst'], '여동생을 되돌리기 위해 귀살대가 된 소년. 물과 불의 호흡을 쓴다.', 1],
  ['미카사 아커만', '무쌍의 병사', { atk: 20, hp: 15, def: 5, spd: 30, acc: 25, eva: 5 }, 80, ['입체기동 참격', '순간적으로 후방을 벤다', 'precise'], '엘런을 지키기 위해 무엇이든 하는 병사.', 1],
  ['키리토', '검의 플레이어', { atk: 22, hp: 18, def: 8, spd: 22, acc: 20, eva: 10 }, 75, ['스타버스트 스트림', '쌍검 16연격', 'burst'], 'VRMMO 세계의 최강자. 쌍검 스킬을 쓴다.', 1],
  ['루피', '고무고무 해적', { atk: 22, hp: 28, def: 12, spd: 15, acc: 13, eva: 10 }, 70, ['기어 세컨드', '혈류를 가속해 연속 타격', 'burst'], '고무 인간. 타격에 강하지만 베기에 약하다.', 1.1],
  ['조로', '삼도류 검사', { atk: 28, hp: 20, def: 10, spd: 14, acc: 18, eva: 10 }, 75, ['오의: 삼천세계', '세 자루 검의 연속 베기', 'burst'], '세계 최강의 검사를 목표로 하는 검사. 길을 잘 잃는다.', 1.1],
  ['이누마키 토게', '말의 저주사', { atk: 25, hp: 12, def: 5, spd: 18, acc: 30, eva: 10 }, 65, ['폭발해', '한 마디로 적을 폭파하지만 목이 상한다', 'precise'], '주술어로 적을 조종하거나 제압한다. 남용하면 자신도 다친다.', 1],
  ['토도로키 쇼토', '얼음과 불의 계승자', { atk: 24, hp: 18, def: 14, spd: 12, acc: 20, eva: 12 }, 80, ['빙염 충돌', '얼음과 불을 동시에 발산', 'shield'], '양쪽 능력을 깨달은 히어로.', 1.2],
  ['리바이 아커만', '인류 최강의 병사', { atk: 24, hp: 14, def: 6, spd: 30, acc: 20, eva: 6 }, 85, ['회오리 참격', '회전하며 순간에 베어낸다', 'precise'], '냉철한 판단과 검술의 최고 병사.', 1.3],
  ['손오공', '사이어인의 전사', { atk: 30, hp: 25, def: 10, spd: 15, acc: 12, eva: 8 }, 70, ['카메하메하', '에너지 파동', 'burst'], '지구를 수호하는 싸움꾼. 끝없이 수련한다.', 1.4],
  ['유우타 오코츠', '특급 주술사', { atk: 25, hp: 20, def: 10, spd: 15, acc: 15, eva: 15 }, 75, ['리카 소환', '리카의 힘으로 큰 피해와 회복', 'drain'], '사랑과 저주를 안고 싸우는 주술사.', 1.4],
  ['고죠 사토루', '천상천하 유아독존', { atk: 25, hp: 15, def: 20, spd: 15, acc: 15, eva: 10 }, 60, ['무량공처', '영역 전개로 상대를 무력화', 'shield'], '최강의 주술사. 무한으로 접촉을 막지만 오만하다.', 1.8],
];
function makeEnemy(i, scale = 1) {
  const [name, fiction, alloc, coherence, ult, info, tier] = ENEMIES[i];
  const e = { id: 'enemy-' + i, name, fiction, info, stats: buildStats(alloc, coherence, tier * scale), ult: { name: ult[0], effect: ult[1], style: ult[2] }, tier };
  e.stats.tier = tier >= 1.4 ? '전설' : tier >= 1.1 ? '초인' : tier >= 1 ? '숙련' : '평범';   // 표시용 등급은 원래 강적 등급대로
  return e;
}
function pickEnemy(c) {
  const rec = c.wins - c.losses;                                     // 이기고 있으면 강적이 더 자주
  const weights = ENEMIES.map(e => { const t = e[6]; return 1 / (1 + Math.abs(t - (1 + Math.max(0, Math.min(3, rec)) * 0.25)) * 3); });
  let r = rnd() * weights.reduce((s, w) => s + w, 0);
  const scale = Math.sqrt(c.stats.mult || 1);                       // 강한 캐릭터에겐 상대도 조금 강하게 (배율의 제곱근 → 여전히 압도적)
  for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) return makeEnemy(i, scale); }
  return makeEnemy(0, scale);
}
// 상대 AI: 게이지 차면 필살기(HP 낮을수록 더 자주), 내 HP 가 낮고 상대 게이지가 차 있으면 가끔 방어
function enemyDecide(e, me) {
  if (e.gauge >= ULT_COST && rnd() < (e.hp < e.char.stats.hp * 0.5 ? 0.85 : 0.5)) return { type: 'ult', text: `${e.char.ult.name}! ${e.char.ult.effect}` };
  if (me.gauge >= ULT_COST && e.hp < e.char.stats.hp * 0.4 && rnd() < 0.35) return { type: 'defend', text: '자세를 낮추고 상대의 다음 수를 기다린다' };
  return { type: 'attack', text: '' };
}

async function createBattle(body, env) {
  const c = await loadChar(env, body.charId, body.token);
  if (!c) return json({ error: 'forbidden' }, 403);
  await env.DB.prepare('DELETE FROM rpg_battles WHERE updated < ?').bind(Date.now() - BATTLE_TTL).run();
  let foe, mode = body.mode === 'auto' ? 'auto' : 'pve', foeId = null;
  if (mode === 'auto') {
    const row = await env.DB.prepare('SELECT id, json FROM rpg_chars WHERE auto = 1 AND id != ? ORDER BY RANDOM() LIMIT 1').bind(c.id).first();
    if (!row) return json({ error: 'no_auto' }, 404);
    foe = JSON.parse(row.json); foeId = row.id; foe.tier = 1;
  } else foe = pickEnemy(c);
  const st = { id: uid(), charId: c.id, mode, foeId, me: { char: c, hp: c.stats.hp, gauge: 0, guard: false }, foe: { char: foe, hp: foe.stats.hp, gauge: 0, guard: false }, turn: 1, log: [], status: 'playing', winner: null };
  await env.DB.prepare('INSERT INTO rpg_battles (id, char_id, state, updated) VALUES (?, ?, ?, ?)').bind(st.id, c.id, JSON.stringify(st), Date.now()).run();
  return json({ battle: st });
}
function parseAct(body) { return { type: ['attack', 'ult', 'defend'].includes(body.type) ? body.type : 'attack', text: clip(body.text, LEN.text), target: Number(body.target) || null }; }
// 선언문 검열: 위반이면 문장을 지우고(AI 에 안 보냄) policy 표시만 남긴다 → 심사관이 기각, 기본 공격으로 진행
async function parseActSafe(body, env) {
  const a = parseAct(body);
  if (a.text) { const m = await moderate(env, a.text); if (!m.ok) { a.text = ''; a.policy = m.label; delete body.local; } }
  return a;
}

async function getBattle(id, token, env) {
  const row = await env.DB.prepare('SELECT state, updated FROM rpg_battles WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'no_battle' }, 404);
  const st = JSON.parse(row.state);
  if (!(await loadChar(env, st.charId, token))) return json({ error: 'forbidden' }, 403);
  return json({ battle: st });
}
// 승리 보상: 기본 HP +(10~30) · ATK +(1~4) 에 내 배율(mult)·상대 등급·자동 생사결 여부를 곱하고, 10% 로 부가 능력치(방어/명중/회피) 보너스, 5% 로 대성공(2배)
function rollReward(c, foe, mode) {
  const mult = (c.stats.mult || 1), ft = (TIER_IDX[foe.stats?.tier] ?? 1), scale = mult * (1 + ft * 0.25) * (mode === 'auto' ? 1.3 : 1);
  let hp = Math.round((10 + rnd() * 20) * scale), atk = Math.round((1 + rnd() * 3) * scale);
  const r = { hp, atk, tags: [] };
  if (rnd() < 0.05) { r.hp *= 2; r.atk *= 2; r.tags.push('대성공'); }
  if (rnd() < 0.10) { const opts = [['def', 1, 60], ['acc', 1, 99], ['eva', 1, 50]]; const [stat, amount, max] = opts[Math.floor(rnd() * opts.length)]; r.bonus = { stat, amount, max }; r.tags.push({ def: '방어 +1%', acc: '명중 +1', eva: '회피 +1' }[stat]); }
  return r;
}
// 도망: 성공 확률 = 내 속도·회피가 상대보다 높을수록 ↑, 등급이 높을수록 ↓(체면·추격). 실패하면 패배로 기록되고 HP·ATK 를 조금 잃는다(등급이 높을수록 잃는 양이 큼)
const TIER_IDX = { '평범': 0, '숙련': 1, '초인': 2, '전설': 3, '신화': 4 };
function escapeRoll(me, foe) {
  const t = TIER_IDX[me.char.stats.tier] ?? 0, ft = TIER_IDX[foe.char.stats.tier] ?? 1;
  const p = 0.75 + (me.char.stats.spd - foe.char.stats.spd) / 120 + me.char.stats.eva / 200 - t * 0.06 + (ft - t) * 0.04 - (me.hp < me.char.stats.hp * 0.3 ? 0.1 : 0);
  const chance = Math.min(0.95, Math.max(0.2, p));
  const ok = rnd() < chance;
  if (ok) return { ok, chance: Math.round(chance * 100) };
  const sev = 1 + t * 0.6;                                                 // 등급별 손실 배율 (평범 1 → 신화 3.4)
  const hp = Math.round(me.char.stats.hp * (0.02 + rnd() * 0.04) * sev), atk = Math.round(me.char.stats.atk * (0.01 + rnd() * 0.03) * sev);
  return { ok, chance: Math.round(chance * 100), penalty: { hp, atk } };
}
async function leaveBattle(id, body, env) {
  const row = await env.DB.prepare('SELECT state FROM rpg_battles WHERE id = ?').bind(id).first();
  if (!row) return json({ ok: true, escaped: true });
  const st = JSON.parse(row.state);
  const c = await loadChar(env, st.charId, body.token);
  if (!c) return json({ error: 'forbidden' }, 403);
  let result = { ok: true, escaped: true };
  if (st.status === 'playing' && st.log.length) {                         // 한 턴이라도 싸운 뒤의 도망만 판정 (시작 직후엔 자유)
    const r = escapeRoll(st.me, st.foe);
    if (!r.ok) {
      c.losses++; c.stats.hp = Math.max(200, c.stats.hp - r.penalty.hp); c.stats.atk = Math.max(20, c.stats.atk - r.penalty.atk);
      await saveChar(env, c);
      result = { ok: true, escaped: false, chance: r.chance, penalty: r.penalty, char: c, message: `도망치다 ${st.foe.char.name}에게 붙잡혔다! 패배 기록 · HP 최대치 -${r.penalty.hp} · ATK -${r.penalty.atk}` };
    } else result = { ok: true, escaped: true, chance: r.chance, message: `${st.foe.char.name}을(를) 따돌리고 도망쳤다. (성공 확률 ${r.chance}%)` };
  }
  await env.DB.prepare('DELETE FROM rpg_battles WHERE id = ?').bind(id).run();
  return json(result);
}
async function battleTurn(id, body, env, ip) {
  const row = await env.DB.prepare('SELECT state, updated FROM rpg_battles WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'no_battle' }, 404);
  const st = JSON.parse(row.state);
  const c = await loadChar(env, st.charId, body.token);
  if (!c) return json({ error: 'forbidden' }, 403);
  if (st.status !== 'playing') return json({ battle: st });
  // 낙관적 잠금: 같은 턴을 두 번 처리하지 않게
  const lock = await env.DB.prepare('UPDATE rpg_battles SET updated = ? WHERE id = ? AND updated = ?').bind(Date.now(), id, row.updated).run();
  if (lock.meta.changes !== 1) return json({ error: 'retry' }, 409);
  const actMe = { ...await parseActSafe(body, env), target: 2, local: body.local }, actFoe = { ...enemyDecide(st.foe, st.me), target: 1 };
  const prevLog = st.log[st.log.length - 1];
  const t = await runRound(env, ip, { 1: st.me, 2: st.foe }, { 1: actMe, 2: actFoe }, { round: st.turn, prev: prevLog ? factsText({ 1: st.me.char.name, 2: st.foe.char.name }, prevLog.events).replace(/\n/g, ' / ') : '' });
  delete actMe.local;
  st.log.push({ turn: st.turn, acts: { 1: actMe, 2: actFoe }, judge: t.judge, order: t.order, events: t.events, narration: t.narration, ai: t.usedAi, provider: t.provider, narrateUser: t.narrateUser });
  if (st.log.length > 40) st.log.shift();
  if (st.me.hp <= 0 || st.foe.hp <= 0) {
    st.status = 'finished'; st.winner = st.me.hp <= 0 ? 2 : 1;
    if (st.winner === 1) {
      c.wins++;
      st.reward = rollReward(c, st.foe.char, st.mode);
      c.stats.hp = Math.min(6000, c.stats.hp + st.reward.hp); c.stats.atk = Math.min(800, c.stats.atk + st.reward.atk);
      if (st.reward.bonus) c.stats[st.reward.bonus.stat] = Math.min(st.reward.bonus.max, c.stats[st.reward.bonus.stat] + st.reward.bonus.amount);
      if (st.mode === 'auto') { c.autoWins = (c.autoWins || 0) + 1; c.pvpWins = (c.pvpWins || 0) + 0.5; }
    } else { c.losses++; if (st.mode === 'auto') c.autoLosses = (c.autoLosses || 0) + 1; }
    await saveChar(env, c); st.me.char = c;
    if (st.mode === 'auto' && st.foeId) await recordAutoResult(env, st, c);
  } else st.turn++;
  await env.DB.prepare('UPDATE rpg_battles SET state = ?, updated = ? WHERE id = ?').bind(JSON.stringify(st), Date.now(), id).run();
  return json({ battle: st, quota: pubQuota(await quota(env, ip)), quotaBlocked: t.quotaBlocked });
}

// ─── 온라인 대전 (2~6명) ─────────────────────────────────────────────
// 방장이 '시작'을 누르면 진행. 라운드마다 살아 있는 전원이 행동(공격/필살기는 대상 선택)을 내면 판정.
// 60초 넘게 안 내는 사람은 다른 플레이어가 건너뛸 수 있다(자동 방어). 마지막 생존자가 승리, 전멸이면 무승부.
const ROOM_MAX = 6, SKIP_AFTER_MS = 60e3, AFK_FORFEIT = 3;
const code6 = () => Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(rnd() * 32)]).join('');
async function loadRoom(env, code) {
  const row = await env.DB.prepare('SELECT state, updated FROM rpg_rooms WHERE code = ?').bind(code).first();
  return row ? { s: JSON.parse(row.state), v: row.updated } : null;
}
async function saveRoom(env, code, s, v) {
  const now = Date.now();
  const r = await env.DB.prepare('UPDATE rpg_rooms SET state = ?, updated = ? WHERE code = ? AND updated = ?').bind(JSON.stringify(s), now, code, v).run();
  return r.meta.changes === 1 ? now : null;
}
const slotOf = (s, t) => Number(Object.keys(s.tokens).find(k => s.tokens[k] === t)) || 0;
function pub(s, slot) {
  const { tokens, who, ...rest } = s;
  rest.log = s.log.map((l, i) => i < s.log.length - 2 && l.narrateUser ? { ...l, narrateUser: undefined } : l);   // 최근 2라운드만 로컬 서술 프롬프트 포함 (폴링 응답 크기)
  const moves = {}; for (const k in s.p) moves[k] = !!s.moves[k];
  const firstAt = Math.min(...Object.values(s.moves).map(m => m.at || Infinity));
  return { ...rest, you: slot, moves, myMove: s.moves[slot] || null, waitingSince: Number.isFinite(firstAt) ? firstAt : null, max: ROOM_MAX };
}
async function createRoom(body, env, isPublic = false, who = null) {
  const c = await loadChar(env, body.charId, body.token);
  if (!c) return json({ error: 'forbidden' }, 403);
  await env.DB.prepare('DELETE FROM rpg_rooms WHERE updated < ?').bind(Date.now() - ROOM_TTL).run();
  const code = code6(), rt = uid(), now = Date.now();
  const s = { code, host: 1, p: { 1: { char: c, hp: c.stats.hp, gauge: 0, guard: false, afk: 0 } }, tokens: { 1: rt }, who: { 1: who }, round: 0, moves: {}, log: [], status: 'waiting', winner: null, public: isPublic || undefined };
  await env.DB.prepare('INSERT INTO rpg_rooms (code, created, updated, state) VALUES (?, ?, ?, ?)').bind(code, now, now, JSON.stringify(s)).run();
  return json({ code, roomToken: rt, slot: 1, state: pub(s, 1) });
}
// 랜덤 대전(1:1): 최근 2분 안에 만들어진 공개 대기 방 중 하나에 들어가 바로 시작. 없으면 공개 방을 만들고 기다린다 (방장 시작 불필요)
const MATCH_FRESH_MS = 2 * 60e3;
async function matchRoom(body, env, who = null) {
  const c = await loadChar(env, body.charId, body.token);
  if (!c) return json({ error: 'forbidden' }, 403);
  const rows = await env.DB.prepare('SELECT code, state, updated FROM rpg_rooms WHERE updated > ? ORDER BY updated ASC LIMIT 30').bind(Date.now() - MATCH_FRESH_MS).all();
  for (const row of (rows?.results || [])) {
    const s = JSON.parse(row.state);
    if (!s.public || s.status !== 'waiting' || Object.keys(s.p).length !== 1) continue;
    if (s.p[1].char.id === c.id) return json({ code: s.code, roomToken: s.tokens[1], slot: 1, state: pub(s, 1), rejoined: true });   // 내가 만든 대기 방
    const rt = uid();
    s.p[2] = { char: c, hp: c.stats.hp, gauge: 0, guard: false, afk: 0 }; s.tokens[2] = rt; (s.who ||= {})[2] = who;
    s.status = 'playing'; s.round = 1;   // 둘이 모이면 바로 시작
    if (await saveRoom(env, s.code, s, row.updated)) return json({ code: s.code, roomToken: rt, slot: 2, state: pub(s, 2), matched: true });
    // 동시에 다른 사람이 들어갔으면 다음 방으로
  }
  return createRoom(body, env, true, who);
}
async function joinRoom(code, body, env, who = null) {
  const c = await loadChar(env, body.charId, body.token);
  if (!c) return json({ error: 'forbidden' }, 403);
  const r = await loadRoom(env, code);
  if (!r) return json({ error: 'no_room' }, 404);
  const s = r.s;
  // 같은 캐릭터가 다시 오면 (새로고침·앱 전환) 기존 자리로 재접속 — 캐릭터 토큰으로 본인 확인됨
  const mine = Object.keys(s.p).find(k => s.p[k].char.id === c.id);
  if (mine) return json({ code, roomToken: s.tokens[mine], slot: Number(mine), state: pub(s, Number(mine)), rejoined: true });
  if (s.status !== 'waiting') return json({ error: 'started' }, 409);
  if (s.public) return json({ error: 'no_room' }, 404);   // 랜덤 매칭용 공개 방은 코드로 못 들어감
  if (Object.keys(s.p).length >= ROOM_MAX) return json({ error: 'full' }, 409);
  const slot = [1, 2, 3, 4, 5, 6].find(k => !s.p[k]), rt = uid();
  s.p[slot] = { char: c, hp: c.stats.hp, gauge: 0, guard: false, afk: 0 }; s.tokens[slot] = rt; (s.who ||= {})[slot] = who;
  if (!(await saveRoom(env, code, s, r.v))) return json({ error: 'retry' }, 409);
  return json({ code, roomToken: rt, slot, state: pub(s, slot) });
}
async function getRoom(code, t, env) {
  const r = await loadRoom(env, code);
  if (!r) return json({ error: 'no_room' }, 404);
  const slot = slotOf(r.s, t);
  if (!slot) return json({ error: 'forbidden' }, 403);
  if (r.s.public && r.s.status === 'waiting' && Date.now() - r.v > 45e3) await saveRoom(env, code, r.s, r.v);   // 대기 중인 공개 방은 폴링으로 살아 있음을 갱신 (매칭 후보 유지)
  return json({ state: pub(r.s, slot) });
}
async function startRoom(code, body, env) {
  const r = await loadRoom(env, code);
  if (!r) return json({ error: 'no_room' }, 404);
  const s = r.s, slot = slotOf(s, body.token);
  if (slot !== s.host) return json({ error: 'not_host' }, 403);
  if (s.status !== 'waiting') return json({ state: pub(s, slot) });
  if (Object.keys(s.p).length < 2) return json({ error: 'need_players' }, 409);
  s.status = 'playing'; s.round = 1;
  if (!(await saveRoom(env, code, s, r.v))) return json({ error: 'retry' }, 409);
  return json({ state: pub(s, slot) });
}
async function roomAction(code, body, env, ip) {
  const r = await loadRoom(env, code);
  if (!r) return json({ error: 'no_room' }, 404);
  const s = r.s, slot = slotOf(s, body.token);
  if (!slot) return json({ error: 'forbidden' }, 403);
  if (s.status !== 'playing') return json({ state: pub(s, slot) });
  const alive = aliveSlots(s.p);
  if (body.skip) {
    // 60초 넘게 안 낸 사람들을 자동 방어로 처리 (누구나 요청 가능)
    const firstAt = Math.min(...Object.values(s.moves).map(m => m.at || Infinity));
    if (!Number.isFinite(firstAt) || Date.now() - firstAt < SKIP_AFTER_MS) return json({ error: 'too_early', state: pub(s, slot) }, 409);
    for (const k of alive) if (!s.moves[k]) {
      const p = s.p[k]; p.afk = (p.afk || 0) + 1;
      if (p.afk >= AFK_FORFEIT) { forfeit(s, k, 'afk'); delete s.moves[k]; }   // 3라운드 연속 무응답 → 기권
      else s.moves[k] = { type: 'defend', text: '', target: null, at: Date.now(), skipped: true };
    }
  } else {
    if (!alive.includes(slot)) return json({ error: 'dead', state: pub(s, slot) }, 409);
    if (s.moves[slot]) return json({ state: pub(s, slot) });
    s.moves[slot] = { ...await parseActSafe(body, env), at: Date.now(), local: body.local && typeof body.local === 'object' ? body.local : undefined }; s.p[slot].afk = 0;
  }
  return settleRoom(env, ip, code, s, r.v, slot);
}
// 기권 처리: HP 0 + 표시 (패배 집계는 종료 시 승자 외 전원)
function forfeit(s, k, why) { const p = s.p[k]; p.hp = 0; p.guard = false; p.left = why; }
// 라운드 마무리 공통: 전원 제출이면 판정, 생존자 1명 이하이면 종료. 그 외엔 저장만
async function settleRoom(env, ip, code, s, v, slot) {
  const alive = aliveSlots(s.p);
  if (alive.length > 1 && alive.some(k => !s.moves[k])) {
    if (!(await saveRoom(env, code, s, v))) return json({ error: 'retry' }, 409);
    return json({ state: pub(s, slot) });
  }
  s.busy = true;
  const v2 = await saveRoom(env, code, s, v);   // 낙관적 잠금: 동시 요청 중 하나만 판정
  if (!v2) return json({ error: 'retry' }, 409);
  let quotaBlocked = null;
  if (alive.length > 1) {
    const prevLog = s.log[s.log.length - 1], nm = {}; for (const k in s.p) nm[k] = s.p[k].char.name;
    const payers = aliveSlots(s.p).map(k => s.who?.[k]).filter(Boolean);   // 살아 있는 참가자 전원이 1/N 씩 (몫 주인을 모르는 옛 방이면 판정 요청자)
    const t = await runRound(env, payers.length ? payers : ip, s.p, s.moves, { round: s.round, prev: prevLog ? factsText(nm, prevLog.events).replace(/\n/g, ' / ') : '' });
    const acts = {}; for (const k in s.moves) { const { local, ...a } = s.moves[k]; acts[k] = a; }
    s.log.push({ round: s.round, acts, judge: t.judge, order: t.order, events: t.events, narration: t.narration, ai: t.usedAi, provider: t.provider, narrateUser: t.narrateUser, resolver: slot });
    if (s.log.length > 40) s.log.shift();
    quotaBlocked = t.quotaBlocked;
  }
  const left = aliveSlots(s.p);
  if (left.length <= 1) {
    s.status = 'finished'; s.winner = left[0] || 0;
    for (const k in s.p) { const c = s.p[k].char; if (s.winner === Number(k)) { c.wins++; c.pvpWins = (c.pvpWins || 0) + 1; } else { c.losses++; c.pvpLosses = (c.pvpLosses || 0) + 1; } await saveChar(env, c); }
  } else s.round++;
  s.moves = {}; s.busy = false;
  await saveRoom(env, code, s, v2);
  return json({ state: pub(s, slot), quota: pubQuota(await quota(env, ip)), quotaBlocked });
}
async function leaveRoom(code, body, env, ip) {
  const r = await loadRoom(env, code);
  if (!r) return json({ ok: true, gone: true });
  const s = r.s, slot = slotOf(s, body.token);
  if (!slot) return json({ error: 'forbidden' }, 403);
  if (s.status === 'waiting' || s.status === 'finished') {
    delete s.p[slot]; delete s.tokens[slot];
    const rest = Object.keys(s.p).map(Number).sort((a, b) => a - b);
    if (!rest.length) { await env.DB.prepare('DELETE FROM rpg_rooms WHERE code = ?').bind(code).run(); return json({ ok: true, gone: true }); }
    if (s.host === slot) s.host = rest[0];   // 방장 승계
    if (!(await saveRoom(env, code, s, r.v))) return json({ error: 'retry' }, 409);
    return json({ ok: true });
  }
  // 진행 중 나가기 = 기권 (패배 기록). 남은 사람들끼리 계속. 나 때문에 막혀 있던 라운드라면 바로 판정
  if (s.p[slot].hp > 0) forfeit(s, slot, 'left');   // 패배 기록은 방이 끝날 때 한 번에 (이중 집계 방지)
  delete s.moves[slot];
  const res = await settleRoom(env, ip, code, s, r.v, slot);
  return res;
}
