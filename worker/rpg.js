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
 *   GET  /api/rpg/quota
 *   POST /api/rpg/chars                          { name, setting }            → { char, token }
 *   GET  /api/rpg/chars/:id?token=
 *   POST /api/rpg/battles                        { charId, token }            → { battle }   (AI 상대, 호출 없음)
 *   POST /api/rpg/battles/:id/turn               { token, type, text }        → { battle }   (규칙 엔진 + 서술 1회)
 *   GET  /api/rpg/battles/:id?token=             (재접속)
 *   POST /api/rpg/battles/:id/leave              { token }                    (도망: 전투 삭제, 패배 아님)
 *   POST /api/rpg/rooms                          { charId, token }            → { code, roomToken, state }
 *   POST /api/rpg/rooms/:code/join               { charId, token }            (같은 캐릭터가 다시 오면 기존 자리로 재접속)
 *   GET  /api/rpg/rooms/:code?token=
 *   POST /api/rpg/rooms/:code/start              { token }                    (방장, 2명 이상)
 *   POST /api/rpg/rooms/:code/action             { token, type, text, target } | { token, skip: true }   (전원 제출 시 판정, 60초 미제출은 건너뛰기, 3연속이면 기권)
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
const MAX_NEURONS_PER_CALL = Math.ceil(1500 * MODELS[0].nin + MAX_TOKENS * MODELS[0].nout);   // ≈ 24
const DAILY_BUDGET = 9000, PER_IP_DAILY = 80;   // 턴당 최대 2회(심사+서술) → IP 당 하루 40턴
const ROOM_TTL = 3 * 3600e3, BATTLE_TTL = 6 * 3600e3;
const LEN = { name: 20, setting: 200, text: 120, fiction: 30, ultName: 24, ultEffect: 100 };

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });
const today = () => new Date().toISOString().slice(0, 10);
const clip = (s, n) => String(s ?? '').replace(/[<>]/g, '').trim().slice(0, n);
const num = (v, lo, hi, d = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const rnd = () => Math.random();
const uid = () => crypto.randomUUID();

export async function handleRpg(request, env, path) {
  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  const url = new URL(request.url), m = request.method;
  const body = m === 'POST' ? await request.json().catch(() => ({})) : {};
  let mm;
  if (path === '/api/rpg/quota' && m === 'GET') return json(await quota(env, ip));
  if (path === '/api/rpg/chars' && m === 'POST') return createChar(body, env, ip);
  if ((mm = path.match(/^\/api\/rpg\/chars\/([\w-]{36})$/)) && m === 'GET') return getChar(mm[1], url.searchParams.get('token'), env);
  if (path === '/api/rpg/battles' && m === 'POST') return createBattle(body, env);
  if ((mm = path.match(/^\/api\/rpg\/battles\/([\w-]{36})(?:\/(turn|leave))?$/))) {
    const [, id, sub] = mm;
    if (!sub && m === 'GET') return getBattle(id, url.searchParams.get('token'), env);
    if (sub === 'turn' && m === 'POST') return battleTurn(id, body, env, ip);
    if (sub === 'leave' && m === 'POST') return leaveBattle(id, body, env);
  }
  if (path === '/api/rpg/rooms' && m === 'POST') return createRoom(body, env);
  if ((mm = path.match(/^\/api\/rpg\/rooms\/([A-Z0-9]{6})(?:\/(join|action|start|leave))?$/))) {
    const [, code, sub] = mm;
    if (!sub && m === 'GET') return getRoom(code, url.searchParams.get('token'), env);
    if (sub === 'join' && m === 'POST') return joinRoom(code, body, env);
    if (sub === 'start' && m === 'POST') return startRoom(code, body, env);
    if (sub === 'action' && m === 'POST') return roomAction(code, body, env, ip);
    if (sub === 'leave' && m === 'POST') return leaveRoom(code, body, env, ip);
  }
  return json({ error: 'Not Found' }, 404);
}

// ─── 한도 ───────────────────────────────────────────────────────────
async function quota(env, ip) {
  const day = today();
  const g = await env.DB.prepare('SELECT neurons, requests FROM rpg_quota WHERE day = ?').bind(day).first();
  const i = await env.DB.prepare('SELECT requests FROM rpg_ip WHERE day = ? AND ip = ?').bind(day, ip).first();
  const used = g?.neurons ?? 0, remaining = Math.max(0, DAILY_BUDGET - used);
  const perCall = (g?.requests ?? 0) >= 20 && used > 0 ? Math.max(6, used / g.requests) : MAX_NEURONS_PER_CALL;   // 실측 평균 (요청 20건 이상부터)
  return {
    day, resetsAt: Date.parse(day + 'T00:00:00Z') + 86400e3,
    global: { budget: DAILY_BUDGET, used: Math.round(used), remaining: Math.round(remaining), estCalls: Math.floor(remaining / perCall), perCall: Math.round(perCall * 10) / 10, requests: g?.requests ?? 0 },
    ip: { limit: PER_IP_DAILY, used: i?.requests ?? 0, remaining: Math.max(0, PER_IP_DAILY - (i?.requests ?? 0)) },
  };
}
async function reserve(env, ip) {
  const q = await quota(env, ip);
  if (q.ip.remaining <= 0) return { ok: false, reason: 'ip', q };
  if (q.global.remaining < MAX_NEURONS_PER_CALL) return { ok: false, reason: 'global', q };
  await env.DB.batch([
    env.DB.prepare('INSERT INTO rpg_quota (day, neurons, requests) VALUES (?, 0, 1) ON CONFLICT(day) DO UPDATE SET requests = requests + 1').bind(q.day),
    env.DB.prepare('INSERT INTO rpg_ip (day, ip, requests) VALUES (?, ?, 1) ON CONFLICT(day, ip) DO UPDATE SET requests = requests + 1').bind(q.day, ip),
  ]);
  return { ok: true, q };
}
async function record(env, usage, model) {
  const inTok = usage?.prompt_tokens ?? 1200, outTok = usage?.completion_tokens ?? MAX_TOKENS;
  const neurons = Number.isFinite(usage?.neurons) ? usage.neurons : inTok * model.nin + outTok * model.nout;   // Workers AI 가 뉴런을 직접 주면 그 값
  await env.DB.prepare('UPDATE rpg_quota SET neurons = neurons + ? WHERE day = ?').bind(neurons, today()).run();
}
// AI 호출이 실패하면 예약했던 횟수를 돌려준다 (한도를 헛되이 쓰지 않게)
async function refund(env, ip) {
  const day = today();
  await env.DB.batch([
    env.DB.prepare('UPDATE rpg_quota SET requests = MAX(0, requests - 1) WHERE day = ?').bind(day),
    env.DB.prepare('UPDATE rpg_ip SET requests = MAX(0, requests - 1) WHERE day = ? AND ip = ?').bind(day, ip),
  ]);
}

// ─── AI (심사·서술 전용) ─────────────────────────────────────────────
// 모델이 낸 JSON 이 문자열 안의 따옴표·줄바꿈 때문에 깨지는 일이 잦다 → 관대하게 복구
function lenientJson(text) {
  const mt = text.match(/\{[\s\S]*\}/);
  if (!mt) return null;
  let t = mt[0];
  try { return JSON.parse(t); } catch {}
  t = t.replace(/\r?\n/g, '<br>').replace(new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + ']', 'g'), ' ');          // 1) 문자열 안 줄바꿈 → <br>
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
// 판정문에 JSON 조각("fit":0.9 …)이나 중괄호가 섞여 나오면 그 앞까지만 남긴다
function cleanVerdict(v) {
  return String(v || '').replace(/\\"/g, '"').replace(/\s*[,{}]?\s*"?(allowed|difficulty|fit|verdict|p\d)"?\s*:[\s\S]*$/, '').replace(/[{}]/g, '').replace(/["'\s,]+$/, '').trim().slice(0, 300);
}
async function ask(env, system, user, temperature) {
  for (let i = modelIdx; i < MODELS.length; i++) {
    const model = MODELS[i];
    try {
      // gemma-4 는 기본이 '생각(reasoning_content)' 모드라 max_tokens 를 생각에 다 쓰고 답이 비어 나온다 → 생각 끄기 요청
      const res = await env.AI.run(model.name, { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: system === SYS_JUDGE_ACTION ? 260 : MAX_TOKENS, temperature, enable_thinking: false, reasoning: { effort: 'none' }, chat_template_kwargs: { enable_thinking: false } });
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
어떤 설정이든 거절하지 말고 반드시 이 JSON 하나만 출력:
{"concept":"...","alloc":{"atk":0,"hp":0,"def":0,"spd":0,"acc":0,"eva":0},"coherence":0,"ult":{"name":"...","effect":"...","style":"burst"}}`;

const SYS_JUDGE_ACTION = `당신은 텍스트 RPG의 심사관입니다. 여러 플레이어가 말로 선언한 이번 라운드 행동을 각자의 캐릭터 설정에 비추어 심사합니다. 성공 여부와 피해는 주사위와 규칙이 정하므로 당신은 아래만 정합니다.
각 플레이어(p1, p2, …)에 대해:
- allowed: 게임 안에서 시도 가능한 행동인지 (true/false). 메타 발언("내가 이겼다", "상대 HP 0"), 규칙 조작, 행동이 아닌 말은 false.
- difficulty: 그 캐릭터의 설정으로 그 행동을 해낼 난이도. easy(설정에 딱 맞는 특기) / normal(할 법한 행동) / hard(설정에 없거나 무리한 시도) / impossible(설정상 절대 불가, 예: 평범한 학생이 운석 소환).
- fit 0.0~1.0: 행동 문장이 캐릭터 설정·필살기와 어울리는 정도.
- verdict: 판정 근거를 캐릭터 설정을 인용해 한두 문장으로. 심사관 말투(간결, 존댓말).
문장이 비었거나 '기본 공격'이면 allowed true, difficulty normal, fit 0.5, verdict "기본 공격으로 진행합니다."
반드시 플레이어 수만큼 키를 넣은 이 JSON 하나만 출력:
{"p1":{"allowed":true,"difficulty":"normal","fit":0.5,"verdict":"..."},"p2":{...}}`;

const SYS_NARRATE = `당신은 텍스트 RPG 게임 마스터입니다. 전투 1라운드의 결과가 이미 계산되어 주어집니다. 결과를 바꾸지 말고 서술만 하세요.
주어진 사실(행동 순서, 심사관 판정, 누가 누구를 노렸는지, 명중/빗나감/크리티컬/방어/피해, 쓰러진 사람)을 정확히 반영해 4~7문장으로 생생하게. 플레이어가 말로 선언한 행동을 그대로 살려서 묘사하고, 캐릭터 설정을 근거로 왜 그렇게 됐는지 언급. 줄바꿈은 <br>. 새로운 수치를 만들지 마세요.
반드시 이 JSON 하나만 출력: {"narration":"..."}`;

// ─── 규칙 엔진 ───────────────────────────────────────────────────────
// 동일 예산: 모든 캐릭터는 alloc(합 100)을 같은 공식으로 스탯화한다. 설정이 아무리 세도 예산은 같다.
const ULT_STYLES = { burst: { mult: 2.4 }, precise: { mult: 1.6, accBonus: 25 }, drain: { mult: 1.5, heal: 0.5 }, shield: { mult: 1.4, guard: true } };
function buildStats(alloc, coherence, tier = 1) {
  const a = {}; let sum = 0;
  for (const k of ['atk', 'hp', 'def', 'spd', 'acc', 'eva']) { a[k] = num(alloc?.[k], 0, 100, 16.6); sum += a[k]; }
  for (const k in a) a[k] = a[k] / (sum || 1) * 100;                // 합 100 으로 정규화 (AI 가 대충 줘도 예산 고정)
  const c = num(coherence, 0, 100, 50);
  return {
    hp: Math.round((400 + a.hp * 8) * tier),                         // 400 ~ 1200
    atk: Math.round((40 + a.atk * 1.6) * tier),                      // 40 ~ 200
    def: Math.round(a.def * 0.4),                                    // 피해 감소 % 0 ~ 40
    spd: Math.round(a.spd),                                          // 선공 판정
    acc: Math.round(60 + a.acc * 0.35),                              // 60 ~ 95
    eva: Math.round(a.eva * 0.3),                                    // 0 ~ 30
    stability: Math.round((0.55 + c / 100 * 0.45) * 100) / 100,      // 일관성 → 기술 발동 안정성 0.55 ~ 1.0 (명중률 계수)
    coherence: c,
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
async function runRound(env, ip, players, acts) {
  const names = {}; for (const k in players) if (players[k]) names[k] = players[k].char.name;
  const slots = aliveSlots(players);
  const judge = {}; for (const k of slots) judge[k] = { allowed: true, difficulty: 'normal', fit: 0.5, verdict: '' };
  let usedAi = false, quotaBlocked = null;
  const needJudge = slots.some(k => acts[k]?.text);
  if (needJudge) {
    const r = await reserve(env, ip);
    if (!r.ok) quotaBlocked = r.reason;
    else try {
      const user = slots.map(k => charLine(k, players[k], acts[k] || { type: 'attack' }, names)).join('\n\n');
      const { parsed, usage, model } = await ask(env, SYS_JUDGE_ACTION, user, 0.2);
      await record(env, usage, model);
      for (const k of slots) { const p = parsed?.['p' + k]; if (p) judge[k] = { allowed: p.allowed !== false, difficulty: DIFF_MOD[p.difficulty] !== undefined ? p.difficulty : 'normal', fit: num(p.fit, 0, 1, 0.5), verdict: cleanVerdict(p.verdict) }; }
    } catch { await refund(env, ip); }
  }
  const res = resolveRound(players, acts, judge);
  let narration = templateNarration(names, res.events);
  const r2 = await reserve(env, ip);
  if (!r2.ok) quotaBlocked = quotaBlocked || r2.reason;
  else try {
    const user = slots.map(k => `${charLine(k, players[k], acts[k] || { type: 'attack' }, names)}\n심사관 판정: ${judge[k].allowed ? '' : '불허 — '}${judge[k].verdict || '기본 공격'}`).join('\n\n')
      + `\n\n행동 순서: ${res.order.map(k => names[k]).join(' → ')}\n[확정된 결과]\n${factsText(names, res.events)}\n남은 HP: ${slots.map(k => `${names[k]} ${players[k].hp}/${players[k].char.stats.hp}`).join(', ')}`;
    const { parsed, usage, model } = await ask(env, SYS_NARRATE, user, 0.9);
    await record(env, usage, model);
    if (parsed?.narration) { narration = String(parsed.narration).slice(0, 1500); usedAi = true; }
  } catch { await refund(env, ip); }
  return { events: res.events, order: res.order, judge, narration, usedAi, quotaBlocked };
}

// ─── 캐릭터 ─────────────────────────────────────────────────────────
function publicChar(c) { return c; }
async function loadChar(env, id, token) {
  const row = await env.DB.prepare('SELECT token, json FROM rpg_chars WHERE id = ?').bind(id).first();
  if (!row || row.token !== token) return null;
  return JSON.parse(row.json);
}
async function saveChar(env, c) { await env.DB.prepare('UPDATE rpg_chars SET json = ? WHERE id = ?').bind(JSON.stringify(c), c.id).run(); }

async function createChar(body, env, ip) {
  const name = clip(body.name, LEN.name), setting = clip(body.setting, LEN.setting);
  if (!name || !setting) return json({ error: 'bad_request' }, 400);
  const r = await reserve(env, ip);
  if (!r.ok) return json({ error: 'quota', reason: r.reason, quota: r.q }, 429);
  let parsed, usage, model, raw;
  try { ({ parsed, usage, model, raw } = await ask(env, SYS_JUDGE, `이름: ${name}\n설정: ${setting}`, 0.2)); await record(env, usage, model); }
  catch (e) { await refund(env, ip); return json({ error: 'ai_failed', message: e.message, quota: await quota(env, ip) }, 502); }
  // 심사관이 형식을 어기거나 거절해도 플레이어를 막지 않는다: 균등 배분 + 낮은 일관성(불명확한 설정)으로 진행
  if (!parsed || !parsed.alloc) parsed = { concept: parsed?.concept, alloc: null, coherence: 30, ult: parsed?.ult, fallback: true };
  const ult = parsed.ult || {};
  const c = {
    id: uid(), name, info: setting, fiction: clip(parsed.concept, LEN.fiction) || (parsed.fallback ? '정체불명의 몽상가' : '이름 없는 몽상가'), judged: !parsed.fallback,
    stats: buildStats(parsed.alloc, parsed.coherence),
    ult: { name: clip(ult.name, LEN.ultName) || '혼신의 일격', effect: clip(ult.effect, LEN.ultEffect) || '온 힘을 담은 한 방', style: ULT_STYLES[ult.style] ? ult.style : 'burst' },
    wins: 0, losses: 0, created: Date.now(),
  };
  const token = uid();
  await env.DB.prepare('INSERT INTO rpg_chars (id, token, json, created) VALUES (?, ?, ?, ?)').bind(c.id, token, JSON.stringify(c), c.created).run();
  return json({ char: publicChar(c), token, quota: await quota(env, ip) });
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
function makeEnemy(i) {
  const [name, fiction, alloc, coherence, ult, info, tier] = ENEMIES[i];
  return { id: 'enemy-' + i, name, fiction, info, stats: buildStats(alloc, coherence, tier), ult: { name: ult[0], effect: ult[1], style: ult[2] }, tier };
}
function pickEnemy(c) {
  const rec = c.wins - c.losses;                                     // 이기고 있으면 강적이 더 자주
  const weights = ENEMIES.map(e => { const t = e[6]; return 1 / (1 + Math.abs(t - (1 + Math.max(0, Math.min(3, rec)) * 0.25)) * 3); });
  let r = rnd() * weights.reduce((s, w) => s + w, 0);
  for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) return makeEnemy(i); }
  return makeEnemy(0);
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
  const foe = pickEnemy(c);
  const st = { id: uid(), charId: c.id, me: { char: c, hp: c.stats.hp, gauge: 0, guard: false }, foe: { char: foe, hp: foe.stats.hp, gauge: 0, guard: false }, turn: 1, log: [], status: 'playing', winner: null };
  await env.DB.prepare('INSERT INTO rpg_battles (id, char_id, state, updated) VALUES (?, ?, ?, ?)').bind(st.id, c.id, JSON.stringify(st), Date.now()).run();
  return json({ battle: st });
}
function parseAct(body) { return { type: ['attack', 'ult', 'defend'].includes(body.type) ? body.type : 'attack', text: clip(body.text, LEN.text), target: Number(body.target) || null }; }

async function getBattle(id, token, env) {
  const row = await env.DB.prepare('SELECT state, updated FROM rpg_battles WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'no_battle' }, 404);
  const st = JSON.parse(row.state);
  if (!(await loadChar(env, st.charId, token))) return json({ error: 'forbidden' }, 403);
  return json({ battle: st });
}
async function leaveBattle(id, body, env) {
  const row = await env.DB.prepare('SELECT state FROM rpg_battles WHERE id = ?').bind(id).first();
  if (!row) return json({ ok: true });
  const st = JSON.parse(row.state);
  if (!(await loadChar(env, st.charId, body.token))) return json({ error: 'forbidden' }, 403);
  await env.DB.prepare('DELETE FROM rpg_battles WHERE id = ?').bind(id).run();
  return json({ ok: true });
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
  const actMe = { ...parseAct(body), target: 2 }, actFoe = { ...enemyDecide(st.foe, st.me), target: 1 };
  const t = await runRound(env, ip, { 1: st.me, 2: st.foe }, { 1: actMe, 2: actFoe });
  st.log.push({ turn: st.turn, acts: { 1: actMe, 2: actFoe }, judge: t.judge, order: t.order, events: t.events, narration: t.narration, ai: t.usedAi });
  if (st.log.length > 40) st.log.shift();
  if (st.me.hp <= 0 || st.foe.hp <= 0) {
    st.status = 'finished'; st.winner = st.me.hp <= 0 ? 2 : 1;
    if (st.winner === 1) { c.wins++; c.stats.hp += 20; c.stats.atk += 3; }   // 승리 성장 (소폭)
    else c.losses++;
    await saveChar(env, c); st.me.char = c;
  } else st.turn++;
  await env.DB.prepare('UPDATE rpg_battles SET state = ?, updated = ? WHERE id = ?').bind(JSON.stringify(st), Date.now(), id).run();
  return json({ battle: st, quota: await quota(env, ip), quotaBlocked: t.quotaBlocked });
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
  const { tokens, ...rest } = s;
  const moves = {}; for (const k in s.p) moves[k] = !!s.moves[k];
  const firstAt = Math.min(...Object.values(s.moves).map(m => m.at || Infinity));
  return { ...rest, you: slot, moves, myMove: s.moves[slot] || null, waitingSince: Number.isFinite(firstAt) ? firstAt : null, max: ROOM_MAX };
}
async function createRoom(body, env) {
  const c = await loadChar(env, body.charId, body.token);
  if (!c) return json({ error: 'forbidden' }, 403);
  await env.DB.prepare('DELETE FROM rpg_rooms WHERE updated < ?').bind(Date.now() - ROOM_TTL).run();
  const code = code6(), rt = uid(), now = Date.now();
  const s = { code, host: 1, p: { 1: { char: c, hp: c.stats.hp, gauge: 0, guard: false, afk: 0 } }, tokens: { 1: rt }, round: 0, moves: {}, log: [], status: 'waiting', winner: null };
  await env.DB.prepare('INSERT INTO rpg_rooms (code, created, updated, state) VALUES (?, ?, ?, ?)').bind(code, now, now, JSON.stringify(s)).run();
  return json({ code, roomToken: rt, slot: 1, state: pub(s, 1) });
}
async function joinRoom(code, body, env) {
  const c = await loadChar(env, body.charId, body.token);
  if (!c) return json({ error: 'forbidden' }, 403);
  const r = await loadRoom(env, code);
  if (!r) return json({ error: 'no_room' }, 404);
  const s = r.s;
  // 같은 캐릭터가 다시 오면 (새로고침·앱 전환) 기존 자리로 재접속 — 캐릭터 토큰으로 본인 확인됨
  const mine = Object.keys(s.p).find(k => s.p[k].char.id === c.id);
  if (mine) return json({ code, roomToken: s.tokens[mine], slot: Number(mine), state: pub(s, Number(mine)), rejoined: true });
  if (s.status !== 'waiting') return json({ error: 'started' }, 409);
  if (Object.keys(s.p).length >= ROOM_MAX) return json({ error: 'full' }, 409);
  const slot = [1, 2, 3, 4, 5, 6].find(k => !s.p[k]), rt = uid();
  s.p[slot] = { char: c, hp: c.stats.hp, gauge: 0, guard: false, afk: 0 }; s.tokens[slot] = rt;
  if (!(await saveRoom(env, code, s, r.v))) return json({ error: 'retry' }, 409);
  return json({ code, roomToken: rt, slot, state: pub(s, slot) });
}
async function getRoom(code, t, env) {
  const r = await loadRoom(env, code);
  if (!r) return json({ error: 'no_room' }, 404);
  const slot = slotOf(r.s, t);
  return slot ? json({ state: pub(r.s, slot) }) : json({ error: 'forbidden' }, 403);
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
    s.moves[slot] = { ...parseAct(body), at: Date.now() }; s.p[slot].afk = 0;
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
    const t = await runRound(env, ip, s.p, s.moves);
    s.log.push({ round: s.round, acts: { ...s.moves }, judge: t.judge, order: t.order, events: t.events, narration: t.narration, ai: t.usedAi });
    if (s.log.length > 40) s.log.shift();
    quotaBlocked = t.quotaBlocked;
  }
  const left = aliveSlots(s.p);
  if (left.length <= 1) {
    s.status = 'finished'; s.winner = left[0] || 0;
    for (const k in s.p) { const c = s.p[k].char; if (s.winner === Number(k)) c.wins++; else c.losses++; await saveChar(env, c); }
  } else s.round++;
  s.moves = {}; s.busy = false;
  await saveRoom(env, code, s, v2);
  return json({ state: pub(s, slot), quota: await quota(env, ip), quotaBlocked });
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
