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
 *   POST /api/rpg/auth/delete                    { session, confirm: '탈퇴' }  (계정 탈퇴: 계정·계정 캐릭터·기록 전부 삭제)
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
 *   POST /api/rpg/chars/:id/refine               { token, text }              (설정 보강 100자 → 일관성 재심사 → 개연성 갱신. 100승마다 1회)
 *   POST /api/rpg/chars/:id/rebirth              { token }                    (HP·ATK 가 등급 상한이면 환생 → 다음 등급)
 *   POST /api/rpg/chars/:id/auto                 { token, on }                (자동 생사결 참가 on/off — 꺼져 있는 동안 서버가 매시간 참가자끼리 붙임)
 *   GET  /api/rpg/auto?charId=                   → { on, participants, recent: [...] } 부재 중 자동 생사결 결과
 *   POST /api/rpg/rooms                          { charId, token }            → { code, roomToken, state }
 *   POST /api/rpg/match                          { charId, token }            → 랜덤 대전: 기다리는 공개 방이 있으면 들어가 바로 시작, 없으면 공개 방을 만들고 대기
 *   POST /api/rpg/rooms/:code/join               { charId, token }            (같은 캐릭터가 다시 오면 기존 자리로 재접속)
 *   GET  /api/rpg/rooms/:code?token=
 *   POST /api/rpg/rooms/:code/start              { token }                    (방장, 2명 이상)
 *   POST /api/rpg/rooms/:code/action             { token, type, text, target } | { token, skip: true }   (전원 제출 시 판정, 60초 미제출은 건너뛰기, 3연속이면 기권)
 *   POST /api/rpg/rooms/:code/narrate            { token, round, narration }  (위와 같음, 방 전원에게 공유)
 *   POST /api/rpg/rooms/:code/leave              { token }                    (대기 중: 자리 비움·방장 승계 / 진행 중: 기권(판정 중이면 끝날 때까지 잠깐 대기) / 끝난 방: 자리는 남기고 토큰만 정리, 마지막 사람이면 방 삭제)
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

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Device, X-Session, X-Token, X-Admin-Key' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });
const today = () => new Date().toISOString().slice(0, 10);
const clip = (s, n) => String(s ?? '').replace(/[<>]/g, '').trim().slice(0, n);
const num = (v, lo, hi, d = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const rnd = () => Math.random();
const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);   // 'constructor' 같은 상속 키를 값으로 쓰지 않게
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
    if (!env.RPG_ADMIN_KEY || (request.headers.get('X-Admin-Key') || url.searchParams.get('key')) !== env.RPG_ADMIN_KEY) return json({ error: 'forbidden' }, 403);
    const pv = PROVIDERS.find(x => x.id === url.searchParams.get('provider'));
    if (!pv) return json({ error: 'no_provider', ids: PROVIDERS.map(x => x.id) }, 404);
    const t0 = Date.now();
    try { const out = await ask(env, pv, SYS_NARRATE, '[p1] 노정원 (평범한 고등학생) — 설정: 유도를 한다\n행동: 공격 → 대상: 검사 / 선언: "업어치기"\n\n[확정된 결과]\n노정원 → 검사: 공격 명중(70%, 난이도 쉬움) → 피해 87\n남은 HP: 노정원 600/600, 검사 433/520', 0.9); return json({ ok: true, provider: pv.id, ms: Date.now() - t0, parsed: out.parsed, raw: out.raw, usage: out.usage }); }
    catch (e) { return json({ ok: false, provider: pv.id, ms: Date.now() - t0, error: e.message }, 502); }
  }
  if (path === '/api/rpg/leaderboard' && m === 'GET') return leaderboard(env, url.searchParams.get('charId'));
  if (path === '/api/rpg/auth/google' && m === 'POST') return authGoogle(body, env);
  if (path === '/api/rpg/auth/logout' && m === 'POST') { await env.DB.prepare('DELETE FROM rpg_sessions WHERE token = ?').bind(String(body.session || '')).run(); return json({ ok: true }); }
  if (path === '/api/rpg/me' && m === 'GET') return me(env, request.headers.get('X-Session') || url.searchParams.get('session'));
  if (path === '/api/rpg/auth/delete' && m === 'POST') return deleteAccount(body, env);
  if (path === '/api/rpg/prefs' && m === 'GET') return prefsGet(env, request.headers.get('X-Session') || url.searchParams.get('session'));
  if (path === '/api/rpg/prefs' && m === 'POST') return prefsSet(body, env);
  if ((mm = path.match(/^\/api\/rpg\/chars\/([\w-]{36})\/link$/)) && m === 'POST') return linkChar(mm[1], body, env);
  if ((mm = path.match(/^\/api\/rpg\/chars\/([\w-]{36})\/delete$/)) && m === 'POST') return deleteChar(mm[1], body, env);
  if ((mm = path.match(/^\/api\/rpg\/chars\/([\w-]{36})\/auto$/)) && m === 'POST') return setAuto(mm[1], body, env);
  if ((mm = path.match(/^\/api\/rpg\/chars\/([\w-]{36})\/rebirth$/)) && m === 'POST') return rebirthChar(mm[1], body, env);
  if ((mm = path.match(/^\/api\/rpg\/chars\/([\w-]{36})\/refine$/)) && m === 'POST') return refineChar(mm[1], body, env, who);
  if ((mm = path.match(/^\/api\/rpg\/chars\/([\w-]{36})\/buy$/)) && m === 'POST') return buyItem(mm[1], body, env);
  if (path === '/api/rpg/auto' && m === 'GET') return autoInfo(env, url.searchParams.get('charId'));
  if (path === '/api/rpg/prompts' && m === 'GET') return json({ judgeChar: SYS_JUDGE, judgeAction: SYS_JUDGE_ACTION, narrate: SYS_NARRATE });
  if (path === '/api/rpg/chars' && m === 'POST') return createChar(body, env, who);
  const qtok = request.headers.get('X-Token') || url.searchParams.get('token');   // 토큰은 헤더로 (쿼리는 로그에 남으므로 호환용)
  if ((mm = path.match(/^\/api\/rpg\/chars\/([\w-]{36})$/)) && m === 'GET') return getChar(mm[1], qtok, env);
  if ((mm = path.match(/^\/api\/rpg\/chars\/([\w-]{36})\/story(?:\/(prepare|start|act|fight|quit))?$/))) {
    const [, id, sub] = mm;
    if (!sub && m === 'GET') return storyInfo(id, qtok, env);
    if (sub === 'prepare' && m === 'POST') return prepareStory(id, body, env, who);
    if (sub === 'start' && m === 'POST') return startStory(id, body, env);
    if (sub === 'act' && m === 'POST') return storyAct(id, body, env, who);
    if (sub === 'fight' && m === 'POST') return storyFight(id, body, env);
    if (sub === 'quit' && m === 'POST') return storyQuit(id, body, env);
  }
  if (path === '/api/rpg/battles' && m === 'POST') return createBattle(body, env);
  if ((mm = path.match(/^\/api\/rpg\/battles\/([\w-]{36})(?:\/(turn|leave|narrate|reroll))?$/))) {
    const [, id, sub] = mm;
    if (!sub && m === 'GET') return getBattle(id, qtok, env);
    if (sub === 'turn' && m === 'POST') return battleTurn(id, body, env, who);
    if (sub === 'leave' && m === 'POST') return leaveBattle(id, body, env);
    if (sub === 'narrate' && m === 'POST') return narrateBattle(id, body, env);
    if (sub === 'reroll' && m === 'POST') return rerollBattle(id, body, env);
  }
  if (path === '/api/rpg/rooms' && m === 'POST') return createRoom(body, env, false, who, ip);
  if (path === '/api/rpg/match' && m === 'POST') return matchRoom(body, env, who, ip);
  if ((mm = path.match(/^\/api\/rpg\/rooms\/([A-Z0-9]{6})(?:\/(join|action|start|leave|narrate))?$/))) {
    const [, code, sub] = mm;
    if (!sub && m === 'GET') return getRoom(code, qtok, env);
    if (sub === 'join' && m === 'POST') return joinRoom(code, body, env, who, ip);
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
// 분담 결제: 충전 반영한 현재 값에서 share 만큼 빼서 저장 (환불이면 더하고 used 도 되돌림 — bump 의 환불과 같게)
async function chargeShare(env, who, b, amount) {
  await env.DB.prepare('INSERT INTO rpg_ip_bucket (ip, tokens, updated, used) VALUES (?, ?, ?, 1) ON CONFLICT(ip) DO UPDATE SET tokens = ?, updated = ?, used = MAX(0, used + ?)')
    .bind(who, b.tokens - amount, b.now, b.tokens - amount, b.now, amount > 0 ? 1 : -1).run();
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
      const msg = String(e?.message ?? e);   // AbortError·문자열 throw 도 안전하게
      if (split) { await bumpProvider(env, q.day, p.id, -1); await charge(-1); } else { await bump(env, q.day, ip, p.id, -1, q._bucket); q._bucket = { ...q._bucket, tokens: q._bucket.tokens + 1 }; }   // 환불하면 메모리 버킷도 되돌림 (다음 제공자 예약이 2 를 빼지 않게)
      // 지역 불가(Gemini, 송신 지점에 따라 간헐적)는 쿨다운 없이 다음 제공자로 — 다음 호출은 다른 지점에서 나가 성공할 수 있다
      if (!/User location/i.test(msg) && (p.id !== 'cf' || !/quota|limit|429/i.test(msg))) {
        const plan = / 402 |payment_required|limit-req-minute: 0|"code":"1300"/i.test(msg);   // 결제·플랜 문제 → 길게 쉼
        failedAt[p.id] = { at: Date.now(), until: Date.now() + (plan ? PLAN_COOLDOWN : PROVIDER_COOLDOWN), why: msg.slice(0, 120) };
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
  const on = !!body.on;
  await env.DB.prepare('UPDATE rpg_chars SET auto = ? WHERE id = ?').bind(on ? 1 : 0, id).run();   // JSON 은 건드리지 않는다 (같은 순간 끝난 전투의 전적을 덮어쓰지 않게)
  return json({ ok: true, auto: on });
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
  // 상대(AI 조종)도 전적에 반영 — 이기면 cron 자동 전투와 똑같이 보상도 받는다 (부재 중 성장)
  await updateChar(env, st.foeId, f => {
    if (st.winner === 1) { f.losses++; f.autoLosses = (f.autoLosses || 0) + 1; }
    else { f.wins++; f.autoWins = (f.autoWins || 0) + 1; f.pvpWins = (f.pvpWins || 0) + 0.5; applyReward(f, rollReward(f, c, 'auto')); if (dayCount(f, 'cron', 5)) earnDream(f, 3); }
  });
}
// cron: 참가자 최대 30명을 섞어 짝지어 최대 40라운드 자동 전투 (템플릿 서술만, AI 호출 없음)
export async function runAutoBattles(env) {
  const r = await env.DB.prepare('SELECT id, json FROM rpg_chars WHERE auto = 1 ORDER BY RANDOM() LIMIT 30').all();
  const list = [];
  for (const x of (r?.results || [])) { try { const c = JSON.parse(x.json); if (c?.stats?.hp > 0) list.push({ id: x.id, c }); } catch { /* 깨진 JSON 은 건너뜀 */ } }
  let played = 0;
  for (let i = 0; i + 1 < list.length; i += 2) {
    const A = list[i], B = list[i + 1];
    const players = { 1: { char: A.c, hp: A.c.stats.hp, gauge: 0, guard: false }, 2: { char: B.c, hp: B.c.stats.hp, gauge: 0, guard: false } };
    let round = 0;
    while (round < 40 && players[1].hp > 0 && players[2].hp > 0) { round++; resolveRound(players, { 1: { ...enemyDecide(players[1], players[2]), target: 2 }, 2: { ...enemyDecide(players[2], players[1]), target: 1 } }, {}); }
    const winner = players[1].hp > 0 && players[2].hp <= 0 ? A : players[2].hp > 0 && players[1].hp <= 0 ? B : null;
    for (const X of [A, B]) {
      if (!winner) continue;
      // 목록을 읽은 뒤 끝난 온라인 전투·방의 결과를 덮어쓰지 않게, 지금 DB 에 있는 JSON 에 델타만 적용 (보너스 능력치도 온라인 승리와 동일)
      await updateChar(env, X.id, c => {
        if (X === winner) { c.wins++; c.autoWins = (c.autoWins || 0) + 1; c.pvpWins = (c.pvpWins || 0) + 0.5; applyReward(c, rollReward(c, (X === A ? B : A).c, 'auto')); if (dayCount(c, 'cron', 5)) earnDream(c, 3); }
        else { c.losses++; c.autoLosses = (c.autoLosses || 0) + 1; }
      });
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
    const r = await env.DB.prepare('SELECT c.id, c.name, c.score, c.json, u.name AS owner FROM rpg_chars c LEFT JOIN rpg_users u ON u.sub = c.user_sub WHERE c.score > 0 ORDER BY c.score DESC, c.created ASC LIMIT 20').all();
    lbCache = { at: Date.now(), rows: (r?.results || []).map((row, i) => { const c = JSON.parse(row.json); return { rank: i + 1, id: row.id, name: c.name, owner: row.owner || null, score: row.score, tier: c.stats?.tier || null, fiction: c.fiction, wins: c.wins || 0, losses: c.losses || 0, pvpWins: c.pvpWins || 0, stars: c.stars || 0 }; }) };
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
  return u ? { name: u.name, email: u.email } : null;
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
  } catch { return json({ error: 'bad_token' }, 502); }   // 구글 검증 서버에 못 닿음 (AI 오류가 아니므로 bad_token 으로 안내)
  if (!info || typeof info !== 'object') return json({ error: 'bad_token' }, 401);
  if (info.aud !== env.GOOGLE_CLIENT_ID) return json({ error: 'bad_aud' }, 401);
  if (!info.sub || (info.exp && Number(info.exp) * 1000 < Date.now())) return json({ error: 'bad_token' }, 401);
  if (String(info.email_verified) === 'false') return json({ error: 'bad_token' }, 401);   // 거절할 계정은 DB 에 만들지 않는다
  const now = Date.now();
  await env.DB.prepare('INSERT INTO rpg_users (sub, email, name, picture, created, last) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(sub) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture, last = excluded.last')
    .bind(String(info.sub), info.email || null, clip(info.name || info.email || '플레이어', 40), null, now, now).run();   // 프로필 사진은 저장하지 않음
  info.sub = String(info.sub);
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
// 계정 탈퇴: 본인 세션 + 확인 문구('탈퇴')가 있어야. 계정 정보·세션·계정 캐릭터와 그 꿈 이야기·전투·자동 생사결 기록·한도 버킷을 모두 지운다
//   (진행 중인 대전 방의 사본은 방 만료(3시간) 때 함께 사라진다. 손님 캐릭터는 계정과 무관해서 남는다)
async function deleteAccount(body, env) {
  const sub = await sessionUser(env, body.session);
  if (!sub) return json({ error: 'forbidden' }, 403);
  if (body.confirm !== '탈퇴') return json({ error: 'bad_request' }, 400);
  await ensureStoryTable(env); await ensurePrefsTable(env);
  const ids = ((await env.DB.prepare('SELECT id FROM rpg_chars WHERE user_sub = ?').bind(sub).all())?.results || []).map(r => r.id);
  const stmts = [];
  for (const id of ids) stmts.push(
    env.DB.prepare('DELETE FROM rpg_battles WHERE char_id = ?').bind(id),
    env.DB.prepare('DELETE FROM rpg_story WHERE char_id = ?').bind(id),
    env.DB.prepare('DELETE FROM rpg_auto_log WHERE a_id = ? OR b_id = ?').bind(id, id));
  stmts.push(
    env.DB.prepare('DELETE FROM rpg_chars WHERE user_sub = ?').bind(sub),
    env.DB.prepare('DELETE FROM rpg_sessions WHERE sub = ?').bind(sub),
    env.DB.prepare('DELETE FROM rpg_ip_bucket WHERE ip = ?').bind('acct:' + sub),
    env.DB.prepare('DELETE FROM rpg_prefs WHERE sub = ?').bind(sub),
    env.DB.prepare('DELETE FROM rpg_users WHERE sub = ?').bind(sub));
  await env.DB.batch(stmts);
  lbCache.at = 0;
  return json({ ok: true, deletedChars: ids.length });
}
// 계정 설정: 화면 효과·글자 크기·소리를 계정에 저장해 다른 기기에서도 같게 (브라우저에도 따로 저장됨)
let prefsTable = false;
async function ensurePrefsTable(env) { if (prefsTable) return; await env.DB.prepare('CREATE TABLE IF NOT EXISTS rpg_prefs (sub TEXT PRIMARY KEY, json TEXT NOT NULL, updated INTEGER NOT NULL)').run(); prefsTable = true; }
function cleanPrefs(p) {
  const o = {};
  if (['off', 'low', 'high'].includes(p?.fx)) o.fx = p.fx === 'high' ? 'high' : 'off';   // '은은하게'(low)는 없앰 → 끄기
  if (['m', 'l'].includes(p?.size)) o.size = p.size;
  const sd = p?.snd; if (sd && typeof sd === 'object') o.snd = { on: !!sd.on, sfx: Math.round(num(sd.sfx, 0, 100, 70)), amb: Math.round(num(sd.amb, 0, 100, 0)), cueOnly: !!sd.cueOnly };
  return o;
}
async function prefsGet(env, session) {
  const sub = await sessionUser(env, session); if (!sub) return json({ error: 'forbidden' }, 403);
  await ensurePrefsTable(env);
  const row = await env.DB.prepare('SELECT json FROM rpg_prefs WHERE sub = ?').bind(sub).first();
  return json({ prefs: row ? JSON.parse(row.json) : null });
}
async function prefsSet(body, env) {
  const sub = await sessionUser(env, body.session); if (!sub) return json({ error: 'forbidden' }, 403);
  await ensurePrefsTable(env);
  const pr = cleanPrefs(body.prefs);
  await env.DB.prepare('INSERT INTO rpg_prefs (sub, json, updated) VALUES (?, ?, ?) ON CONFLICT(sub) DO UPDATE SET json = excluded.json, updated = excluded.updated').bind(sub, JSON.stringify(pr), Date.now()).run();
  return json({ ok: true, prefs: pr });
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
      const text = String(data.choices?.[0]?.message?.content ?? '');
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
      const parsed = lenientJson(String(text ?? '').replace(/<think>[\s\S]*?<\/think>/g, ''));
      return { parsed, usage: res?.usage, model, raw: String(text ?? '').slice(0, 400) };
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
5) power 0~95: 설정이 근거하는 위력 등급. 매우 엄격하게: 낮게 주기는 쉽고 높게 주기는 어렵습니다. 애매하면 항상 낮은 쪽을 고르세요.
   0~30 평범한 존재(학생·직장인·동물·일반인, 기본값 15) / 31~50 훈련된 전문가·격투가·무기 숙련자·평범한 마법 견습 / 51~70 초인(명확한 초능력·마법·만화 주인공급, 능력이 구체적이고 한계가 적혀 있을 때만)
   71~85 전설(도시 하나를 뒤흔들 급, 신화의 영웅. 능력·대가·약점이 모두 구체적일 때만) / 86~95 신급·개념적 존재(설정이 길고 구체적이며 명확한 제약·대가가 있을 때만. 극히 드묾). 96 이상은 절대 주지 마세요
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
'상태'에 부상이 있으면 다친 부위를 무리하게 쓰는 선언은 난이도를 한 단계 높게 매기고 verdict 에 그 이유를 적습니다.
반드시 플레이어 수만큼 키를 넣은 이 JSON 하나만 출력:
{"p1":{"allowed":true,"difficulty":"normal","fit":0.5,"verdict":"..."},"p2":{...}}`;

const SYS_NARRATE = `당신은 텍스트 RPG 게임 마스터입니다. 전투 1라운드의 결과가 이미 계산되어 주어집니다. 결과를 바꾸지 말고 서술만 하세요.
주어진 사실(행동 순서, 심사관 판정, 누가 누구를 노렸는지, 명중/빗나감/크리티컬/방어/피해, 쓰러진 사람)을 정확히 반영해 4~7문장으로 생생하게. 현재 라운드 번호와 직전 라운드 요약이 주어지면 그 흐름을 이어서 서술하세요(2라운드 이후엔 전투 시작 장면을 다시 쓰지 말 것). 플레이어가 말로 선언한 행동을 그대로 살려서 묘사하고, 캐릭터 설정을 근거로 왜 그렇게 됐는지 언급. 줄바꿈은 <br>. 새로운 수치를 만들지 마세요. 성적 묘사·혐오 표현·실존 인물 비방은 쓰지 않습니다(전투 묘사는 만화 수준으로).
캐릭터에 '상태'(부상·피로·기세·흉터)나 '플레이어와의 관계'(요즘 자주 만난 상대·숙적·공포)가 주어지면 서술에 자연스럽게 한 번쯤 녹이세요(예: 다친 왼팔이 욱신거려 주먹이 무뎌진다, "또 너냐, 요즘 자주 보는군"). 수치는 말하지 마세요.
반드시 이 JSON 하나만 출력: {"narration":"..."}`;

// ─── 규칙 엔진 ───────────────────────────────────────────────────────
// 동일 예산: 모든 캐릭터는 alloc(합 100)을 같은 공식으로 스탯화한다. 설정이 아무리 세도 예산은 같다.
const ULT_STYLES = { burst: { mult: 2.4 }, precise: { mult: 1.6, accBonus: 25 }, drain: { mult: 1.5, heal: 0.5 }, shield: { mult: 1.4, guard: true } };
// 위력 등급 → 예산 배율. 비대칭: 30 이하는 완만하게 깎이고(0.6~1.0), 30 위는 제곱 곡선이라 높은 점수일수록 배율이 급히 커진다(최대 3.0).
//   코드에서도 상한을 건다: 일관성이 낮으면(막연한 전능) 위력을 45 로 자르고, 클라이언트 로컬 AI 심사면 50 으로 자른다 → AI 가 후해도 서버가 막음
function powerMult(power) { return power <= 30 ? 0.6 + power / 30 * 0.4 : power <= 97 ? 1 + Math.pow((power - 30) / 70, 2) * 2 : 3 + (power - 98) * 0.25; }   // ??? (98~100) 는 3.0~3.5
const POWER_TIER = p => p <= 30 ? '평범' : p <= 50 ? '숙련' : p <= 70 ? '초인' : p <= 85 ? '전설' : p <= 97 ? '신화' : '???';
// 등급 주사위: 심사관이 매긴 위력 P 를 중심으로 등급을 확률적으로 뽑는다.
//   세게 묘사할수록(P 높음) 높은 등급이 나올 확률이 커지고, 약하게 묘사하면 낮은 등급이 대부분.
//   위쪽 등급 가중치는 ×0.35, 아래쪽은 ×1.5 → 올라가기가 내려가기보다 어렵다. 결과와 확률표를 모두 돌려줘 플레이어에게 보여 준다
const TIERS = [['평범', 0, 30], ['숙련', 31, 50], ['초인', 51, 70], ['전설', 71, 85], ['신화', 86, 97], ['???', 98, 100]];
// 등급 주사위 가중치: 위로 올라가기 ×0.2, 아래로 내려가기 ×1.8 (2026-10 하향: 첫 심사가 후하다는 피드백). ??? 는 거기에 ×0.03 더 — 생성 때 1% 미만
const TIER_UP = 0.2, TIER_DOWN = 1.8, SECRET_W = 0.03;
// 생성 전용 희귀 배율: 초인·전설·신화는 심사 위력이 아주 높을 때만 아주 낮은 확률로, ??? 는 생성 불가(환생으로만)
//   AI 심사 95 → 초인 20% · 전설 3% · 신화 0.06% / 심사 50 → 초인 0.1% / 가정 분포 전체 → 초인 0.11% · 전설 0.003% · 신화 <0.001%
const CREATE_RARITY = { '초인': 0.02, '전설': 0.003, '신화': 0.0005, '???': 0 };
function rollTier(P, rar = null) {
  const w = TIERS.map(([n, lo, hi]) => { const c = (lo + hi) / 2, base = Math.exp(-0.5 * Math.pow((c - P) / 14, 2)); return base * (lo > P ? TIER_UP : hi < P ? TIER_DOWN : 1) * (n === '???' ? SECRET_W : 1) * (rar?.[n] ?? 1); });
  const sum = w.reduce((a, b) => a + b, 0), probs = w.map(x => x / sum);
  let r = rnd(), idx = probs.length - 1;
  for (let i = 0; i < probs.length; i++) { r -= probs[i]; if (r <= 0) { idx = i; break; } }
  const [name, lo, hi] = TIERS[idx];
  let power;
  if (P >= lo && P <= hi) power = P + Math.round((rnd() - 0.5) * 8);                         // 같은 등급: 소폭 흔들림
  else if (lo > P) power = lo + Math.round(rnd() * (hi - lo) * 0.5);                          // 올라감: 그 등급의 아래쪽 절반
  else power = hi - Math.round(rnd() * (hi - lo) * 0.5);                                      // 내려감: 그 등급의 위쪽 절반
  power = Math.max(lo, Math.min(hi, power));
  return { judged: P, power, tier: name, table: TIERS.map(([n], i) => ({ tier: n, p: probs[i] >= 0.01 ? Math.round(probs[i] * 100) : Math.round(probs[i] * 10000) / 100 })), moved: lo > P ? 'up' : hi < P ? 'down' : 'same' };
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
    stability: Math.round((0.55 + c / 100 * 0.45) * 100) / 100,      // 일관성 → 개연성 0.55 ~ 1.0 (명중률 계수, 화면 표기 '개연성')
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
    const fit = num(j.fit, 0, 1, 0.5), diff = own(DIFF_MOD, j.difficulty) ? DIFF_MOD[j.difficulty] : 0, allowed = j.allowed !== false;
    if (act.type === 'defend') { me.gauge = Math.min(ULT_COST, me.gauge + 2); events.push({ who: k, type: 'defend' }); continue; }
    if (act.type === 'item') { events.push({ who: k, type: 'item', heal: act.heal || 0, item: act.item || '꿈결 붕대' }); continue; }   // 회복은 호출 전에 적용됨
    const others = aliveSlots(players).filter(x => x !== k);
    if (!others.length) break;
    const tk = others.includes(Number(act.target)) ? Number(act.target) : others[Math.floor(rnd() * others.length)];
    const foe = players[tk];
    const isUlt = act.type === 'ult' && me.gauge >= ULT_COST;
    if (act.type === 'ult' && !isUlt) events.push({ who: k, type: 'ult_fail' });
    const s = me.char.stats, t = foe.char.stats, style = own(ULT_STYLES, me.char.ult?.style) ? ULT_STYLES[me.char.ult.style] : ULT_STYLES.burst;
    const acc = s.acc + (isUlt && style.accBonus ? style.accBonus : 0);
    const dmod = diff <= -1 ? -1 : (!allowed ? DIFF_MOD.hard : diff);   // 불가능 → 자동 실패, 불허 → 기본 공격 + 어려움
    const chance = dmod <= -1 ? 0 : Math.min(0.95, Math.max(0.05, (acc - t.eva) / 100 * s.stability + dmod));
    const hit = rnd() < chance, crit = hit && rnd() < 0.1;
    let dmg = 0;
    if (hit) {
      dmg = s.atk * (isUlt ? style.mult : 1) * (0.9 + rnd() * 0.2) * (crit ? 1.5 : 1) * (0.85 + fit * 0.3);
      dmg *= 1 - t.def / 100; if (foe.guard) dmg *= 0.5;
      dmg = Number.isFinite(dmg) ? Math.max(1, Math.round(dmg)) : 1;   // 어떤 값이 깨져도 HP 가 NaN·null 이 되지 않게
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
    if (e.type === 'item') return `${n}: ${e.item} 사용 → HP ${e.heal} 회복`;
    const k = e.type === 'ult' ? '필살기' : '공격', d = DIFF_KO[e.difficulty] || '보통';
    return e.hit ? `${n} → ${names[e.target]}: ${k} 명중(${e.chance}%, 난이도 ${d})${e.crit ? ' 크리티컬!' : ''}${e.guarded ? ' (상대 방어로 절반)' : ''} → 피해 ${e.dmg}${e.killed ? ' — ' + names[e.target] + ' 쓰러짐' : ''}` : `${n} → ${names[e.target]}: ${k} 실패(명중률 ${e.chance}%, 난이도 ${d})`;
  }).join('\n');
}
function templateNarration(names, events, note = '(게임 마스터의 목소리가 닿지 않아 사실만 기록합니다)') {
  return factsText(names, events).replace(/\n/g, '<br>') + (note ? '<br>' + note : '');
}

// 한 라운드 = 심사관(AI, 짧음) → 규칙 엔진 → 게임 마스터 서술(AI). 어느 AI 호출이든 실패/한도면 그 단계만 기본값으로 진행.
const actLabel = t => t === 'defend' ? '방어' : t === 'ult' ? '필살기' : '공격';
function charLine(k, p, act, names) {
  const tgt = act.target && names[act.target] ? ` → 대상: ${names[act.target]}` : '';
  return `[p${k}] ${p.char.name} (${p.char.fiction}) — 설정: ${p.char.info}${p.char.relic ? ` / 소지품: ${p.char.relic} (평범한 물건, 능력을 주지 않음)` : ''} / 필살기 ${p.char.ult?.name || '혼신의 일격'}: ${p.char.ult?.effect || '온 힘을 담은 한 방'}${p.char.state ? `\n상태: ${p.char.state}` : ''}${p.char.memo ? `\n플레이어와의 관계: ${p.char.memo}` : ''}
행동: ${actLabel(act.type)}${tgt} / 선언: "${act.text || '기본 공격'}"`;
}
// ctx: { round, prev } — 라운드 번호와 직전 라운드 요약을 GM 에게 넘겨 "첫 라운드"라고 반복하지 않게 한다
const safeAi = (...a) => aiCall(...a).catch(() => ({ ok: false, reason: 'failed' }));   // 한도 조회 등이 던져도 라운드는 진행 (규칙 엔진이 이미 HP 를 바꾼 뒤일 수 있다)
async function runRound(env, ip, players, acts, ctx = {}) {
  const names = {}; for (const k in players) if (players[k]) names[k] = players[k].char.name;
  const slots = aliveSlots(players);
  const judge = {}; for (const k of slots) judge[k] = acts[k]?.policy
    ? { allowed: false, difficulty: 'hard', fit: 0.3, verdict: `선언이 이용 정책(${acts[k].policy})에 어긋나 심사하지 않습니다. 기본 공격으로 처리합니다.`, policy: true }
    : { allowed: true, difficulty: 'normal', fit: 0.5, verdict: '' };
  let usedAi = false, quotaBlocked = null, provider = null;
  const clampJudge = p => ({ allowed: p.allowed !== false, difficulty: own(DIFF_MOD, p.difficulty) ? p.difficulty : 'normal', fit: num(p.fit, 0, 1, 0.5), verdict: cleanVerdict(p.verdict) });
  const needJudge = slots.some(k => acts[k]?.text);
  if (needJudge) {
    const user = slots.map(k => charLine(k, players[k], acts[k] || { type: 'attack' }, names)).join('\n\n');
    const r = await safeAi(env, ip, SYS_JUDGE_ACTION, user, 0.2);
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
  if (ctx.noNarrate) return { events: res.events, order: res.order, judge, narration: templateNarration(names, res.events, ''), usedAi: 'skip', provider, quotaBlocked };
  const r2 = await safeAi(env, ip, SYS_NARRATE, narrateUser, 0.9);
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
  const row = await env.DB.prepare('SELECT state, updated FROM rpg_battles WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'no_battle' }, 404);
  const st = JSON.parse(row.state);
  if (!(await loadChar(env, st.charId, body.token))) return json({ error: 'forbidden' }, 403);
  if (isBusy(st)) return json({ ok: false });   // 턴 판정 중이면 그 결과를 덮어쓰지 않는다
  let ok = await fillNarration(st.log.find(l => l.turn === Number(body.turn)), body.narration, env);
  // 낙관적 잠금: 그 사이 턴이 진행됐으면(updated 변경) 옛 상태로 덮어쓰지 않고 포기
  if (ok) ok = (await env.DB.prepare('UPDATE rpg_battles SET state = ? WHERE id = ? AND updated = ?').bind(JSON.stringify(st), id, row.updated).run()).meta.changes === 1;
  return json({ ok });
}
async function narrateRoom(code, body, env) {
  for (let i = 0; i < 4; i++) {
    const r = await loadRoom(env, code);
    if (!r) return json({ error: 'no_room' }, 404);
    const mySlot = slotOf(r.s, body.token);
    if (!mySlot) return json({ error: 'forbidden' }, 403);
    if (isBusy(r.s)) { await sleep(700); continue; }   // 라운드 판정 중 — 끝난 뒤에 채운다 (판정자의 최종 저장과 충돌 방지)
    const entry = r.s.log.find(l => l.round === Number(body.round));
    if (entry && entry.resolver && mySlot !== entry.resolver && mySlot !== r.s.host) return json({ error: 'forbidden' }, 403);   // 판정 요청자나 방장만 서술을 채울 수 있다
    const ok = await fillNarration(entry, body.narration, env);
    if (!ok) return json({ ok: false });
    if (await saveRoom(env, code, r.s, r.v)) return json({ ok: true });
  }
  return json({ error: 'retry' }, 409);
}

// ─── 캐릭터 ─────────────────────────────────────────────────────────
function publicChar(c) { return { ...c, caps: capsOf(c), rebirthReady: rebirthReady(c), condView: condView(c) }; }
async function loadChar(env, id, token) {
  if (typeof id !== 'string' || !id || typeof token !== 'string' || !token) return null;   // undefined 를 bind 하면 D1 이 던진다(500) → 그냥 인증 실패
  const row = await env.DB.prepare('SELECT token, json FROM rpg_chars WHERE id = ?').bind(id).first();
  if (!row || row.token !== token) return null;
  return JSON.parse(row.json);
}
// 전적·보상 반영: 방·전투·cron 이 들고 있던 스냅샷이 아니라 지금 DB 에 있는 최신 JSON 에 적용해 저장한다
//   (스냅샷으로 덮어쓰면 그 사이 다른 곳(PvE·cron·다른 방)에서 얻은 승수·보상이 지워진다). 캐릭터가 삭제됐으면 fallback 에만 적용(저장 안 됨)
//   낙관적 잠금: 읽을 때의 updated 와 같을 때만 저장하고, 그 사이 다른 요청이 저장했으면 새로 읽어 fn 을 다시 적용 (fn 은 다시 불려도 되게 작성)
async function updateChar(env, id, fn, fallback = null) {
  for (let i = 0; i < 8; i++) {
    let row = null;
    try { row = await env.DB.prepare('SELECT json, updated FROM rpg_chars WHERE id = ?').bind(String(id)).first(); } catch {}
    if (!row) { if (fallback) fn(fallback); return fallback; }
    const c = JSON.parse(row.json); fn(c);
    if (await saveChar(env, c, row.updated ?? 0)) return c;
    await new Promise(r => setTimeout(r, 10 + Math.random() * 40 * (i + 1)));
  }
  throw new Error('busy');
}
// 승리 보상 적용 (PvE · 자동 생사결 온라인/cron 공통)
// 개연성(stability): 선언으로 쌓인다 — 적합도 ≥ 0.8 이고 쉬움/보통 판정이면 +0.3%p, 불허·불가면 −0.5%p. 등급별 상한, 하한은 0.55 + 환생 횟수 × 0.03
const PLAUS_CAP = { '평범': 0.85, '숙련': 0.90, '초인': 0.95, '전설': 0.98, '신화': 1.0, '???': 1.0 };
const plausFloor = c => 0.55 + (c.rebirths || 0) * 0.03;
const plausCap = c => PLAUS_CAP[c.stats?.tier] ?? 1.0;
// 상한은 '성장'에만 적용: 생성 때 이미 상한보다 높았던 값은 깎지 않는다 (상한 = max(등급 상한, 현재값))
const clampPlaus = (c, v) => { const cur = c.stats?.stability ?? 0.75; return Math.round(Math.min(Math.max(plausCap(c), cur), Math.max(plausFloor(c), v)) * 1000) / 1000; };
function plausDelta(act, j) {
  if (!act?.text || !j) return 0;
  if (j.policy || j.allowed === false || j.difficulty === 'impossible') return -0.005;
  if ((j.fit ?? 0) >= 0.8 && (j.difficulty === 'easy' || j.difficulty === 'normal')) return 0.003;
  return 0;
}
// 한 라운드 뒤: 선언한 플레이어 캐릭터의 개연성을 갱신 (방 상태 안의 사본과 DB 둘 다). 돌려주는 값 = { slot: delta }
async function applyPlaus(env, players, acts, judge, slots) {
  const out = {};
  for (const k of slots) {
    const d = plausDelta(acts[k], judge[k]); if (!d) continue;
    const c = players[k]?.char; if (!c || String(c.id).startsWith('enemy-')) continue;
    const nv = clampPlaus(c, (c.stats.stability ?? 0.75) + d);
    if (nv === c.stats.stability) continue;
    c.stats.stability = nv; out[k] = d;
    await updateChar(env, c.id, x => { x.stats.stability = clampPlaus(x, (x.stats.stability ?? 0.75) + d); });
  }
  return out;
}
// 설정 보강: 기존 설정 뒤에 100자를 덧붙이고 심사관이 일관성만 다시 매긴다(위력 등급은 그대로). 100승마다 1회(첫 번째는 무료)
const REFINE_EVERY = 100;
const SYS_COHERENCE = `당신은 텍스트 RPG 캐릭터 심사관입니다. 캐릭터 설정의 내적 일관성만 평가합니다. 앞뒤가 맞고 능력의 한계·약점·대가가 구체적이면 높음(80~100), 짧거나 막연하면 중간(40~60), "무엇이든 다 한다"·모순·근거 없는 전능은 낮음(5~25). 덧붙인 문장이 기존 설정과 모순되면 낮춥니다. 반드시 이 JSON 하나만 출력: {"coherence":0,"reason":"한 문장"}`;
async function refineChar(id, body, env, ip) {
  const c = await loadChar(env, id, body.token);
  if (!c) return json({ error: 'forbidden' }, 403);
  const text = clip(body.text, 100);
  if (!text) return json({ error: 'bad_request' }, 400);
  const used = c.refineCount || 0;
  const useKey = (c.wins || 0) < used * REFINE_EVERY && !!body.useKey && (c.bag?.key || 0) > 0 && c.keyDay !== today();   // 설정 보강 열쇠: 100승 대기를 바로 풂 (하루 1회)
  if ((c.wins || 0) < used * REFINE_EVERY && !useKey) return json({ error: 'refine_cooldown', needWins: used * REFINE_EVERY }, 409);
  const mod = await moderate(env, text);
  if (!mod.ok) return json({ error: 'policy', reason: mod.reason, label: mod.label }, 400);
  const info = clip(c.info + ' ' + text, 400);
  const r = await aiCall(env, ip, SYS_COHERENCE, `이름: ${c.name}\n설정: ${info}`, 0.2);
  if (!r.ok) return json({ error: r.reason === 'failed' ? 'ai_failed' : 'quota', reason: r.reason }, r.reason === 'failed' ? 502 : 429);
  const coh = Math.round(num(r.parsed?.coherence, 0, 100, c.stats.coherence)), reason = cleanVerdict(r.parsed?.reason).slice(0, 200);
  const before = c.stats.stability;
  // 설정 재심사는 생성 때처럼 등급 상한 없이(하한만)
  const out = await updateChar(env, c.id, x => { x.info = info; x.stats.coherence = coh; x.stats.stability = Math.round(Math.min(1, Math.max(plausFloor(x), 0.55 + coh / 100 * 0.45)) * 1000) / 1000; x.refineCount = (x.refineCount || 0) + 1; if (useKey) { x.bag.key = Math.max(0, (x.bag?.key || 0) - 1); x.keyDay = today(); } x.refineLog = [...(x.refineLog || []), { text, coherence: coh, reason, at: Date.now() }].slice(-10); });
  return json({ ok: true, char: publicChar(out), coherence: coh, reason, before, after: out.stats.stability, quota: pubQuota(await quota(env, ip)) });
}

// 등급별 성장 상한. HP·ATK 가 둘 다 상한에 닿으면 '환생' 가능 → 다음 등급의 기본 능력치로 다시 시작(환생 횟수만큼 +10% 영구 보너스)
const TIER_CAPS = {
  '평범': { hp: 1500, atk: 200, def: 20, spd: 60, acc: 85, eva: 20 },
  '숙련': { hp: 2200, atk: 300, def: 30, spd: 75, acc: 90, eva: 28 },
  '초인': { hp: 3000, atk: 420, def: 40, spd: 90, acc: 94, eva: 35 },
  '전설': { hp: 4200, atk: 580, def: 50, spd: 105, acc: 97, eva: 42 },
  '신화': { hp: 6000, atk: 800, def: 60, spd: 120, acc: 99, eva: 50 },
  '???': { hp: 8000, atk: 1000, def: 65, spd: 130, acc: 99, eva: 55 },
};
const capsOf = c => TIER_CAPS[c.stats?.tier] || TIER_CAPS['신화'];
const rebirthReady = c => { const cap = capsOf(c); return c.stats.hp >= cap.hp && c.stats.atk >= cap.atk; };
function applyReward(c, rw) {
  const cap = capsOf(c);
  // 상한은 '성장'에만 적용 (개연성 clampPlaus 와 같은 규칙): 생성·환생 때 이미 상한보다 높던 값은 승리해도 깎지 않는다 (예전엔 평범 속도 80 → 이기면 60 으로 떨어짐)
  const grow = (k, add) => { const cur = c.stats[k] || 0; c.stats[k] = Math.min(Math.max(cap[k], cur), cur + add); };
  grow('hp', rw.hp); grow('atk', rw.atk);
  for (const k in (rw.stats || {})) grow(k, rw.stats[k]);
  if (rw.bonus) c.stats[rw.bonus.stat] = Math.min(cap[rw.bonus.stat] || rw.bonus.max, (c.stats[rw.bonus.stat] || 0) + rw.bonus.amount);   // 옛 형식 호환
  c.rebirthReady = rebirthReady(c);
}
// 환생: HP·ATK 상한 도달 시. 다음 등급 하한 위력으로 기본 능력치를 다시 뽑고(성향 배분은 유지, 흔들림 없음) 환생 횟수당 +10%. ??? 는 최상위라 불가, 신화 → ??? 는 1000승 이상
const SECRET_WINS = 1000;   // 300 이면 신화 상한(약 286승)과 같은 시점이라 약 12시간에 전원 도달 → 1000 (약 35시간 추정)
async function rebirthChar(id, body, env) {
  const c = await loadChar(env, id, body.token);
  if (!c) return json({ error: 'forbidden' }, 403);
  if (!rebirthReady(c)) return json({ error: 'not_ready', caps: capsOf(c) }, 409);
  const idx = TIERS.findIndex(t => t[0] === c.stats.tier);
  if (idx < 0 || idx >= TIERS.length - 1) return json({ error: 'max_tier' }, 409);
  const [name, lo] = TIERS[idx + 1];
  if (name === '???' && (c.wins || 0) < SECRET_WINS) return json({ error: 'need_wins', needWins: SECRET_WINS }, 409);   // ??? 는 신화를 끝까지 키운 캐릭터만
  const alloc = c.alloc || allocFromStats(c);                        // 옛 캐릭터는 현재 능력치 비율에서 성향을 역산
  const n = (c.rebirths || 0) + 1, bonus = 1 + n * 0.1;
  const fresh = buildStats(alloc, c.stats.coherence, 1, name === '???' ? lo : lo + 2);
  const prevCap = capsOf(c);
  for (const k of ['hp', 'atk']) fresh[k] = Math.max(Math.round(fresh[k] * bonus), Math.round(prevCap[k] * 0.85));   // 환생 직후 하한 = 직전 등급 상한의 85% (시뮬레이션: 65% 면 직전 등급 상한 캐릭터에게 PvP 4~7% 승, 85% 면 32~48%)
  fresh.stability = Math.round(Math.min(PLAUS_CAP[name], Math.max(0.55 + n * 0.03, Math.max(fresh.stability, c.stats.stability || 0))) * 1000) / 1000;   // 개연성은 유지하되 환생 횟수만큼 하한 상승
  for (const k of ['def', 'spd', 'acc', 'eva']) fresh[k] = Math.min(TIER_CAPS[name][k], Math.round(fresh[k] * bonus));
  const prevTier = c.stats.tier;
  await updateChar(env, c.id, x => { earnDream(x, 50); x.stats = fresh; x.alloc = alloc; x.rebirths = n; x.rebirthReady = false; x.rebirthLog = [...(x.rebirthLog || []), { from: prevTier, to: name, at: Date.now() }].slice(-10); });
  const out = await loadChar(env, id, body.token);
  return json({ ok: true, char: publicChar(out), from: prevTier, to: name, bonus: Math.round((bonus - 1) * 100) });
}
function allocFromStats(c) {
  const s = c.stats, m = s.mult || 1;
  const a = { atk: Math.max(0, (s.atk / m - 40) / 1.6), hp: Math.max(0, (s.hp / m - 400) / 8), def: Math.max(0, s.def / 0.4), spd: Math.max(0, s.spd), acc: Math.max(0, (s.acc - 60) / 0.35), eva: Math.max(0, s.eva / 0.3) };
  const sum = Object.values(a).reduce((x, y) => x + y, 0) || 1;
  for (const k in a) a[k] = a[k] / sum * 100;
  return a;
}
// 판정·턴 진행 중 표시: busy 는 시작 시각. 워커가 도중에 죽어 표시가 남았으면 BUSY_STALE_MS 뒤엔 무시한다 (옛 형식 true 도 무시)
const BUSY_STALE_MS = 90e3, sleep = ms => new Promise(r => setTimeout(r, ms));
const isBusy = s => typeof s.busy === 'number' && Date.now() - s.busy < BUSY_STALE_MS;
// 승점 = PvE 승 1점 + PvP 승 3점 (순위표). 컬럼에 같이 써서 정렬 쿼리가 JSON 을 열지 않게 한다
const scoreOf = c => Math.max(0, Math.round((c.wins || 0) + (c.pvpWins || 0) * 2 - (c.pvpCapped || 0) * 3));   // pvpCapped: 하루 상한을 넘긴 온라인 승리(전적엔 남고 승점엔 안 들어감)   // 자동 생사결 승 = pvpWins 0.5 → 총 2점
async function saveChar(env, c, prev) {
  const ver = Math.max(Date.now(), (prev || 0) + 1);   // 같은 밀리초에 두 번 저장돼도 버전이 겹치지 않게
  const r = await env.DB.prepare('UPDATE rpg_chars SET json = ?, score = ?, name = ?, updated = ? WHERE id = ? AND COALESCE(updated, 0) = ?').bind(JSON.stringify(c), scoreOf(c), c.name, ver, c.id, prev || 0).run();
  lbCache.at = 0; return r.meta.changes === 1;
}   // 승점이 바뀌었을 수 있으니 순위표 캐시 비움

// 일관성이 낮으면(막연한 전능·모순) 위력 상한: 50 미만 → 평범까지(30), 70 미만 → 숙련까지(50)
// 2026-10 밸런스: '낮은 등급에서 시작해 환생으로 키워 가기' — 생성은 거의 평범·숙련(약 66% · 34%), 초인 이상은 CREATE_RARITY 로 아주 드물게
const JUDGE_SCALE = 0.8, cohCap = coh => coh < 50 ? 30 : coh < 70 ? 50 : 100;
// 클라이언트가 보낸 '로컬 심사' 는 조작될 수 있으므로: 6개 성향 숫자·문자열 길이만 받고, 일관성 70·필살기 종류는 목록 안, 글은 검열
async function cleanLocalJudge(env, l) {
  const alloc = {}; for (const k of ['atk', 'hp', 'def', 'spd', 'acc', 'eva']) alloc[k] = num(l.alloc?.[k], 0, 100, 16.6);
  const u = l.ult && typeof l.ult === 'object' ? l.ult : {};
  const out = { concept: clip(l.concept, LEN.fiction), alloc, coherence: num(l.coherence, 0, 70, 40), power: num(l.power, 0, 95, 15), powerReason: clip(l.powerReason, 120),
    ult: { name: clip(u.name, LEN.ultName), effect: clip(u.effect, LEN.ultEffect), style: own(ULT_STYLES, u.style) ? u.style : 'burst' } };
  if (!(await moderate(env, [out.concept, out.ult.name, out.ult.effect, out.powerReason].join('\n'))).ok) return null;   // 위반이면 기본 심사로
  return out;
}
async function createChar(body, env, ip) {
  const name = clip(body.name, LEN.name), setting = clip(body.setting, LEN.setting);
  if (!name || !setting) return json({ error: 'bad_request' }, 400);
  if (Math.random() < 0.05) await env.DB.prepare('DELETE FROM rpg_chars WHERE user_sub IS NULL AND score = 0 AND COALESCE(updated, created) < ?').bind(Date.now() - 90 * 86400e3).run();   // 손님·무승·90일 미사용 캐릭터 정리
  const mod = await moderate(env, name + '\n' + setting);
  if (!mod.ok) return json({ error: 'policy', reason: mod.reason, label: mod.label }, 400);
  const r = await aiCall(env, ip, SYS_JUDGE, `이름: ${name}\n설정: ${setting}`, 0.2);
  let parsed, judgedBy = r.provider;
  if (r.ok) parsed = r.parsed;
  else if (body.local && typeof body.local === 'object') { parsed = await cleanLocalJudge(env, body.local); judgedBy = 'local'; }   // 서버 AI 소진 → 클라이언트 크롬 내장 AI 의 심사 결과 (정해진 모양만 받고, 일관성 상한 70·위력 상한 50)
  else if (r.reason === 'failed') return json({ error: 'ai_failed', quota: pubQuota(await quota(env, ip)) }, 502);
  else return json({ error: 'quota', reason: r.reason, quota: pubQuota(await quota(env, ip)) }, 429);
  // 심사관이 형식을 어기거나 거절해도 플레이어를 막지 않는다: 균등 배분 + 낮은 일관성(불명확한 설정)으로 진행
  if (!parsed || !parsed.alloc) parsed = { concept: parsed?.concept, alloc: null, coherence: 30, ult: parsed?.ult, fallback: true };
  const ult = parsed.ult || {};
  const luck = rollTier(Math.round(num(parsed.power, 0, 95, 15) * JUDGE_SCALE), CREATE_RARITY);   // AI 심사관이 후한 편이라 서버가 0.8배로 깎는다
  const c = {
    id: uid(), name, info: setting, fiction: clip(parsed.concept, LEN.fiction) || (parsed.fallback ? '정체불명의 몽상가' : '이름 없는 몽상가'), judged: parsed.fallback ? false : judgedBy,
    stats: buildStats(parsed.alloc, parsed.coherence, 1, Math.min(luck.power, cohCap(num(parsed.coherence, 0, 100, 50)), judgedBy === 'local' ? 50 : 100), true),
    powerReason: clip(parsed.powerReason, 120), luck, alloc: parsed.alloc || null, rebirths: 0,
    ult: { name: clip(ult.name, LEN.ultName) || '혼신의 일격', effect: clip(ult.effect, LEN.ultEffect) || '온 힘을 담은 한 방', style: own(ULT_STYLES, ult.style) ? ult.style : 'burst' },
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

// ─── 꿈 조각(재화) · 꿈 시장(상점) ─────────────────────────────────────
// 영구 능력치는 팔지 않는다(등급 상한·PvP 공정성). 전부 '그 전투에서만' 효과 + 꾸미기 + 도전. 온라인 대전에는 가방을 못 가져간다
const DREAM_MAX = 9999, STACK = 5, BAG_SLOTS = 3, BAG_ITEMS = ['tea', 'sight', 'guard', 'bandage', 'smoke'];
const ITEMS = {
  tea: { name: '깨어남의 차', price: 125, kind: 'bag', desc: '필살기 게이지 1칸 찬 채로 전투 시작' },
  sight: { name: '또렷한 시선', price: 175, kind: 'bag', desc: '이번 전투 명중 +8 (등급 상한까지)' },
  guard: { name: '단단한 꿈', price: 175, kind: 'bag', desc: '이번 전투 방어 +8%p (등급 상한까지)' },
  bandage: { name: '꿈결 붕대', price: 200, kind: 'bag', desc: '한 턴 행동 대신 최대 HP 25% 회복 (전투당 1회)' },
  smoke: { name: '연막 구름', price: 125, kind: 'bag', desc: '도망 성공 확률 +25%p, 붙잡혀도 손실 절반' },
  map: { name: '꿈길 지도', price: 100, kind: 'use', desc: 'AI 전투 첫 턴 전에 상대를 한 번 다시 뽑기' },
  nightmare: { name: '악몽 초대장', price: 200, kind: 'use', desc: '다음 AI 전투 상대가 훨씬 강해지고, 이기면 꿈 조각 2.5배. 져도 캐릭터는 남음' },
  insurance: { name: '깨지 않는 꿈', price: 300, kind: 'use', max: 1, desc: 'AI 전투에서 지면 자동으로 쓰여 캐릭터가 사라지지 않음 (HP·ATK 최대치 −5%)' },
  key: { name: '설정 보강 열쇠', price: 1500, kind: 'use', desc: '설정 보강의 100승 대기를 바로 풂 (하루 1회)' },
  relic: { name: '꿈의 유물', price: 600, kind: 'relic', desc: '12자 이내의 물건 하나를 지님. 능력은 없지만 심사관이 설정의 일부로 봄 (바꾸기 300)' },
  star: { name: '별 표식', price: [1500, 3000, 6000], kind: 'star', desc: '순위표 이름 옆 장식 (3단계)' },
  salve: { name: '꿈 연고', price: 80, kind: 'cure', desc: '가장 심한 부상 하나를 바로 낫게 함 (사면 바로 쓰임, 흉터 없음)' },
  charm: { name: '용기의 부적', price: 150, kind: 'cure', desc: '모든 상대에 대한 공포를 바로 없앰 (사면 바로 쓰임)' },
  sleep: { name: '깊은 잠', price: 250, kind: 'cure', desc: '모든 부상과 피로를 바로 씻어 냄 (사면 바로 쓰임, 흉터 없음)' },
};
function earnDream(c, amount) { const before = c.dream || 0; c.dream = Math.min(DREAM_MAX, before + Math.max(0, Math.round(amount))); return c.dream - before; }
function dailyFirst(c) { if (c.firstWinDay === today()) return 0; c.firstWinDay = today(); return 20; }
// 하루 횟수 제한 (온라인 3승 · cron 5승 · 스토리 3장 등)
function dayCount(c, key, limit) {
  const d = today(); if (!c.dayCount || c.dayCount.day !== d) c.dayCount = { day: d };
  const n = c.dayCount[key] || 0; if (n >= limit) return false;
  c.dayCount[key] = n + 1; return true;
}
// 가방 효과는 전투 상태 안의 캐릭터 사본에만 (DB 의 영구 능력치는 그대로)
function applyBag(st, items) {
  if (!items.length) return;
  const me = st.me, c = me.char = JSON.parse(JSON.stringify(me.char)), cap = capsOf(c);
  const up = (k, n) => { c.stats[k] = Math.min(Math.max(cap[k], c.stats[k]), c.stats[k] + n); };
  if (items.includes('sight')) up('acc', 8);
  if (items.includes('guard')) up('def', 8);
  if (items.includes('tea')) me.gauge = 1;
  st.items = { bandage: items.includes('bandage') ? 1 : 0, smoke: items.includes('smoke') ? 1 : 0 };
  st.bagUsed = items;
}
// ─── 흔적: 전투의 영향이 캐릭터에 남는다 (부상 · 흉터 · 피로 · 기세 · 공포/극복 · 숙적 · 자주 만난 상대) ───
//   숫자는 코드가: 효과·지속은 여기서 정하고 전투 사본에만 적용(DB 의 영구 능력치는 그대로). AI 심사관·게임 마스터에겐 '상태'·'관계' 문장으로만 전달해 서술에 녹인다
//   AI 전투(pve)·자동 생사결 상대(auto)·꿈 이야기(story)에만. 온라인 대전·부재 중 자동 전투에는 적용하지 않는다(공정성·서술 없음)
const PARTS = { arm: '팔', leg: '다리', head: '머리', body: '몸통' };
const PART_HINT = { arm: '팔을 크게 휘두르거나 무거운 것을 다루기 어려움', leg: '빠르게 달리거나 뛰기 어려움', head: '어지러워 조준이 흔들림', body: '숨이 차고 맞으면 더 아픔' };
// [경상, 중상] 효과: atk·spd 는 비율 감소, acc·def 는 값 감소, hp 는 전투 시작 HP 비율 감소, flee 는 도망 확률 감소
const INJ = { arm: [{ atk: 0.08 }, { atk: 0.15 }], leg: [{ spd: 0.10 }, { spd: 0.20, flee: 0.10 }], head: [{ acc: 5 }, { acc: 10 }], body: [{ def: 4 }, { def: 8, hp: 0.10 }] };
const INJ_DUR = [{ battles: 3, hours: 6 }, { battles: 6, hours: 24 }];   // 둘 중 먼저 오는 쪽에 낫는다
const SEV_KO = ['경상', '중상'], MAX_INJ = 3, FATIGUE_N = 15, FATIGUE_MS = 3600e3, STREAK_N = 3, FOE_DAYS = 3, RIVAL_N = 5;
const injLabel = j => `${j.side || ''}${PARTS[j.part]} ${SEV_KO[j.sev]}`;
function injEffect(j) {
  const e = INJ[j.part][j.sev], o = [];
  if (e.atk) o.push(`ATK −${e.atk * 100}%`); if (e.spd) o.push(`속도 −${e.spd * 100}%`); if (e.acc) o.push(`명중 −${e.acc}`);
  if (e.def) o.push(`방어 −${e.def}%p`); if (e.hp) o.push(`시작 HP −${e.hp * 100}%`); if (e.flee) o.push(`도망 −${e.flee * 100}%p`);
  return o.join(' · ');
}
const blankCond = () => ({ inj: [], scars: [], streak: 0, recent: [], foes: {} });
const activeInj = (cond, now) => (cond?.inj || []).filter(j => j.left > 0 && now - j.at < INJ_DUR[j.sev].hours * 3600e3);
const recentBattles = (cond, now) => (cond?.recent || []).filter(t => now - t < FATIGUE_MS).length;
function foeKeyOf(st) {
  if (st.mode === 'auto') return st.foeId ? 'c:' + st.foeId : null;
  if (st.mode === 'pve') return 'e:' + String(st.foe.char.name).replace(/^악몽 · /, '');
  return null;
}
// 상대별 마음가짐: 최근 7일 기록(h: 이겼나·내 남은 HP·상대 남은 HP)으로 코드가 정한다. 우선순위 공포 > 투지 > 긴장 > 방심
const MOOD = {
  fear: { ko: '공포', fx: { acc: -5 }, tag: '명중 −5', line: '이 상대에게 처참하게(또는 연달아) 져서 겁에 질려 있음' },
  grit: { ko: '투지', fx: { atk: 0.05 }, tag: 'ATK +5%', line: '지난번 이 상대에게 진 걸 갚으려는 투지에 불타 있음' },
  tense: { ko: '긴장', fx: { def: 3, spd: -0.05 }, tag: '방어 +3%p · 속도 −5%', line: '지난번 이 상대와 아슬아슬하게 싸워서 잔뜩 긴장해 조심스러움' },
  cocky: { ko: '방심', fx: { acc: 3, def: -4 }, tag: '명중 +3 · 방어 −4%p', line: '예전에 이 상대를 쉽게 이겨서 만만하게 보고 얕보고 있음' },
};
function moodOf(f, now) {
  if (!f) return null;
  if (f.fear) return 'fear';
  const h = (f.h || []).filter(x => now - x.t < 7 * 86400e3), last = h[h.length - 1];
  if (!last) return null;
  if (!last.w) return 'grit';
  const w = h.filter(x => x.w).length, l = h.length - w;
  if (Math.min(last.w ? last.me : last.foe, 1) < 0.3 || (w && l)) return 'tense';
  if (!l && w >= 2 && h.every(x => x.me >= 0.6)) return 'cocky';
  return null;
}
function foeMemo(cond, key, now) {
  const f = key && cond?.foes?.[key]; if (!f) return null;
  return { name: f.name, n: f.n, w: f.w, l: f.l, recent: (f.ts || []).filter(t => now - t < FOE_DAYS * 86400e3).length, rival: f.n >= RIVAL_N, fear: !!f.fear, overcame: !!f.overcame, mood: moodOf(f, now) };
}
// 화면용 요약 (publicChar 에 실림)
function condView(c, now = Date.now()) {
  const cond = c.cond || {}, foes = Object.values(cond.foes || {});
  return {
    injuries: activeInj(cond, now).map(j => ({ label: injLabel(j), sev: j.sev, effect: injEffect(j), battlesLeft: j.left, hoursLeft: Math.max(0, Math.ceil((INJ_DUR[j.sev].hours * 3600e3 - (now - j.at)) / 3600e3)), hint: PART_HINT[j.part] })),
    fatigue: recentBattles(cond, now) >= FATIGUE_N, recent: recentBattles(cond, now), fatigueAt: FATIGUE_N,
    streak: cond.streak || 0, momentum: (cond.streak || 0) >= STREAK_N,
    moods: foes.filter(f => (f.ts || []).some(t => now - t < 7 * 86400e3)).map(f => { const m = moodOf(f, now); return m ? { foe: f.name, ko: MOOD[m].ko, tag: MOOD[m].tag, key: m } : null; }).filter(Boolean),
    slump: (cond.lstreak || 0) >= STREAK_N ? cond.lstreak : 0,
    fears: foes.filter(f => f.fear).map(f => f.name), rivals: foes.filter(f => f.n >= RIVAL_N).map(f => `${f.name} (${f.w}승 ${f.l}패)`), overcame: foes.filter(f => f.overcame).map(f => f.name),
    scars: (cond.scars || []).map(s => s.text),
  };
}
// 전투 시작: 상태 효과를 전투 사본에 적용하고, 심사관·게임 마스터에게 줄 문장을 만든다
function applyCond(st, c, now = Date.now()) {
  const cond = c.cond || {}, me = st.me;
  const ch = me.char = JSON.parse(JSON.stringify(me.char)), s = ch.stats, lines = [], tags = [];
  for (const j of activeInj(cond, now)) {
    const e = INJ[j.part][j.sev];
    if (e.atk) s.atk = Math.round(s.atk * (1 - e.atk)); if (e.spd) s.spd = Math.round(s.spd * (1 - e.spd));
    if (e.acc) s.acc -= e.acc; if (e.def) s.def = Math.max(0, s.def - e.def); if (e.hp) me.hp = Math.max(1, Math.round(me.hp * (1 - e.hp)));
    if (e.flee) st.fleePenalty = (st.fleePenalty || 0) + e.flee;
    tags.push(`${injLabel(j)} (${injEffect(j)})`); lines.push(`${injLabel(j)} — ${PART_HINT[j.part]}`);
  }
  if (recentBattles(cond, now) >= FATIGUE_N) { s.spd = Math.round(s.spd * 0.9); s.acc -= 5; tags.push('피로 (속도 −10% · 명중 −5)'); lines.push('쉬지 않고 연달아 싸워 몸이 무겁고 지쳐 있음'); }
  if ((cond.streak || 0) >= STREAK_N) { me.gauge = Math.min(ULT_COST, me.gauge + 1); tags.push(`기세 ${cond.streak}연승 (게이지 +1)`); lines.push(`${cond.streak}연승 중이라 기세가 올라 있음`); }
  if ((cond.lstreak || 0) >= STREAK_N) { s.acc -= 3; tags.push(`의기소침 ${cond.lstreak}연패 (명중 −3)`); lines.push(`${cond.lstreak}연패 중이라 의기소침해 있음`); }
  const memo = foeMemo(cond, foeKeyOf(st), now);
  if (memo) {
    const md = memo.mood && MOOD[memo.mood];
    if (md) {
      const fx = md.fx; if (fx.acc) s.acc += fx.acc; if (fx.def) s.def = Math.max(0, s.def + fx.def); if (fx.atk) s.atk = Math.round(s.atk * (1 + fx.atk)); if (fx.spd) s.spd = Math.round(s.spd * (1 + fx.spd));
      tags.push(`${md.ko} (${md.tag})`); lines.push(md.line);
    }
    st.memo = memo;
    st.foe.char = { ...st.foe.char, memo: [memo.recent >= 1 ? `최근 ${FOE_DAYS}일 동안 ${memo.recent + 1}번째 대결이라 요즘 자주 만나는 사이` : `${memo.n + 1}번째 대결`, `지금까지 ${memo.w}승 ${memo.l}패`, memo.rival ? '숙적' : '', md ? `플레이어의 마음가짐: ${md.ko} — ${md.line}` : '', memo.overcame ? '플레이어가 예전에 공포를 이겨낸 상대' : ''].filter(Boolean).join(', ') };
  }
  if (cond.scars?.length) lines.push('흉터: ' + cond.scars.map(x => x.text).join(', '));
  ch.state = lines.join(' / ');
  st.cond = tags;
}
// 전투가 끝난 뒤(DB 최신 캐릭터 x 에 적용): 자연 회복·흉터, 피로 기록, 연승, 상대 기억(공포·극복·숙적), 새 부상
function condAfter(x, st, now = Date.now()) {
  const c = x.cond = { ...blankCond(), ...(x.cond || {}) }, after = { healed: [], scars: [] };
  for (const j of c.inj) j.left--;
  c.inj = c.inj.filter(j => {
    if (j.left > 0 && now - j.at < INJ_DUR[j.sev].hours * 3600e3) return true;
    after.healed.push(injLabel(j));
    if (j.sev === 1) { const t = `${j.side || ''}${PARTS[j.part]}의 흉터`; c.scars = [...c.scars, { text: t, at: now }].slice(-5); after.scars.push(t); }
    return false;
  });
  c.recent = [...c.recent.filter(t => now - t < FATIGUE_MS), now].slice(-20);
  c.streak = st.winner === 1 ? (c.streak || 0) + 1 : 0;
  c.lstreak = st.winner === 1 ? 0 : (c.lstreak || 0) + 1;
  const key = foeKeyOf(st);
  if (key) {
    const f = c.foes[key] = c.foes[key] || { name: String(st.foe.char.name).replace(/^악몽 · /, '').slice(0, 20), n: 0, w: 0, l: 0, ts: [], ls: 0 };
    f.n++; if (st.winner === 1) f.w++; else f.l++;
    f.ts = [...(f.ts || []).filter(t => now - t < 7 * 86400e3), now].slice(-10);
    f.ls = st.winner === 1 ? 0 : (f.ls || 0) + 1;
    const meF = Math.max(0, st.me.hp) / (st.me.char?.stats?.hp || x.stats.hp), foeF = Math.max(0, st.foe.hp) / (st.foe.char?.stats?.hp || 1);
    f.h = [...(f.h || []), { w: st.winner === 1 ? 1 : 0, me: Math.round(meF * 100) / 100, foe: Math.round(foeF * 100) / 100, t: now }].slice(-5);
    if ((f.ls >= 2 || (st.winner === 2 && foeF >= 0.7)) && !f.fear) { f.fear = true; after.fear = f.name; }   // 연달아 2패 또는 압도적 패배(상대 HP 70% 이상 남김)
    if (st.winner === 1 && f.fear) { f.fear = false; f.overcame = true; after.overcame = f.name; }
    const keys = Object.keys(c.foes); if (keys.length > 30) { keys.sort((a, b) => (c.foes[a].ts?.at(-1) || 0) - (c.foes[b].ts?.at(-1) || 0)); for (const k of keys.slice(0, keys.length - 30)) delete c.foes[k]; }
  }
  // 새 부상: 지면 45%, 이겨도 남은 HP 30% 미만이면 25%, 60% 미만이면 8%. 받은 크리티컬마다 +6%p. 지면 30%·아슬아슬하면 15% 가 중상
  //   시뮬레이션(300명×120전): 쉬지 않고 연속이면 승률 88.6% → 약 85%, 판 사이 쉬면 거의 그대로
  const max = st.me.char?.stats?.hp || x.stats.hp, frac = Math.max(0, st.me.hp) / max;
  const crits = st.log.reduce((n, l) => n + l.events.filter(e => e.target === 1 && e.hit && e.crit).length, 0);
  const p = Math.min(0.8, (st.winner === 2 ? 0.45 : frac < 0.3 ? 0.25 : frac < 0.6 ? 0.08 : 0) + 0.06 * crits);
  if (p > 0 && rnd() < p) {
    const part = pick(Object.keys(PARTS)), sevP = st.winner === 2 ? 0.3 : frac < 0.3 ? 0.15 : 0.05;
    const same = c.inj.find(j => j.part === part), act = c.inj.filter(j => j.left > 0);
    if (same) { same.sev = 1; same.left = INJ_DUR[1].battles; same.at = now; after.worse = injLabel(same); after.effect = injEffect(same); }
    else if (act.length < MAX_INJ) { const j = { part, side: part === 'arm' || part === 'leg' ? pick(['왼', '오른']) : '', sev: rnd() < sevP ? 1 : 0, at: now }; j.left = INJ_DUR[j.sev].battles; c.inj.push(j); after.injury = injLabel(j); after.effect = injEffect(j); after.dur = INJ_DUR[j.sev]; }
  }
  after.streak = c.streak; after.lstreak = c.lstreak;
  if (key) { const m = moodOf(c.foes[key], now); if (m && m !== 'fear') after.mood = { foe: c.foes[key].name, ko: MOOD[m].ko, tag: MOOD[m].tag }; }
  st.after = after;
}

async function buyItem(id, body, env) {
  const c0 = await loadChar(env, id, body.token);
  if (!c0) return json({ error: 'forbidden' }, 403);
  const key = String(body.item || ''), it = own(ITEMS, key) ? ITEMS[key] : null;
  if (!it) return json({ error: 'bad_request' }, 400);
  let relic = null;
  if (it.kind === 'relic') {
    relic = clip(body.name, 12);
    if (!relic) return json({ error: 'bad_request' }, 400);
    if (STORY_BANNED.some(b => relic.includes(b))) return json({ error: 'ip_name' }, 400);
    const m = await moderate(env, relic); if (!m.ok) return json({ error: 'policy', reason: m.reason, label: m.label }, 400);
  }
  let err = null, paid = 0;
  const c = await updateChar(env, id, x => {
    err = null; paid = 0;
    const have = x.dream || 0; let price = it.price;
    if (it.kind === 'star') { const lv = x.stars || 0; if (lv >= 3) { err = 'max_item'; return; } price = it.price[lv]; }
    if (it.kind === 'relic' && x.relic) price = 300;
    if (have < price) { err = 'no_dream'; return; }
    if (it.kind === 'cure') {   // 흔적 회복: 고칠 게 없으면 사지 않음
      const cd = x.cond || {}, now = Date.now(), act = activeInj(cd, now);
      if (key === 'salve') { if (!act.length) { err = 'nothing_to_cure'; return; } const j = [...act].sort((a, b) => b.sev - a.sev || b.at - a.at)[0]; cd.inj = cd.inj.filter(i => i !== j); }
      if (key === 'sleep') { if (!act.length && recentBattles(cd, now) < FATIGUE_N) { err = 'nothing_to_cure'; return; } cd.inj = []; cd.recent = []; }
      if (key === 'charm') { const fs = Object.values(cd.foes || {}).filter(f => f.fear); if (!fs.length) { err = 'nothing_to_cure'; return; } for (const f of fs) f.fear = false; }
      x.cond = cd;
    } else if (it.kind === 'bag' || it.kind === 'use') { x.bag ||= {}; const n = x.bag[key] || 0; if (n >= (it.max || STACK)) { err = 'max_item'; return; } x.bag[key] = n + 1; }
    else if (it.kind === 'relic') x.relic = relic;
    else if (it.kind === 'star') x.stars = (x.stars || 0) + 1;
    x.dream = have - price; paid = price;
  }, c0);
  if (err) return json({ error: err }, 409);
  return json({ ok: true, paid, char: publicChar(c) });
}
async function rerollBattle(id, body, env) {
  const row = await env.DB.prepare('SELECT state, updated FROM rpg_battles WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'no_battle' }, 404);
  const st = JSON.parse(row.state);
  const c = await loadChar(env, st.charId, body.token);
  if (!c) return json({ error: 'forbidden' }, 403);
  if (st.mode !== 'pve' || st.log.length || st.rerolled || st.status !== 'playing' || isBusy(st)) return json({ error: 'bad_request' }, 409);
  let bad = false;
  await updateChar(env, c.id, x => { bad = false; if (!((x.bag?.map || 0) > 0)) { bad = true; return; } x.bag.map--; }, c);
  if (bad) return json({ error: 'no_item' }, 409);
  const foe = pickEnemy(c, { nightmare: !!st.nightmare });
  st.foe = { char: foe, hp: foe.stats.hp, gauge: 0, guard: false }; st.rerolled = true;
  const upd = await env.DB.prepare('UPDATE rpg_battles SET state = ?, updated = ? WHERE id = ? AND updated = ?').bind(JSON.stringify(st), Date.now(), id, row.updated).run();
  if (upd.meta.changes !== 1) return json({ error: 'retry' }, 409);
  return json({ battle: st });
}

// ─── 꿈 이야기 (스토리 모드) ─────────────────────────────────────────
// 숫자는 코드가, 이야기는 AI 가: 장면 순서·판정·보상은 아래 뼈대가 정하고, AI 는 챕터마다 한 번만 불려 그 캐릭터의 설정으로 빈칸(글)만 채운다.
//   2026-10 실측(gemma-4, 8건): 형식 통과 8/8, 수치·실존 IP 누출 0, 평균 25초·약 50뉴런. llama-3.1-8b 는 깨진 출력이라 쓰지 않는다
//   생성 실패·한도 소진이면 손으로 쓴 '막차 정류장'으로 대신한다. 스토리 승리는 승점에 넣지 않는다. 지는 건 '꿈에서 깸'(캐릭터 유지) — 단 '생사결 꿈'을 켜면 손님 캐릭터는 사라진다
const STORY = [
  { id: 'n1', type: 'intro', options: [{ id: 'n1_a' }, { id: 'n1_b' }] },
  { id: 'n2', type: 'battle', enemyTier: 0.8 },
  { id: 'n3', type: 'choice', free: 'n3_atk', options: [{ id: 'n3_atk', check: 'ATK' }, { id: 'n3_agi', check: 'AGI' }, { id: 'n3_pay', check: 'cost' }] },
  { id: 'n4', type: 'fork', options: [{ id: 'n4_rest' }, { id: 'n4_event', check: 'random' }] },
  { id: 'n5', type: 'battle', enemyTier: 'mirror' },
  { id: 'n6', type: 'choice', free: 'n6_talk', options: [{ id: 'n6_talk', check: 'TALK' }, { id: 'n6_pass' }] },
  { id: 'n7', type: 'boss' },
];
const CHECK_KO = { ATK: 'ATK 판정', AGI: '속도·회피 판정', cost: '대가: HP 10%, 반드시 성공', random: '운', TALK: '개연성 판정' };
const EFFECT_KO = { n3_ok: '다음 전투 게이지 +1 · 꿈 조각 +5', n3_fail: 'HP −8%', n3_pay: 'HP −10% · 다음 전투 게이지 +1', n4_rest: 'HP +30%', n4_ok: '꿈 조각 +10', n4_fail: 'HP −10%', n6_ok: '보스 약화 · 꿈 조각 +5' };
const STORY_PUBLIC = STORY.map(n => ({ id: n.id, type: n.type, free: !!n.free, options: n.options?.map(o => ({ id: o.id, check: o.check ? CHECK_KO[o.check] : null })) }));
const SLOT_HINT = {
  n1_a: '무엇인가를 살펴본다(판정 없음)', n1_b: '곧장 앞으로 나아간다(판정 없음)',
  n3_atk: '힘으로 밀어붙여 해결', n3_agi: '빠르고 날렵하게 피해 가며 해결', n3_pay: '소중한 무언가(기억·체력)를 대가로 내주고 확실히 해결',
  n4_rest: '잠시 쉬어 간다', n4_event: '낯선 무언가를 따라가 본다',
  n6_talk: '보스의 부하/사자를 말로 설득한다(성공하면 보스가 약해짐)', n6_pass: '설득하지 않고 지나간다',
};
// 같은 캐릭터라도 챕터마다 다른 소재를 코드가 골라 건넨다 (프롬프트에 예시 문장을 넣으면 그 문장이 그대로 반복됐음)
const STORY_MOTIFS = {
  place: ['바닷속 도시', '하늘을 떠도는 섬', '끝나지 않는 학교 복도', '눈 내리는 사막', '거대한 시계 속', '버려진 놀이공원', '책 속의 마을', '달 뒷면의 정원', '물에 잠긴 지하철역', '종이로 접은 숲'],
  obstacle: ['무너진 다리', '거꾸로 흐르는 강', '말을 거는 그림자 벽', '잠긴 오르골 상자', '멈추지 않는 회전목마', '깨진 거울 미로', '끝없이 이어진 계단', '안개 낀 시장 골목', '거대한 모래시계', '잠든 거인의 손바닥'],
  fork: [['작은 등불 여관', '속삭이는 우물'], ['따뜻한 기차 칸', '낯선 축제 천막'], ['구름 위 벤치', '먼지 쌓인 도서관'], ['조용한 온실', '빛나는 골목 상점'], ['오래된 다락방', '물 위의 등대']],
};
const pick = a => a[Math.floor(rnd() * a.length)];
const pickMotifs = () => ({ place: pick(STORY_MOTIFS.place), obstacle: pick(STORY_MOTIFS.obstacle), fork: pick(STORY_MOTIFS.fork) });
const SYS_CHAPTER = `당신은 꿈속 텍스트 RPG 'DREAM RPG'의 이야기 작가입니다. 한 캐릭터를 위한 짧은 꿈 챕터(7장면)의 글만 씁니다.
장면 순서·종류·선택지 개수·판정·보상·수치는 게임 코드가 이미 정했습니다. 당신은 주어진 JSON 틀의 빈 문자열("")만 한국어로 채웁니다.
규칙:
1) 틀의 키를 바꾸거나 더하거나 빼지 마세요. 선택지를 새로 만들지 마세요. 뼈대의 선택지 설명은 '뜻'일 뿐이니 label 에 그대로 베끼지 말고, 그 장면의 소재와 이 캐릭터에 맞는 구체적 행동으로 쓰세요.
2) 숫자를 쓰지 마세요: 피해량·확률·%·HP·능력치·보상·아이템 개수·레벨 없음. 새 아이템·보상·능력을 만들지 마세요. 결과 문장에서 무언가를 얻거나 줍거나 회복하지 마세요(보상과 회복은 코드가 따로 알려 줍니다). 결과 문장은 분위기와 행동만.
3) 길이: situation 300자 이내(2~3문장), label 40자 이내(행동 한 구절), result/success/fail/win/lose 120자 이내(한 문장), enemy/boss desc 한 문장, setting 300자 이내.
4) 캐릭터 설정의 약점·대가·배경·특기를 배경과 모든 장면에 엮으세요. 특히 마지막 보스(n7)는 그 캐릭터의 약점을 형상화한 존재여야 하고 weaknessLink 에 어떤 약점과 이어지는지 한 문장. n5 의 적은 캐릭터 자신을 비춘 거울 같은 그림자.
5) 실존 인물, 애니메이션·만화·게임·영화 등 기존 작품의 캐릭터 이름·기술 이름·고유 설정을 쓰지 마세요. 캐릭터 설정에 그런 이름이 있어도 그대로 옮기지 말고 일반 묘사로 바꿉니다. 플레이어 캐릭터는 '당신'으로 부르세요.
6) 성적 묘사·혐오 표현·잔혹한 묘사 금지(전투는 만화 수준). 꿈답게 몽환적이되 쉬운 문장. 패배(lose)·실패(fail) 문장에서 꿈이 끝나거나 죽는다고 쓰지 마세요.
설명 없이 완성된 JSON 하나만 출력하세요.`;
function chapterTemplate() {
  const nodes = {};
  for (const n of STORY) {
    if (n.type === 'battle' || n.type === 'boss') nodes[n.id] = { situation: '', [n.type === 'boss' ? 'boss' : 'enemy']: n.type === 'boss' ? { name: '', desc: '', weaknessLink: '' } : { name: '', desc: '' }, win: '', lose: '' };
    else { const options = {}; for (const o of n.options) options[o.id] = o.check ? { label: '', success: '', fail: '' } : { label: '', result: '' }; nodes[n.id] = { situation: '', options }; }
  }
  return { title: '', setting: '', nodes };
}
const TYPE_KO = { intro: '도입(선택, 판정 없음)', battle: '전투', choice: '선택', fork: '갈림길', boss: '보스 전투' };
function chapterUser(c, chapter, mo) {
  const lines = STORY.map(n => {
    let d = `${n.id}: ${TYPE_KO[n.type]}`;
    if (n.type === 'battle') d += n.enemyTier === 'mirror' ? ' — 상대는 당신을 닮은 그림자' : ' — 평범한 꿈속 적';
    if (n.type === 'boss') d += ' — 캐릭터의 약점을 형상화한 강한 보스';
    if (n.id === 'n3') d += ` (장애물 소재: ${mo.obstacle})`;
    if (n.id === 'n4') d += ` (갈림길 소재: ${mo.fork[0]} / ${mo.fork[1]})`;
    if (n.options) d += '\n' + n.options.map(o => `   - ${o.id}: ${SLOT_HINT[o.id]}${o.check ? ' → 성공/실패 문장 필요' : ' → 결과 문장 하나'}`).join('\n');
    return d;
  });
  return `[캐릭터]\n이름: ${c.name}\n설정: ${c.info}${c.relic ? `\n소지품: ${c.relic}` : ''}\n\n[챕터 ${chapter}${chapter > 1 ? ' — 앞 장보다 더 깊은 꿈' : ''}]\n무대 소재: ${mo.place}\n\n[장면 뼈대]\n${lines.join('\n')}\n\n[채울 JSON 틀 — 빈 문자열만 채워서 그대로 출력]\n${JSON.stringify(chapterTemplate())}`;
}
// 생성 결과 검사 (scratchpad 실험의 validate.js 이식): ok / fixable(자동 수정) / reject
const CH_LIMIT = { title: 30, setting: 300, situation: 300, label: 40, result: 120, success: 120, fail: 120, win: 120, lose: 120, desc: 120, weaknessLink: 120, name: 20 };
const STORY_BANNED = ['고죠', '사토루', '무하한', '무량공처', '육안', '영역전개', '주술회전', '료멘', '스쿠나', '이타도리', '탄지로', '네즈코', '귀멸', '루피', '조로', '원피스', '나루토', '사스케', '카카시', '리바이', '미카사', '에렌', '진격', '손오공', '베지터', '드래곤볼', '카메하메하', '키리토', '토도로키', '에반게리온', '피카츄', '포켓몬', '마리오', '젤다', '해리 포터', '호그와트', '아이언맨', '스파이더맨', '배트맨', '슈퍼맨', '사이타마', '원펀맨', '토토로', '도라에몽'];
const CH_MECH = [/\d/, /[０-９]/, /%|퍼센트/, /\bHP\b|\bMP\b|EXP|경험치|레벨\s*업|골드/i, /데미지|대미지/, /(공격력|방어력|체력|속도|회피|명중)\s*(이|가|을|를)?\s*(\+|증가|상승|올라|감소|떨어)/, /(두|세|네)\s*배/];
const CH_CONTRA = [/꿈에서 (깨어|깹)/, /게임 ?오버/, /죽(습니다|었다|고 맙)/];
const CH_INVENT = [/얻(습니다|는다|게 됩|었|어)/, /획득/, /손에 넣/, /보상/, /아이템/, /물약|포션/, /회복(됩|합|했|한다)/];
function chExtract(text) {
  const t = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/g, '');
  const m = t.match(/\{[\s\S]*\}/); if (!m) return null;
  try { return JSON.parse(m[0]); } catch {}
  try { return JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1').replace(new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + ']+', 'g'), ' ')); } catch { return null; }
}
function chSchema(tpl, got, p, errs) {
  if (typeof tpl === 'string') { if (typeof got !== 'string') errs.push(`${p}: 문자열 아님`); else if (!got.trim()) errs.push(`${p}: 비어 있음`); return; }
  if (!got || typeof got !== 'object' || Array.isArray(got)) { errs.push(`${p}: 객체 아님`); return; }
  for (const k of Object.keys(tpl)) if (!(k in got)) errs.push(`${p}.${k}: 빠짐`); else chSchema(tpl[k], got[k], `${p}.${k}`, errs);
  for (const k of Object.keys(got)) if (!(k in tpl)) errs.push(`${p}.${k}: 추가 키`);
}
function* chLeaves(o, p = '') { if (typeof o === 'string') yield [p, o]; else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) yield* chLeaves(v, p ? `${p}.${k}` : k); }
function validateChapter(text) {
  const r = { schema: [], length: [], mech: [], invent: [], ip: [], contra: [], foreign: 0, hanja: 0, korean: 0, grade: 'reject' };
  const j = chExtract(text); if (!j) return r;
  r.parsed = j; chSchema(chapterTemplate(), j, '$', r.schema);
  let ko = 0, letters = 0;
  for (const [p, v] of chLeaves(j)) {
    const leaf = p.split('.').pop(), lim = CH_LIMIT[leaf];
    if (lim && [...v].length > lim) r.length.push(p);
    if (CH_MECH.some(re => re.test(v))) r.mech.push(p);
    if (!p.includes('n4_rest') && CH_INVENT.some(re => re.test(v)) && !/label$/.test(leaf)) r.invent.push(p);
    if (STORY_BANNED.some(b => v.includes(b))) r.ip.push(p);
    if (/(fail|lose|result)$/.test(leaf) && CH_CONTRA.some(re => re.test(v))) r.contra.push(p);
    ko += (v.match(/[가-힣]/g) || []).length; letters += (v.match(/[가-힣A-Za-z぀-ヿ一-鿿]/g) || []).length;
    if (/\([一-鿿]+\)/.test(v)) r.hanja++;
    if (/[぀-ヿ一-鿿]/.test(v.replace(/\([一-鿿]+\)/g, ''))) r.foreign++;
  }
  r.korean = letters ? ko / letters : 0;
  const fatal = r.schema.some(e => !/비어 있음/.test(e)) || r.ip.length || r.mech.length || r.korean < 0.85 || r.foreign;
  r.grade = fatal ? 'reject' : (r.length.length || r.invent.length || r.contra.length || r.hanja || r.schema.length) ? 'fixable' : 'ok';
  return r;
}
function autofixChapter(j, r) {
  const out = JSON.parse(JSON.stringify(j));
  const set = (p, fn) => { const ks = p.replace(/^\$\./, '').split('.'); let o = out; for (const k of ks.slice(0, -1)) o = o[k]; const k = ks[ks.length - 1]; o[k] = fn(String(o[k] ?? ''), k); };
  for (const [p] of [...chLeaves(out)]) set(p, v => v.replace(/\([一-鿿]+\)/g, ''));
  for (const p of r.length) set(p.replace(/^\$\./, ''), (v, k) => { const lim = CH_LIMIT[k], t = [...v].slice(0, lim).join(''); const cut = t.lastIndexOf('다.'); return cut > lim * 0.5 ? t.slice(0, cut + 2) : t.slice(0, lim - 1) + '…'; });
  for (const p of r.contra) set(p, () => '힘이 빠진 채 비틀거리지만, 꿈은 아직 끝나지 않았습니다.');
  for (const p of r.invent) set(p, () => '무언가 손끝에 스쳤지만, 꿈은 아무것도 남기지 않았습니다.');
  for (const p of r.schema.filter(e => /비어 있음/.test(e)).map(e => e.split(':')[0].replace(/^\$\./, ''))) set(p, (v, k) => k === 'label' ? '조심스럽게 다가간다' : '꿈이 조용히 다음 장면으로 흘러갑니다.');
  return out;
}
// 대체 챕터: 손으로 쓴 '막차 정류장' (생성 실패·한도 소진 시)
const FALLBACK_CHAPTER = { title: '막차 정류장', setting: '시간표에 없는 몽행 0번 버스가 당신을 태우고 잠의 가장자리를 달립니다. 창밖으로 지나간 하루의 조각들이 가로등처럼 스쳐 가고, 종점에는 아무도 이름을 모르는 정류장이 있습니다.', nodes: {
  n1: { situation: '덜컹, 버스가 멈춥니다. 문이 열리자 안개 낀 정류장과 깜빡이는 시간표가 보입니다. 운전석은 비어 있습니다.', options: { n1_a: { label: '깜빡이는 시간표를 들여다본다', result: '시간표의 글자가 당신의 이름으로 바뀌었다가 다시 흐려집니다.' }, n1_b: { label: '안개 속으로 곧장 내린다', result: '발밑의 보도블록이 물결처럼 출렁이며 당신을 앞으로 이끕니다.' } } },
  n2: { situation: '개찰구 앞에 잿빛 제복을 입은 누군가가 길을 막습니다. "표를 보여 주시죠."', enemy: { name: '잿빛 검표원', desc: '구멍 뚫는 집게를 무기처럼 쥔, 표 없는 승객을 쫓는 검표원입니다.' }, win: '검표원은 집게를 떨어뜨리고 연기처럼 흩어집니다. 개찰구가 저절로 열립니다.', lose: '검표원의 집게가 당신의 표를 찢고, 정류장이 멀어지기 시작합니다.' },
  n3: { situation: '광장 한가운데 시계탑의 바늘이 거꾸로 돕니다. 바늘이 한 칸 물러날 때마다 가로등이 하나씩 꺼지고, 꺼진 자리에서 낮은 숨소리가 들립니다.', options: { n3_atk: { label: '바늘을 붙잡아 억지로 멈춘다', success: '바늘이 비명을 지르며 멈추고, 꺼졌던 가로등이 하나둘 다시 켜집니다.', fail: '바늘에 밀려 넘어지고, 손바닥이 얼얼하게 저립니다.' }, n3_agi: { label: '꺼진 가로등 사이로 몰래 지나간다', success: '숨소리의 주인이 눈치채기 전에 광장을 빠져나갑니다.', fail: '발소리에 숨소리가 멈추고, 무언가 당신의 발목을 스칩니다.' }, n3_pay: { label: '탑 문에 오늘의 기억 하나를 내놓는다', success: '오늘 아침의 기억이 흐려지는 대신, 탑 문이 조용히 열립니다.', fail: '탑 문은 기억을 받지 않고 굳게 닫혀 있습니다.' } } },
  n4: { situation: '길이 두 갈래로 나뉩니다. 한쪽에는 불 켜진 작은 여관이, 다른 쪽에는 기억을 사고판다는 전당포가 보입니다.', options: { n4_rest: { label: '꿈 여관에서 잠시 눈을 붙인다', result: '꿈속의 꿈에서 잠깐 쉬고 나니 몸이 한결 가볍습니다.' }, n4_event: { label: '기억 전당포의 문을 두드린다', success: '주인이 당신의 잊힌 꿈 한 조각을 값으로 쳐 줍니다.', fail: '주인이 고개를 젓고, 문틈의 찬바람에 기운이 빠집니다.' } } },
  n5: { situation: '전당포 거울 속에서 당신과 똑같이 생긴 그림자가 걸어 나옵니다. 그림자는 당신이 망설였던 순간들을 하나씩 읊습니다.', enemy: { name: '거울 몽상가', desc: '당신의 모습을 하고 당신과 반대로 움직이는 그림자입니다.' }, win: '그림자는 웃으며 거울 속으로 돌아가고, 거울에 금이 갑니다.', lose: '그림자가 당신의 자리를 차지하고, 당신은 거울 속에 갇힙니다.' },
  n6: { situation: '종점으로 가는 계단에 이름을 잃은 아이가 앉아 있습니다. 아이는 종점의 파수꾼이 보낸 심부름꾼이라고 말합니다.', options: { n6_talk: { label: '아이에게 이름을 찾아 주겠다고 약속한다', success: '아이가 처음으로 웃으며 파수꾼의 약점을 귓속말로 알려 줍니다.', fail: '아이는 고개를 저으며 계단 위로 사라집니다.' }, n6_pass: { label: '아이를 지나쳐 계단을 오른다', result: '등 뒤에서 아이의 작은 한숨이 들립니다.' } } },
  n7: { situation: '종점 정류장, 눈꺼풀이 없는 거대한 파수꾼이 당신을 내려다봅니다. "잠든 자는 여기서 내릴 수 없다."', boss: { name: '눈꺼풀 없는 파수꾼', desc: '한 번도 잠든 적 없는, 깨어 있음 그 자체의 악몽입니다.', weaknessLink: '쉬지 못하고 버티는 당신의 피로가 이 파수꾼을 키웠습니다.' }, win: '파수꾼의 눈이 마침내 감기고, 첫차의 불빛이 정류장을 비춥니다.', lose: '파수꾼의 시선에 묶여 몸이 굳고, 꿈이 하얗게 바랩니다.' },
} };
let storyTable = false;
async function ensureStoryTable(env) {
  if (storyTable) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS rpg_story (char_id TEXT NOT NULL, chapter INTEGER NOT NULL, content TEXT, created INTEGER NOT NULL, PRIMARY KEY (char_id, chapter))').run();
  storyTable = true;
}
// 챕터 생성 전용 호출: gemma-4(Workers AI)만 쓴다. 한도는 다른 호출과 같이 센다(사용자 몫 1, 전체 뉴런은 실측)
async function storyAi(env, who, system, user, temperature) {
  const q = await quota(env, who);
  const cf = q.providers.find(p => p.id === 'cf');
  if (q.ip.remaining <= 0) return { ok: false, reason: 'ip' };
  if (!cf?.configured || cf.remaining <= 1 || paused('cf')) return { ok: false, reason: 'exhausted' };
  await bump(env, q.day, who, 'cf', +1, q._bucket);
  try {
    const res = await env.AI.run(MODELS[0].name, { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 4000, temperature, enable_thinking: false, reasoning: { effort: 'none' }, chat_template_kwargs: { enable_thinking: false } });
    let text = typeof res === 'string' ? res : (res.response ?? res.choices?.[0]?.message?.content ?? res.output_text ?? '');
    if (text && typeof text === 'object') text = JSON.stringify(text);
    await record(env, res?.usage, MODELS[0]);
    return { ok: true, text: String(text || '') };
  } catch (e) { await bump(env, q.day, who, 'cf', -1, q._bucket); return { ok: false, reason: 'failed' }; }
}
async function loadContent(env, c, chapter, src) {
  if (src === 'fallback') return FALLBACK_CHAPTER;
  await ensureStoryTable(env);
  const row = await env.DB.prepare('SELECT content FROM rpg_story WHERE char_id = ? AND chapter = ?').bind(c.id, chapter).first();
  try { return row?.content ? JSON.parse(row.content) : FALLBACK_CHAPTER; } catch { return FALLBACK_CHAPTER; }
}
const clampP = p => Math.min(0.95, Math.max(0.05, p));
function optionChance(c, o) {
  const s = c.stats, cap = capsOf(c), r = (a, b) => Math.min(1, a / b);
  if (!o.check || o.check === 'cost') return 1;
  if (o.check === 'random') return 0.6;
  if (o.check === 'ATK') return clampP(0.45 + (r(s.atk, cap.atk) - 0.5) * 0.4);
  if (o.check === 'AGI') return clampP(0.55 + ((r(s.spd, cap.spd) + r(s.eva, cap.eva)) / 2 - 0.5) * 0.4);
  if (o.check === 'TALK') return clampP(0.5 + ((s.stability ?? 0.75) - 0.75) * 0.8);
  return 1;
}
async function storyState(env, c) {
  await ensureStoryTable(env);
  const s = c.story || {}, run = s.run || null, ch = run ? run.chapter : (s.next || 1);
  let content = null, ready = false;
  if (run) content = await loadContent(env, c, run.chapter, run.src);
  else { const row = await env.DB.prepare('SELECT content FROM rpg_story WHERE char_id = ? AND chapter = ?').bind(c.id, ch).first(); ready = !!row?.content; }
  const node = run ? STORY[run.node] : null, odds = {};
  if (node?.options) for (const o of node.options) if (o.check) odds[o.id] = Math.round(optionChance(c, o) * 100);
  return { story: { next: s.next || 1, clears: s.clears || 0, deaths: s.deaths || 0, last: s.last || null, chapter: ch, ready, run, content, odds, nodes: STORY_PUBLIC, effects: EFFECT_KO }, char: publicChar(c) };
}
async function storyInfo(id, token, env) {
  const c = await loadChar(env, id, token);
  return c ? json(await storyState(env, c)) : json({ error: 'forbidden' }, 403);
}
async function prepareStory(id, body, env, who) {
  const c = await loadChar(env, id, body.token);
  if (!c) return json({ error: 'forbidden' }, 403);
  await ensureStoryTable(env);
  const ch = c.story?.next || 1;
  const row = await env.DB.prepare('SELECT content, created FROM rpg_story WHERE char_id = ? AND chapter = ?').bind(c.id, ch).first();
  if (row?.content) return json({ status: 'ready', chapter: ch });
  if (row && Date.now() - row.created < 90e3) return json({ status: 'generating', chapter: ch });   // 다른 요청이 생성 중 (중복 생성 방지)
  await env.DB.prepare('INSERT INTO rpg_story (char_id, chapter, content, created) VALUES (?, ?, NULL, ?) ON CONFLICT(char_id, chapter) DO UPDATE SET created = excluded.created').bind(c.id, ch, Date.now()).run();
  const mo = pickMotifs();
  let content = null, why = '';
  for (let attempt = 0; attempt < 2 && !content; attempt++) {   // 실패하면 한 번만 다시 (온도 낮춰서). 그래도 안 되면 대체 챕터
    const r = await storyAi(env, who, SYS_CHAPTER, chapterUser(c, ch, mo), attempt ? 0.7 : 0.9);
    if (!r.ok) { why = r.reason; break; }
    const v = validateChapter(r.text);
    if (v.grade === 'reject') { why = 'invalid'; continue; }
    const fixed = v.grade === 'fixable' ? autofixChapter(v.parsed, v) : v.parsed;
    const all = [...chLeaves(fixed)].map(([, t]) => t).join('\n');
    if (!(await moderate(env, all.slice(0, 6000))).ok) { why = 'policy'; continue; }
    content = fixed;
  }
  if (!content) {
    await env.DB.prepare('DELETE FROM rpg_story WHERE char_id = ? AND chapter = ? AND content IS NULL').bind(c.id, ch).run();
    return json({ status: 'fallback', chapter: ch, reason: why, quota: pubQuota(await quota(env, who)) });
  }
  await env.DB.prepare('UPDATE rpg_story SET content = ? WHERE char_id = ? AND chapter = ?').bind(JSON.stringify(content), c.id, ch).run();
  return json({ status: 'ready', chapter: ch, quota: pubQuota(await quota(env, who)) });
}
async function startStory(id, body, env) {
  const c0 = await loadChar(env, id, body.token);
  if (!c0) return json({ error: 'forbidden' }, 403);
  await ensureStoryTable(env);
  const ch = c0.story?.next || 1;
  const row = await env.DB.prepare('SELECT content FROM rpg_story WHERE char_id = ? AND chapter = ?').bind(c0.id, ch).first();
  const src = row?.content ? 'ai' : 'fallback';
  const c = await updateChar(env, c0.id, x => {
    x.story ||= { next: 1, clears: 0, deaths: 0 };
    if (x.story.run) return;   // 이미 진행 중이면 그대로 이어감
    x.story.run = { chapter: ch, src, node: 0, hp: x.stats.hp, gauge: 0, flags: {}, shards: 0, hardcore: !!body.hardcore, log: [], started: Date.now() };
  }, c0);
  return json(await storyState(env, c));
}
// 회차 끝: 클리어면 모은 조각 전부, 아니면 절반만 지갑으로
function endRun(x, why) {
  const run = x.story?.run; if (!run) return 0;
  const keep = earnDream(x, why === 'clear' ? run.shards : Math.floor(run.shards / 2));
  if (why !== 'clear') x.story.deaths = (x.story.deaths || 0) + 1;
  x.story.last = { chapter: run.chapter, why, shards: keep, at: Date.now() };
  x.story.run = null;
  return keep;
}
// 장 클리어 보상: 하루 3장까지는 승리 보상 2배 + 꿈 조각 60, 그 뒤엔 0.3배 + 15 (생사결 꿈이면 조각 1.5배). 승점은 없음
function clearChapter(x, run) {
  const full = dayCount(x, 'story', 3);
  const rw = rollReward(x, { stats: { tier: '초인' } }, 'pve');
  if (full) { rw.hp *= 2; rw.atk *= 2; } else { rw.hp = Math.round(rw.hp * 0.3); rw.atk = Math.round(rw.atk * 0.3); rw.stats = {}; rw.tags = []; }
  applyReward(x, rw);
  run.shards += Math.round((full ? 60 : 15) * (run.hardcore ? 1.5 : 1));
  x.story.clears = (x.story.clears || 0) + 1; x.story.next = Math.max(x.story.next || 1, run.chapter + 1);
  const shards = endRun(x, 'clear');
  return { hp: rw.hp, atk: rw.atk, tags: rw.tags, shards, full, chapter: run.chapter };
}
async function storyAct(id, body, env, who) {
  const c = await loadChar(env, id, body.token);
  if (!c) return json({ error: 'forbidden' }, 403);
  const run = c.story?.run, node = run && STORY[run.node];
  if (!node || !node.options) return json({ error: 'bad_request' }, 409);
  const content = await loadContent(env, c, run.chapter, run.src), nc = content.nodes?.[node.id] || {};
  const text = clip(body.text, LEN.text);
  let opt = node.options.find(o => o.id === body.option), judge = null, ok = true, plaus = 0;
  if (text && node.free) {   // 자유 선언: 심사관(AI 1회)이 난이도·적합도 → 대표 선택지의 판정에 보정
    opt = node.options.find(o => o.id === node.free);
    let j = { allowed: true, difficulty: 'normal', fit: 0.5, verdict: '' };
    const m = await moderate(env, text);
    if (!m.ok) j = { allowed: false, difficulty: 'impossible', fit: 0.2, verdict: `이용 정책(${m.label})에 어긋나 받지 않습니다.`, policy: true };
    else {
      const user = `[p1] ${c.name} (${c.fiction}) — 설정: ${c.info}${c.relic ? ` / 소지품: ${c.relic} (평범한 물건)` : ''}\n상황: ${String(nc.situation || '').slice(0, 300)}\n행동: 선언: "${text}"`;
      const r = await safeAi(env, who, SYS_JUDGE_ACTION, user, 0.2);
      const p1 = r.ok && r.parsed?.p1;
      if (p1) j = { allowed: p1.allowed !== false, difficulty: own(DIFF_MOD, p1.difficulty) ? p1.difficulty : 'normal', fit: num(p1.fit, 0, 1, 0.5), verdict: cleanVerdict(p1.verdict) };
    }
    const p = clampP(optionChance(c, opt) + (own(DIFF_MOD, j.difficulty) ? DIFF_MOD[j.difficulty] : 0) + (j.fit - 0.5) * 0.3);
    ok = j.allowed && rnd() < p; judge = { ...j, chance: Math.round(p * 100) };
    plaus = plausDelta({ text }, j);
  } else if (!opt) return json({ error: 'bad_request' }, 400);
  else if (opt.check) ok = rnd() < optionChance(c, opt);
  const oc = nc.options?.[opt.id] || {};
  const line = String((opt.check ? (ok ? oc.success : oc.fail) : oc.result) || '').slice(0, 200);
  const out = await updateChar(env, c.id, x => {
    const r = x.story?.run; if (!r || r.node !== run.node) return;   // 다른 탭에서 이미 진행됨
    const max = x.stats.hp, hurt = f => { r.hp = Math.max(1, r.hp - Math.round(max * f)); };
    let eff = '';
    if (opt.id === 'n3_atk' || opt.id === 'n3_agi') { if (ok) { r.gauge = 1; r.shards += 5; eff = EFFECT_KO.n3_ok; } else { hurt(0.08); eff = EFFECT_KO.n3_fail; } }
    if (opt.id === 'n3_pay') { hurt(0.10); r.gauge = 1; r.flags.offered = true; eff = EFFECT_KO.n3_pay; }
    if (opt.id === 'n4_rest') { r.hp = Math.min(max, r.hp + Math.round(max * 0.3)); eff = EFFECT_KO.n4_rest; }
    if (opt.id === 'n4_event') { if (ok) { r.shards += 10; eff = EFFECT_KO.n4_ok; } else { hurt(0.10); eff = EFFECT_KO.n4_fail; } }
    if (opt.id === 'n6_talk' && ok) { r.flags.bossWeak = true; r.shards += 5; eff = EFFECT_KO.n6_ok; }
    if (plaus) x.stats.stability = clampPlaus(x, (x.stats.stability ?? 0.75) + plaus);
    r.log.push({ node: node.id, label: text ? `“${text}”` : (oc.label || ''), text: line, ok: opt.check ? ok : null, effect: eff, judge, plaus: plaus || undefined });
    if (r.log.length > 20) r.log.shift();
    r.node++;
  }, c);
  return json(await storyState(env, out));
}
function mirrorAlloc(a) { const o = {}; for (const k of ['atk', 'hp', 'def', 'spd', 'acc', 'eva']) o[k] = Math.max(5, 35 - (Number(a?.[k]) || 16.6)); return o; }
async function storyFight(id, body, env) {
  const c = await loadChar(env, id, body.token);
  if (!c) return json({ error: 'forbidden' }, 403);
  const run = c.story?.run, node = run && STORY[run.node];
  if (!node || (node.type !== 'battle' && node.type !== 'boss')) return json({ error: 'bad_request' }, 409);
  if (run.battleId) { const row = await env.DB.prepare('SELECT state FROM rpg_battles WHERE id = ?').bind(run.battleId).first(); if (row) return json({ battle: JSON.parse(row.state) }); }
  const content = await loadContent(env, c, run.chapter, run.src), nc = content.nodes?.[node.id] || {};
  const en = (node.type === 'boss' ? nc.boss : nc.enemy) || {}, scale = Math.sqrt(c.stats.mult || 1);
  const boss = node.type === 'boss', mirror = node.enemyTier === 'mirror';
  // 적은 AI 전투처럼 내 현재 능력치에 맞춘다(matchToPlayer): 잡몹 1.0 · 거울 1.05 · 보스 1.2 (장마다 +0.05, 최대 1.5), 설득에 성공했으면 보스 ×0.85
  //   시뮬레이션(3000회): 1장 클리어 — 새 평범 69% · 평범 20승 87% · 숙련 막 환생 77% · 숙련 상한 96% (예전엔 20승만 넘어도 100%)
  const tier = boss ? Math.min(1.5, 1.2 + 0.05 * (run.chapter - 1)) * (run.flags?.bossWeak ? 0.85 : 1) : mirror ? 1.05 : 1.0;
  const bossHeal = boss ? Math.min(c.stats.hp - run.hp, Math.round(c.stats.hp * 0.5)) : 0;   // 보스 직전 숨 고르기: 최대 HP 50% 회복 (시뮬레이션: 새 평범 캐릭터 1장 클리어 8% → 44%)
  const alloc = mirror ? mirrorAlloc(c.alloc || allocFromStats(c)) : { atk: 20, hp: 20, def: 15, spd: 15, acc: 15, eva: 15 };
  const foe = { id: 'enemy-story', name: clip(en.name, 20) || '꿈의 그림자', fiction: boss ? '악몽' : mirror ? '그림자' : '꿈의 적', info: clip(en.desc, 120), stats: buildStats(alloc, 70, 1), ult: { name: boss ? '악몽의 손길' : '꿈의 일격', effect: '꿈의 힘을 실어 몰아친다', style: 'burst' }, tier };
  matchToPlayer(foe, c, tier);
  foe.stats.tier = boss ? '초인' : '숙련';
  const st = { id: uid(), charId: c.id, mode: 'story', storyNode: node.id, boss, chapter: run.chapter, me: { char: c, hp: Math.max(1, run.hp + Math.max(0, bossHeal)), gauge: run.gauge || 0, guard: false }, bossHeal: Math.max(0, bossHeal) || undefined, foe: { char: foe, hp: foe.stats.hp, gauge: 0, guard: false }, turn: 1, log: [], status: 'playing', winner: null, intro: String(nc.situation || '').slice(0, 300) };
  applyCond(st, c);
  await env.DB.prepare('INSERT INTO rpg_battles (id, char_id, state, updated) VALUES (?, ?, ?, ?)').bind(st.id, c.id, JSON.stringify(st), Date.now()).run();
  await updateChar(env, c.id, x => { if (x.story?.run) { x.story.run.battleId = st.id; x.story.run.gauge = 0; } }, c);
  return json({ battle: st });
}
async function storyBattleEnd(env, st, c) {
  const run0 = c.story?.run, content = await loadContent(env, c, run0?.chapter, run0?.src), nc = content.nodes?.[st.storyNode] || {};
  let reward = null, hardcoreDeath = false;
  const out = await updateChar(env, c.id, x => {
    const run = x.story?.run; if (!run || run.battleId !== st.id) return;
    run.battleId = null; condAfter(x, st);
    if (st.winner === 1) {
      run.hp = Math.max(1, st.me.hp); run.log.push({ node: st.storyNode, label: '전투', text: String(nc.win || '').slice(0, 200), ok: true });
      run.node++;
      if (st.boss) reward = clearChapter(x, run);
    } else { run.log.push({ node: st.storyNode, label: '전투', text: String(nc.lose || '').slice(0, 200), ok: false }); hardcoreDeath = !!run.hardcore; endRun(x, 'dead'); }
  }, c);
  st.me.char = out ? publicChar(out) : st.me.char; st.storyResult = { reward, text: st.winner === 1 ? nc.win : nc.lose, ended: !out?.story?.run, last: out?.story?.last || null };
  if (hardcoreDeath) {   // 생사결 꿈: 손님 캐릭터는 사라진다 (계정 캐릭터는 남음)
    const del = await env.DB.prepare('DELETE FROM rpg_chars WHERE id = ? AND user_sub IS NULL').bind(c.id).run();
    if (del.meta.changes) { st.deleted = true; lbCache.at = 0; }
  }
}
async function storyQuit(id, body, env) {
  const c = await loadChar(env, id, body.token);
  if (!c) return json({ error: 'forbidden' }, 403);
  const bid = c.story?.run?.battleId;
  if (bid) await env.DB.prepare('DELETE FROM rpg_battles WHERE id = ?').bind(bid).run();
  const out = await updateChar(env, c.id, x => { endRun(x, 'quit'); }, c);
  return json(await storyState(env, out));
}

// ─── AI 상대 전투 ──────────────────────────────────────────────────
// 상대는 같은 예산 공식으로 만들되 tier 로 강함을 조절 (1.0 보통, 1.3 강적, 1.8 보스). 설정은 서술용.
const ENEMIES = [
  ['노정원', '평범한 고등학생', { atk: 15, hp: 25, def: 10, spd: 20, acc: 20, eva: 10 }, 80, ['업어치기', '온 힘을 다해 메친다', 'burst'], '대한민국의 평범한 고등학생. 컴퓨터를 배우고 유도를 한다.', 0.9],
  ['잿빛 검표원', '꿈 열차의 검표원', { atk: 20, hp: 20, def: 10, spd: 20, acc: 20, eva: 10 }, 85, ['검표 찌르기', '표에 구멍을 뚫듯 정확히 찌른다', 'burst'], '시간표에 없는 열차를 지키는 검표원. 규칙에는 엄격하지만 규칙 밖의 일에는 서툴다.', 1],
  ['줄 타는 경비병', '성벽 사이를 나는 병사', { atk: 20, hp: 15, def: 5, spd: 30, acc: 25, eva: 5 }, 80, ['비행 참격', '줄을 타고 순식간에 뒤를 벤다', 'precise'], '꿈의 성벽 사이에 줄을 걸고 날아다니는 경비병. 줄이 끊기면 땅에서는 느리다.', 1],
  ['거울 속 쌍검사', '비친 모습의 검객', { atk: 22, hp: 18, def: 8, spd: 22, acc: 20, eva: 10 }, 75, ['거울 연격', '양손의 검으로 쉴 새 없이 벤다', 'burst'], '거울에서 걸어 나온 쌍검사. 상대의 움직임을 따라 하지만 처음 보는 수에는 늦다.', 1],
  ['물렁 인형 선장', '고무 인형 해적', { atk: 22, hp: 28, def: 12, spd: 15, acc: 13, eva: 10 }, 70, ['튕김 주먹', '몸을 늘였다 튕기며 연타한다', 'burst'], '타격을 튕겨 내는 고무 인형 선장. 날붙이에는 약하다.', 1.1],
  ['길 잃은 세 칼 검객', '세 자루 검의 방랑자', { atk: 28, hp: 20, def: 10, spd: 14, acc: 18, eva: 10 }, 75, ['세 갈래 베기', '세 자루 검을 한꺼번에 휘두른다', 'burst'], '꿈의 미로를 헤매는 검객. 검은 강하지만 길을 늘 잃는다.', 1.1],
  ['침묵의 주문사', '말로 묶는 주술사', { atk: 25, hp: 12, def: 5, spd: 18, acc: 30, eva: 10 }, 65, ['명령어: 멈춰', '한 마디로 상대를 묶지만 목이 상한다', 'precise'], '말 한마디로 꿈을 비튼다. 많이 말할수록 목소리를 잃는다.', 1],
  ['서리불 쌍둥이', '얼음과 불의 아이', { atk: 24, hp: 18, def: 14, spd: 12, acc: 20, eva: 12 }, 80, ['서리불 충돌', '얼음과 불을 함께 쏟아 막아선다', 'shield'], '한쪽은 얼음, 한쪽은 불을 다루는 쌍둥이. 둘이 떨어지면 힘이 반으로 준다.', 1.2],
  ['바람 칼날 병사', '가장 빠른 꿈의 병사', { atk: 24, hp: 14, def: 6, spd: 30, acc: 20, eva: 6 }, 85, ['회오리 베기', '회전하며 순간에 베어낸다', 'precise'], '냉철하고 빠른 검의 병사. 오래 버티는 싸움은 싫어한다.', 1.3],
  ['잠들지 않는 수련자', '끝없이 단련하는 무도가', { atk: 30, hp: 25, def: 10, spd: 15, acc: 12, eva: 8 }, 70, ['기공 파동', '모은 기를 한 번에 쏘아낸다', 'burst'], '꿈속에서도 수련을 멈추지 않는 무도가. 싸움이 길어질수록 신이 난다.', 1.4],
  ['그림자 연인의 주술사', '저주를 안은 주술사', { atk: 25, hp: 20, def: 10, spd: 15, acc: 15, eva: 15 }, 75, ['그림자 포옹', '그림자 연인이 상대를 삼키고 힘을 나눠 준다', 'drain'], '사랑했던 이의 그림자를 데리고 다니는 주술사. 그림자가 지치면 혼자 남는다.', 1.4],
  ['무한 복도의 문지기', '끝나지 않는 복도의 주인', { atk: 25, hp: 15, def: 20, spd: 15, acc: 15, eva: 10 }, 60, ['닫히지 않는 문', '끝없는 복도로 상대를 가둔다', 'shield'], '닿을 수 없는 복도 끝에 선 문지기. 너무 자신만만해 빈틈을 보인다.', 1.8],
];
function makeEnemy(i, scale = 1, label = null) {
  const [name, fiction, alloc, coherence, ult, info, tier] = ENEMIES[i];
  const e = { id: 'enemy-' + i, name, fiction, info, stats: buildStats(alloc, coherence, tier * scale), ult: { name: ult[0], effect: ult[1], style: ult[2] }, tier };
  e.stats.tier = label || (tier >= 1.4 ? '전설' : tier >= 1.1 ? '초인' : tier >= 1 ? '숙련' : '평범');   // 표시용 등급은 원래 강적 등급대로
  return e;
}
// 처음 EASY_FIRST 전은 약한 상대만(강함 ×0.85): 시뮬레이션상 새 캐릭터의 첫 전투 승률이 약 49% 라 손님 캐릭터가 평균 1.4승 만에 사라졌다
const EASY_FIRST = 3, EASY_SCALE = 0.85;
function pickEnemy(c, { nightmare = false } = {}) {
  const scale = Math.sqrt(c.stats.mult || 1);                       // 강한 캐릭터에겐 상대도 조금 강하게 (배율의 제곱근 → 여전히 압도적)
  if (!nightmare && (c.wins || 0) + (c.losses || 0) < EASY_FIRST) {
    const easy = ENEMIES.map((e, i) => [e[6], i]).filter(([t]) => t <= 1);
    return makeEnemy(easy[Math.floor(rnd() * easy.length)][1], scale * EASY_SCALE, '평범');
  }
  const rec = Math.max(0, (c.wins || 0) - (c.losses || 0) - EASY_FIRST);   // 이기고 있으면 강적이 더 자주 (처음 쉬운 3전은 빼고 — 안 그러면 4전째에 강적 확률이 확 뛰어 승률 51%)
  const weights = ENEMIES.map(e => { const t = e[6]; return 1 / (1 + Math.abs(t - (1 + Math.max(0, Math.min(3, rec)) * 0.25)) * 3); });
  let r = rnd() * weights.reduce((s, w) => s + w, 0), idx = 0;
  for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) { idx = i; break; } }
  const e = makeEnemy(idx, scale);
  // 적을 내 현재 능력치에 맞춘다: HP·ATK = 내 값 × 적 강함(0.9~1.8) × (0.72 − 0.18 × 성장도), 방어·속도·명중·회피 = 내 값
  //   예전엔 등급 배율의 제곱근으로만 커져서 숙련 이후 승률 96~100% (긴장감 없음). 배율 지수만 올려선 안 바뀜(m^1.0 도 97~100%) — 플레이어 HP·ATK 는 상한까지 4~8배 크기 때문
  //   시뮬레이션(평범→신화 상한, 100명): 등급 막 올라옴 81~87% → 상한 근처 93~95%, 신화 상한까지 약 19시간. 악몽 초대장은 ×1.3 (승률 62~78%)
  matchToPlayer(e, c, ENEMIES[idx][6] * (nightmare ? NIGHTMARE_X : 1));
  if (nightmare) { e.name = '악몽 · ' + e.name; e.nightmare = true; }
  return e;
}
const ENEMY_K0 = 0.72, ENEMY_KG = 0.18, NIGHTMARE_X = 1.3;
const growthOf = c => { const cap = capsOf(c); return Math.max(0, Math.min(1, (c.stats.hp / cap.hp + c.stats.atk / cap.atk) / 2)); };
function matchToPlayer(e, c, t) {
  const k = t * (ENEMY_K0 - ENEMY_KG * growthOf(c));
  e.stats.hp = Math.max(1, Math.round(c.stats.hp * k)); e.stats.atk = Math.max(1, Math.round(c.stats.atk * k));
  for (const s of ['def', 'spd', 'acc', 'eva']) e.stats[s] = c.stats[s];
}
// 상대 AI: 게이지 차면 필살기(HP 낮을수록 더 자주), 내 HP 가 낮고 상대 게이지가 차 있으면 가끔 방어
function enemyDecide(e, me) {
  if (e.gauge >= ULT_COST && rnd() < (e.hp < e.char.stats.hp * 0.5 ? 0.85 : 0.5)) return { type: 'ult', text: `${e.char.ult?.name || '필살기'}! ${e.char.ult?.effect || ''}`.trim() };
  if (me.gauge >= ULT_COST && e.hp < e.char.stats.hp * 0.4 && rnd() < 0.35) return { type: 'defend', text: '자세를 낮추고 상대의 다음 수를 기다린다' };
  return { type: 'attack', text: '' };
}

async function createBattle(body, env) {
  let c = await loadChar(env, body.charId, body.token);
  if (!c) return json({ error: 'forbidden' }, 403);
  await env.DB.prepare('DELETE FROM rpg_battles WHERE updated < ?').bind(Date.now() - BATTLE_TTL).run();
  let foe, mode = body.mode === 'auto' ? 'auto' : 'pve', foeId = null;
  if (mode === 'auto') {
    const row = await env.DB.prepare('SELECT id, json FROM rpg_chars WHERE auto = 1 AND id != ? ORDER BY RANDOM() LIMIT 1').bind(c.id).first();
    if (!row) return json({ error: 'no_auto' }, 404);
    foe = JSON.parse(row.json); foeId = row.id; foe.tier = 1;
  }
  const items = [...new Set((Array.isArray(body.items) ? body.items : []).filter(k => BAG_ITEMS.includes(k)))].slice(0, BAG_SLOTS);
  const nightmare = mode === 'pve' && !!body.nightmare;
  if (items.length || nightmare) {   // 가져갈 물건은 전투 시작 때 차감 (최신 DB 값 기준)
    let bad = false;
    c = await updateChar(env, c.id, x => { bad = false; const b = x.bag || {}; if (items.some(k => !(b[k] > 0)) || (nightmare && !(b.nightmare > 0))) { bad = true; return; } for (const k of items) b[k]--; if (nightmare) b.nightmare--; x.bag = b; }, c);
    if (bad) return json({ error: 'no_item' }, 409);
  }
  if (mode !== 'auto') foe = pickEnemy(c, { nightmare });
  const st = { id: uid(), charId: c.id, mode, foeId, me: { char: c, hp: c.stats.hp, gauge: 0, guard: false }, foe: { char: foe, hp: foe.stats.hp, gauge: 0, guard: false }, turn: 1, log: [], status: 'playing', winner: null };
  applyBag(st, items); if (nightmare) st.nightmare = true;
  applyCond(st, c);
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
// 승리 보상: HP·ATK 는 매번, 방어·속도·명중·회피는 각각 35% 확률로 +1(대성공이면 +2). 상한: 방어 60% · 속도 120 · 명중 99 · 회피 50
const STAT_CAP = { def: 60, spd: 120, acc: 99, eva: 50 }, STAT_KO = { def: '방어', spd: '속도', acc: '명중', eva: '회피' };
function rollReward(c, foe, mode) {
  const mult = (c.stats.mult || 1), ft = (TIER_IDX[foe.stats?.tier] ?? 1), scale = mult * (1 + ft * 0.25) * (mode === 'auto' ? 1.3 : 1);
  const r = { hp: Math.round((10 + rnd() * 20) * scale), atk: Math.round((1 + rnd() * 3) * scale), stats: {}, tags: [] };
  const big = rnd() < 0.05; if (big) { r.hp *= 2; r.atk *= 2; r.tags.push('대성공'); }
  for (const k of ['def', 'spd', 'acc', 'eva']) if (rnd() < 0.35 + (big ? 0.3 : 0)) { r.stats[k] = big ? 2 : 1; r.tags.push(`${STAT_KO[k]} +${r.stats[k]}${k === 'def' ? '%' : ''}`); }
  return r;
}
// 도망: 성공 확률 = 내 속도·회피가 상대보다 높을수록 ↑, 등급이 높을수록 ↓(체면·추격). 실패하면 패배로 기록되고 HP·ATK 를 조금 잃는다(등급이 높을수록 잃는 양이 큼)
const TIER_IDX = { '평범': 0, '숙련': 1, '초인': 2, '전설': 3, '신화': 4, '???': 5 };
function escapeRoll(me, foe, bonus = 0, halfLoss = bonus > 0) {
  const t = TIER_IDX[me.char.stats.tier] ?? 0, ft = TIER_IDX[foe.char.stats.tier] ?? 1;
  const p = 0.75 + (me.char.stats.spd - foe.char.stats.spd) / 120 + me.char.stats.eva / 200 - t * 0.06 + (ft - t) * 0.04 - (me.hp < me.char.stats.hp * 0.3 ? 0.1 : 0);
  const chance = Math.min(0.95, Math.max(0.2, p + bonus));
  const ok = rnd() < chance;
  if (ok) return { ok, chance: Math.round(chance * 100) };
  const sev = (1 + t * 0.6) * (halfLoss ? 0.5 : 1);                             // 등급별 손실 배율 (평범 1 → 신화 3.4 → ??? 4.0), 연막 구름이면 절반
  const hp = Math.round(me.char.stats.hp * (0.02 + rnd() * 0.04) * sev), atk = Math.round(me.char.stats.atk * (0.01 + rnd() * 0.03) * sev);
  return { ok, chance: Math.round(chance * 100), penalty: { hp, atk } };
}
async function leaveBattle(id, body, env) {
  const row = await env.DB.prepare('SELECT state, updated FROM rpg_battles WHERE id = ?').bind(id).first();
  if (!row) return json({ ok: true, escaped: true });
  const st = JSON.parse(row.state);
  const c0 = await loadChar(env, st.charId, body.token);
  if (!c0) return json({ error: 'forbidden' }, 403);
  if (isBusy(st)) return json({ error: 'retry' }, 409);   // 턴 판정 중 — 끝난 뒤에
  // 낙관적 잠금: 같은 순간 턴이 진행됐으면(updated 변경) 지우지 않고 다시 (턴 결과와 도망 판정이 둘 다 적용되는 일 방지)
  const del = await env.DB.prepare('DELETE FROM rpg_battles WHERE id = ? AND updated = ?').bind(id, row.updated).run();
  if (del.meta.changes !== 1) return json({ error: 'retry' }, 409);
  let result = { ok: true, escaped: true };
  if (st.mode === 'story') {   // 스토리 전투에서 도망 = 꿈에서 깸 (이번 회차 끝, 조각 절반)
    const out = await updateChar(env, c0.id, x => { if (x.story?.run?.battleId === st.id) endRun(x, 'fled'); }, c0);
    return json({ ok: true, escaped: true, story: true, char: publicChar(out), message: '꿈에서 깨어났습니다. 이번 회차에서 모은 꿈 조각은 절반만 남습니다.' });
  }
  if (st.status === 'playing' && st.log.length) {                         // 한 턴이라도 싸운 뒤의 도망만 판정 (시작 직후엔 자유)
    const r = escapeRoll(st.me, st.foe, (st.items?.smoke ? 0.25 : 0) - (st.fleePenalty || 0), !!st.items?.smoke);
    if (!r.ok) {
      const c = await updateChar(env, c0.id, x => {
        x.losses++; x.stats.hp = Math.max(200, x.stats.hp - r.penalty.hp); x.stats.atk = Math.max(20, x.stats.atk - r.penalty.atk);
        if (st.mode === 'auto') x.autoLosses = (x.autoLosses || 0) + 1;
      }, c0);
      if (st.mode === 'auto' && st.foeId) await recordAutoResult(env, { ...st, winner: 2 }, c);   // 자동 생사결 상대에게 붙잡힘 = 상대 승리로 기록
      result = { ok: true, escaped: false, chance: r.chance, penalty: r.penalty, char: publicChar(c), message: `도망치다 ${st.foe.char.name}에게 붙잡혔다! 패배 기록 · HP 최대치 -${r.penalty.hp} · ATK -${r.penalty.atk}` };
    } else result = { ok: true, escaped: true, chance: r.chance, message: `${st.foe.char.name}을(를) 따돌리고 도망쳤다. (성공 확률 ${r.chance}%)` };
  }
  return json(result);
}
async function battleTurn(id, body, env, ip) {
  const row = await env.DB.prepare('SELECT state, updated FROM rpg_battles WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'no_battle' }, 404);
  const st = JSON.parse(row.state);
  const c = await loadChar(env, st.charId, body.token);
  if (!c) return json({ error: 'forbidden' }, 403);
  if (st.status !== 'playing') return json({ battle: st });
  if (isBusy(st)) return json({ error: 'retry' }, 409);   // 다른 요청(다른 탭·더블 클릭)이 이 턴을 처리 중
  if (body.type === 'item' && !(st.items?.bandage > 0)) return json({ error: 'no_item' }, 409);
  // 낙관적 잠금: 같은 턴을 두 번 처리하지 않게 — busy 표시를 같이 써서, 처리 중(AI 서술 수 초) 들어온 요청도 막는다
  st.busy = Date.now();
  const lock = await env.DB.prepare('UPDATE rpg_battles SET state = ?, updated = ? WHERE id = ? AND updated = ?').bind(JSON.stringify(st), st.busy, id, row.updated).run();
  if (lock.meta.changes !== 1) return json({ error: 'retry' }, 409);
  delete st.busy;
  let actMe;
  if (body.type === 'item') {   // 꿈결 붕대: 이번 턴 행동 대신 최대 HP 25% 회복
    st.items.bandage--; const heal = Math.max(0, Math.min(st.me.char.stats.hp - st.me.hp, Math.round(st.me.char.stats.hp * 0.25)));
    st.me.hp += heal; actMe = { type: 'item', text: '', heal, item: '꿈결 붕대', target: 2 };
  } else actMe = { ...await parseActSafe(body, env), target: 2, local: body.local };
  const actFoe = { ...enemyDecide(st.foe, st.me), target: 1 };
  const prevLog = st.log[st.log.length - 1];
  const t = await runRound(env, ip, { 1: st.me, 2: st.foe }, { 1: actMe, 2: actFoe }, { round: st.turn, prev: prevLog ? factsText({ 1: st.me.char.name, 2: st.foe.char.name }, prevLog.events).replace(/\n/g, ' / ') : '', noNarrate: st.mode === 'story' && !st.boss });   // 스토리 잡몹 전투는 서술 AI 생략 (챕터당 호출 예산)
  delete actMe.local;
  const plaus = await applyPlaus(env, { 1: st.me }, { 1: actMe }, t.judge, [1]);
  st.log.push({ turn: st.turn, acts: { 1: actMe, 2: actFoe }, judge: t.judge, order: t.order, events: t.events, narration: t.narration, ai: t.usedAi, provider: t.provider, narrateUser: t.narrateUser, plaus });
  if (st.log.length > 40) st.log.shift();
  if (st.me.hp <= 0 || st.foe.hp <= 0) {
    st.status = 'finished'; st.winner = st.me.hp <= 0 ? 2 : 1;
    if (st.mode === 'story') await storyBattleEnd(env, st, c);
    else {
    const fresh = await updateChar(env, c.id, x => {   // AI 서술을 기다리는 동안 다른 곳(cron·방)이 저장한 전적 위에 적용
      if (st.winner === 1) {
        x.wins++;
        st.reward = rollReward(x, st.foe.char, st.mode); applyReward(x, st.reward);
        if (st.mode === 'auto') { x.autoWins = (x.autoWins || 0) + 1; x.pvpWins = (x.pvpWins || 0) + 0.5; }
        // 꿈 조각: AI 전투 10 + 4 × 상대 등급(악몽이면 ×2.5), 자동 생사결 상대 12, 하루 첫 승 +20
        const base = st.mode === 'auto' ? 12 : (10 + 4 * (TIER_IDX[st.foe.char.stats?.tier] ?? 1)) * (st.nightmare ? 2.5 : 1);
        st.dream = earnDream(x, base + dailyFirst(x));
      } else {
        x.losses++; if (st.mode === 'auto') x.autoLosses = (x.autoLosses || 0) + 1;
        // 깨지 않는 꿈: AI 전투에서 지면 자동으로 써서 캐릭터를 지킨다 (HP·ATK 최대치 −5%)
        st.saved = undefined;
        if (st.mode === 'pve' && !st.nightmare && (x.bag?.insurance || 0) > 0) { x.bag.insurance--; x.stats.hp = Math.round(x.stats.hp * 0.95); x.stats.atk = Math.round(x.stats.atk * 0.95); st.saved = true; }
      }
      condAfter(x, st);   // 흔적: 부상·흉터·피로·연승·상대 기억
    }, c);
    st.me.char = publicChar(fresh);   // 화면용 요약(흔적·상한) 포함
    if (st.mode === 'auto' && st.foeId) await recordAutoResult(env, st, fresh);
    // 기획: AI 전투에서 지면 캐릭터가 사라진다 → 손님(계정 없는) 캐릭터는 서버에서도 삭제. 계정 캐릭터는 목록에 남김. 자동 생사결 상대와의 전투·악몽 초대장·깨지 않는 꿈은 예외
    if (st.winner === 2 && st.mode === 'pve' && !st.nightmare && !st.saved) {
      const del = await env.DB.prepare('DELETE FROM rpg_chars WHERE id = ? AND user_sub IS NULL').bind(c.id).run();
      if (del.meta.changes) { st.deleted = true; lbCache.at = 0; }
    }
    }
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
  const { tokens, who, ips, ...rest } = s;
  rest.p = {}; for (const k in s.p) { const pl = s.p[k], ch = pl.char || {}; rest.p[k] = { ...pl, char: { name: ch.name, fiction: ch.fiction, stats: ch.stats, ult: ch.ult, tier: ch.tier, relic: ch.relic } }; }
  rest.log = s.log.map((l, i) => i < s.log.length - 2 && l.narrateUser ? { ...l, narrateUser: undefined } : l);   // 최근 2라운드만 로컬 서술 프롬프트 포함 (폴링 응답 크기)
  const moves = {}; for (const k in s.p) moves[k] = !!s.moves[k];
  const firstAt = Math.min(...Object.values(s.moves).map(m => m.at || Infinity));
  return { ...rest, you: slot, moves, myMove: s.moves[slot] || null, waitingSince: Number.isFinite(firstAt) ? firstAt : null, max: ROOM_MAX };
}
async function createRoom(body, env, isPublic = false, who = null, ip = null) {
  const c = await loadChar(env, body.charId, body.token);
  if (!c) return json({ error: 'forbidden' }, 403);
  await env.DB.prepare('DELETE FROM rpg_rooms WHERE updated < ?').bind(Date.now() - ROOM_TTL).run();
  const code = code6(), rt = uid(), now = Date.now();
  const s = { code, host: 1, p: { 1: { char: c, hp: c.stats.hp, gauge: 0, guard: false, afk: 0 } }, tokens: { 1: rt }, who: { 1: who }, ips: { 1: ip }, round: 0, moves: {}, log: [], status: 'waiting', winner: null, public: isPublic || undefined };
  await env.DB.prepare('INSERT INTO rpg_rooms (code, created, updated, state) VALUES (?, ?, ?, ?)').bind(code, now, now, JSON.stringify(s)).run();
  return json({ code, roomToken: rt, slot: 1, state: pub(s, 1) });
}
// 랜덤 대전(1:1): 최근 2분 안에 만들어진 공개 대기 방 중 하나에 들어가 바로 시작. 없으면 공개 방을 만들고 기다린다 (방장 시작 불필요)
const MATCH_FRESH_MS = 2 * 60e3;
async function matchRoom(body, env, who = null, ip = null) {
  const c = await loadChar(env, body.charId, body.token);
  if (!c) return json({ error: 'forbidden' }, 403);
  const rows = await env.DB.prepare('SELECT code, state, updated FROM rpg_rooms WHERE updated > ? ORDER BY updated ASC LIMIT 30').bind(Date.now() - MATCH_FRESH_MS).all();
  const open = [];
  for (const row of (rows?.results || [])) {
    let s; try { s = JSON.parse(row.state); } catch { continue; }
    if (!s.public || s.status !== 'waiting' || Object.keys(s.p).length !== 1) continue;
    const k = Number(Object.keys(s.p)[0]);
    if (s.p[k].char.id === c.id) return json({ code: s.code, roomToken: s.tokens[k], slot: k, state: pub(s, k), rejoined: true });   // 내가 만든 대기 방이 있으면 (남의 방보다 먼저) 거기로 — 내 방이 고아가 되지 않게
    open.push([row, s, k]);
  }
  for (const [row, s, k] of open) {
    const rt = uid(), slot = k === 1 ? 2 : 1;
    s.p[slot] = { char: c, hp: c.stats.hp, gauge: 0, guard: false, afk: 0 }; s.tokens[slot] = rt; (s.who ||= {})[slot] = who; (s.ips ||= {})[slot] = ip;
    s.status = 'playing'; s.round = 1;   // 둘이 모이면 바로 시작
    if (await saveRoom(env, s.code, s, row.updated)) return json({ code: s.code, roomToken: rt, slot, state: pub(s, slot), matched: true });
    // 동시에 다른 사람이 들어갔으면 다음 방으로
  }
  return createRoom(body, env, true, who, ip);
}
async function joinRoom(code, body, env, who = null, ip = null) {
  const c = await loadChar(env, body.charId, body.token);
  if (!c) return json({ error: 'forbidden' }, 403);
  const r = await loadRoom(env, code);
  if (!r) return json({ error: 'no_room' }, 404);
  const s = r.s;
  // 같은 캐릭터가 다시 오면 (새로고침·앱 전환) 기존 자리로 재접속 — 캐릭터 토큰으로 본인 확인됨
  const mine = Object.keys(s.p).find(k => s.p[k].char.id === c.id && s.tokens[k]);   // (끝난 방에서 이미 나간 자리는 토큰이 없다)
  if (mine) return json({ code, roomToken: s.tokens[mine], slot: Number(mine), state: pub(s, Number(mine)), rejoined: true });
  if (s.status !== 'waiting') return json({ error: 'started' }, 409);
  if (s.public) return json({ error: 'no_room' }, 404);   // 랜덤 매칭용 공개 방은 코드로 못 들어감
  if (Object.keys(s.p).length >= ROOM_MAX) return json({ error: 'full' }, 409);
  const slot = [1, 2, 3, 4, 5, 6].find(k => !s.p[k]), rt = uid();
  s.p[slot] = { char: c, hp: c.stats.hp, gauge: 0, guard: false, afk: 0 }; s.tokens[slot] = rt; (s.who ||= {})[slot] = who; (s.ips ||= {})[slot] = ip;
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
  if (isBusy(s)) return json({ state: pub(s, slot) });   // 이 라운드는 이미 판정 중 (전원 제출됨) — 건너뛰기도 불필요
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
  s.busy = Date.now();
  const v2 = await saveRoom(env, code, s, v);   // 낙관적 잠금: 동시 요청 중 하나만 판정 (busy 가 남아 있는 동안 다른 요청은 기다린다)
  if (!v2) return json({ error: 'retry' }, 409);
  let quotaBlocked = null;
  if (alive.length > 1) {
    const prevLog = s.log[s.log.length - 1], nm = {}; for (const k in s.p) nm[k] = s.p[k].char.name;
    const payers = aliveSlots(s.p).map(k => s.who?.[k]).filter(Boolean);   // 살아 있는 참가자 전원이 1/N 씩 (몫 주인을 모르는 옛 방이면 판정 요청자)
    const t = await runRound(env, payers.length ? payers : ip, s.p, s.moves, { round: s.round, prev: prevLog ? factsText(nm, prevLog.events).replace(/\n/g, ' / ') : '' });
    const acts = {}; for (const k in s.moves) { const { local, ...a } = s.moves[k]; acts[k] = a; }
    const plaus = await applyPlaus(env, s.p, acts, t.judge, Object.keys(acts).map(Number));
    s.log.push({ round: s.round, acts, judge: t.judge, order: t.order, events: t.events, narration: t.narration, ai: t.usedAi, provider: t.provider, narrateUser: t.narrateUser, resolver: slot, plaus });
    if (s.log.length > 40) s.log.shift();
    quotaBlocked = t.quotaBlocked;
  }
  const left = aliveSlots(s.p);
  if (left.length <= 1) {
    s.status = 'finished'; s.winner = left[0] || 0;
    const who = Object.values(s.who || {}), ips = Object.values(s.ips || {});
    s.unranked = !s.log.length ? 'no_round' : (new Set(who).size < who.length || new Set(ips).size < ips.length) ? 'same_player' : undefined;
    if (!s.unranked) for (const k in s.p) {   // 입장 때 스냅샷이 아니라 지금 DB 의 캐릭터에 전적을 더한다 (방에 있는 동안 PvE·cron 으로 바뀐 것을 지우지 않게)
      // 모두 쓰러지면 무승부: 마지막 라운드까지 서 있던 사람은 무승부로 기록, 그 전에 쓰러졌거나 기권한 사람은 패배
      const won = s.winner === Number(k), draw = s.winner === 0 && alive.includes(Number(k)) && !s.p[k].left;
      s.p[k].char = await updateChar(env, s.p[k].char.id, c => { if (won) { c.wins++; c.pvpWins = (c.pvpWins || 0) + 1; if (!dayCount(c, 'pvpScore', 10)) c.pvpCapped = (c.pvpCapped || 0) + 1; earnDream(c, (dayCount(c, 'online', 3) ? 15 : 0) + dailyFirst(c)); } else if (draw) { c.draws = (c.draws || 0) + 1; c.pvpDraws = (c.pvpDraws || 0) + 1; } else { c.losses++; c.pvpLosses = (c.pvpLosses || 0) + 1; } }, s.p[k].char);
    }
  } else s.round++;
  s.moves = {}; delete s.busy;
  if (!(await saveRoom(env, code, s, v2))) return json({ error: 'retry' }, 409);   // busy 중엔 아무도 쓰지 않으므로 실패는 90초 넘게 걸려 다른 요청이 넘겨받은 경우뿐
  return json({ state: pub(s, slot), quota: pubQuota(await quota(env, ip)), quotaBlocked });
}
async function leaveRoom(code, body, env, ip) {
  let r = await loadRoom(env, code);
  if (!r) return json({ ok: true, gone: true });
  if (!slotOf(r.s, body.token)) return json({ error: 'forbidden' }, 403);
  for (let i = 0; i < 12 && r.s.status === 'playing' && isBusy(r.s); i++) {   // 라운드 판정 중이면 끝날 때까지 잠깐 기다림 (최대 ~10초, 클라이언트가 한 번 더 재시도)
    await sleep(800); r = await loadRoom(env, code); if (!r) return json({ ok: true, gone: true });
  }
  const s = r.s, slot = slotOf(s, body.token);
  if (!slot) return json({ error: 'forbidden' }, 403);
  if (s.status === 'waiting' || s.status === 'finished') {
    delete s.tokens[slot];
    if (s.status === 'waiting') delete s.p[slot];   // 끝난 방은 자리를 남긴다 — 아직 결과를 못 본 사람의 화면에 승자가 계속 보이게
    else s.p[slot].gone = true;
    const rest = Object.keys(s.tokens).map(Number).sort((a, b) => a - b);
    if (!rest.length) { await env.DB.prepare('DELETE FROM rpg_rooms WHERE code = ?').bind(code).run(); return json({ ok: true, gone: true }); }
    if (s.host === slot) s.host = rest[0];   // 방장 승계
    if (!(await saveRoom(env, code, s, r.v))) return json({ error: 'retry' }, 409);
    return json({ ok: true });
  }
  if (isBusy(s)) return json({ error: 'retry' }, 409);
  // 진행 중 나가기 = 기권 (패배 기록). 남은 사람들끼리 계속. 나 때문에 막혀 있던 라운드라면 바로 판정
  if (s.p[slot].hp > 0) forfeit(s, slot, 'left');   // 패배 기록은 방이 끝날 때 한 번에 (이중 집계 방지)
  delete s.moves[slot];
  return settleRoom(env, ip, code, s, r.v, slot);
}
