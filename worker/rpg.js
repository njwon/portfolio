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
 *   POST /api/rpg/rooms                          { charId, token }            → { code, roomToken, state }
 *   POST /api/rpg/rooms/:code/join               { charId, token }
 *   GET  /api/rpg/rooms/:code?token=
 *   POST /api/rpg/rooms/:code/action             { token, type, text }        (둘 다 내면 판정 + 서술 1회)
 */

const MODEL = '@cf/google/gemma-3-12b-it';
const NEURON_IN = 31371 / 1e6, NEURON_OUT = 50560 / 1e6;
const MAX_TOKENS = 380;
const MAX_NEURONS_PER_CALL = Math.ceil(1500 * NEURON_IN + MAX_TOKENS * NEURON_OUT);   // ≈ 67
const DAILY_BUDGET = 9000, PER_IP_DAILY = 40;
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
  if ((mm = path.match(/^\/api\/rpg\/battles\/([\w-]{36})\/turn$/)) && m === 'POST') return battleTurn(mm[1], body, env, ip);
  if (path === '/api/rpg/rooms' && m === 'POST') return createRoom(body, env);
  if ((mm = path.match(/^\/api\/rpg\/rooms\/([A-Z0-9]{6})(?:\/(join|action))?$/))) {
    const [, code, sub] = mm;
    if (!sub && m === 'GET') return getRoom(code, url.searchParams.get('token'), env);
    if (sub === 'join' && m === 'POST') return joinRoom(code, body, env);
    if (sub === 'action' && m === 'POST') return roomAction(code, body, env, ip);
  }
  return json({ error: 'Not Found' }, 404);
}

// ─── 한도 ───────────────────────────────────────────────────────────
async function quota(env, ip) {
  const day = today();
  const g = await env.DB.prepare('SELECT neurons, requests FROM rpg_quota WHERE day = ?').bind(day).first();
  const i = await env.DB.prepare('SELECT requests FROM rpg_ip WHERE day = ? AND ip = ?').bind(day, ip).first();
  const used = g?.neurons ?? 0, remaining = Math.max(0, DAILY_BUDGET - used);
  return {
    day, resetsAt: Date.parse(day + 'T00:00:00Z') + 86400e3,
    global: { budget: DAILY_BUDGET, used: Math.round(used), remaining: Math.round(remaining), estCalls: Math.floor(remaining / MAX_NEURONS_PER_CALL), requests: g?.requests ?? 0 },
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
async function record(env, usage) {
  const inTok = usage?.prompt_tokens ?? 1200, outTok = usage?.completion_tokens ?? MAX_TOKENS;
  await env.DB.prepare('UPDATE rpg_quota SET neurons = neurons + ? WHERE day = ?').bind(inTok * NEURON_IN + outTok * NEURON_OUT, today()).run();
}

// ─── AI (심사·서술 전용) ─────────────────────────────────────────────
async function ask(env, system, user, temperature) {
  const res = await env.AI.run(MODEL, { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: MAX_TOKENS, temperature });
  const text = typeof res === 'string' ? res : (res.response ?? '');
  const mt = text.match(/\{[\s\S]*\}/);
  let parsed = null; if (mt) { try { parsed = JSON.parse(mt[0]); } catch {} }
  return { parsed, usage: res.usage };
}

const SYS_JUDGE = `당신은 텍스트 RPG 캐릭터 심사관입니다. 사용자가 쓴 캐릭터 설정을 읽고 아래만 정합니다. 숫자 능력치는 정하지 않습니다(서버가 정함).
1) concept: 설정을 요약한 수식어 (예: 평범한 고등학생, 바다의 신, 은퇴한 검사)
2) alloc: 이 캐릭터의 성향을 6개 항목에 합계 100으로 배분. atk(공격) hp(체력) def(방어) spd(속도) acc(명중) eva(회피). 설정에 근거해서만.
3) coherence 0~100: 설정의 내적 일관성. 앞뒤가 맞고 한계·약점이 분명하면 높음. "무엇이든 다 한다", 모순, 근거 없는 전능은 낮음. 현실적/비현실적 여부와 무관.
4) ult: 필살기 하나. name(짧게), effect(한 문장), style 은 burst(한 방)·precise(명중 위주)·drain(피해+회복)·shield(피해+다음 턴 방어) 중 하나.
반드시 이 JSON 하나만 출력:
{"concept":"...","alloc":{"atk":0,"hp":0,"def":0,"spd":0,"acc":0,"eva":0},"coherence":0,"ult":{"name":"...","effect":"...","style":"burst"}}
설정이 비어 있거나 해석 불가면 {"error":"reason"} 만.`;

const SYS_NARRATE = `당신은 텍스트 RPG 게임 마스터입니다. 전투 1턴의 결과가 이미 계산되어 주어집니다. 결과를 바꾸지 말고 서술하세요.
할 일:
1) fit1, fit2: 각 플레이어의 '이번 행동 문장'이 그 캐릭터 설정·필살기와 얼마나 어울리는지 0.0~1.0. 문장이 없거나 '기본 공격'이면 0.5. 설정에 없는 능력을 갑자기 쓰면 0.2 이하.
2) narration: 주어진 사실(명중/빗나감/크리티컬/방어/피해)을 정확히 반영해 4~6문장으로 생생하게. 캐릭터 설정을 근거로 왜 그렇게 됐는지 한 번씩 언급. 줄바꿈은 <br>. 새로운 수치를 만들지 마세요.
반드시 이 JSON 하나만 출력: {"fit1":0.5,"fit2":0.5,"narration":"..."}`;

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
function resolveTurn(a, b, actA, actB, fitA = 0.5, fitB = 0.5) {
  const first = a.char.stats.spd + rnd() * 30 >= b.char.stats.spd + rnd() * 30 ? 'a' : 'b';
  const order = first === 'a' ? [[a, b, actA, fitA, 1], [b, a, actB, fitB, 2]] : [[b, a, actB, fitB, 2], [a, b, actA, fitA, 1]];
  const events = [];
  // 방어 선언은 행동 순서와 무관하게 이번 턴 내내 유효
  if (actA.type === 'defend') a.guard = true; if (actB.type === 'defend') b.guard = true;
  for (const [me, foe, act, fit, who] of order) {
    if (me.hp <= 0) continue;
    if (act.type === 'defend') { me.gauge = Math.min(ULT_COST, me.gauge + 2); events.push({ who, type: 'defend' }); continue; }
    const isUlt = act.type === 'ult' && me.gauge >= ULT_COST;
    if (act.type === 'ult' && !isUlt) events.push({ who, type: 'ult_fail' });   // 게이지 부족 → 기본 공격으로
    const s = me.char.stats, t = foe.char.stats, style = ULT_STYLES[me.char.ult.style] || ULT_STYLES.burst;
    const acc = s.acc + (isUlt && style.accBonus ? style.accBonus : 0);
    const chance = Math.min(0.95, Math.max(0.1, (acc - t.eva) / 100 * s.stability + (fit - 0.5) * 0.2));
    const hit = rnd() < chance, crit = hit && rnd() < 0.1;
    let dmg = 0;
    if (hit) {
      dmg = s.atk * (isUlt ? style.mult : 1) * (0.9 + rnd() * 0.2) * (crit ? 1.5 : 1) * (0.85 + fit * 0.3);   // 적합도 ±15%
      dmg *= 1 - t.def / 100; if (foe.guard) dmg *= 0.5;
      dmg = Math.max(1, Math.round(dmg));
      foe.hp = Math.max(0, foe.hp - dmg);
      if (isUlt && style.heal) me.hp = Math.min(me.char.stats.hp, me.hp + Math.round(dmg * style.heal));
      if (isUlt && style.guard) me.guardNext = true;
    }
    if (isUlt) me.gauge -= ULT_COST; else me.gauge = Math.min(ULT_COST, me.gauge + 1);
    events.push({ who, type: isUlt ? 'ult' : 'attack', hit, crit, dmg, chance: Math.round(chance * 100), guarded: hit && foe.guard });
    if (foe.hp <= 0) break;
  }
  a.guard = !!a.guardNext; b.guard = !!b.guardNext; a.guardNext = b.guardNext = false;
  return { first, events };
}
function factsText(names, events) {
  return events.map(e => {
    const n = names[e.who];
    if (e.type === 'defend') return `${n}: 방어 태세 (받는 피해 절반, 게이지 +2)`;
    if (e.type === 'ult_fail') return `${n}: 필살기를 쓰려 했으나 게이지 부족 → 기본 공격`;
    const k = e.type === 'ult' ? '필살기' : '공격';
    return e.hit ? `${n}: ${k} 명중(${e.chance}%)${e.crit ? ' 크리티컬!' : ''}${e.guarded ? ' (상대 방어로 절반)' : ''} → 피해 ${e.dmg}` : `${n}: ${k} 빗나감(명중률 ${e.chance}%)`;
  }).join('\n');
}
function templateNarration(names, events) {
  return factsText(names, events).replace(/\n/g, '<br>') + '<br>(게임 마스터의 목소리가 닿지 않아 사실만 기록합니다)';
}

// 서술 + 적합도 한 번의 AI 호출. 순서: 적합도가 피해에 영향을 주므로 먼저 fit 을 받고 → 판정 → 서술이 이상적이지만 2회 호출이 되므로,
// 한도 절약을 위해 '판정(fit 0.5 가정) → 서술+fit' 1회로 하고 fit 은 피해에 ±15% 로 사후 보정한다 (결과 사실은 서술에 그대로 반영).
async function narrateTurn(env, ip, a, b, actA, actB) {
  const names = { 1: a.char.name, 2: b.char.name };
  const pre = resolveTurn(a, b, actA, actB);                        // 사실 확정 (fit 0.5 기준)
  let narration = templateNarration(names, pre.events), fit = { 1: 0.5, 2: 0.5 }, usedAi = false;
  const r = await reserve(env, ip);
  if (r.ok) {
    try {
      const user = `[플레이어1] ${a.char.name} (${a.char.fiction}) — 설정: ${a.char.info} / 필살기 ${a.char.ult.name}: ${a.char.ult.effect}
행동: ${actA.type === 'defend' ? '방어' : actA.type === 'ult' ? '필살기' : '공격'} — "${actA.text || '기본 공격'}"
[플레이어2] ${b.char.name} (${b.char.fiction}) — 설정: ${b.char.info} / 필살기 ${b.char.ult.name}: ${b.char.ult.effect}
행동: ${actB.type === 'defend' ? '방어' : actB.type === 'ult' ? '필살기' : '공격'} — "${actB.text || '기본 공격'}"
선공: ${pre.first === 'a' ? a.char.name : b.char.name}
[확정된 결과]
${factsText(names, pre.events)}
남은 HP: ${a.char.name} ${a.hp}/${a.char.stats.hp}, ${b.char.name} ${b.hp}/${b.char.stats.hp}`;
      const { parsed, usage } = await ask(env, SYS_NARRATE, user, 0.9);
      await record(env, usage);
      if (parsed?.narration) { narration = String(parsed.narration).slice(0, 1200); usedAi = true; }
      fit = { 1: num(parsed?.fit1, 0, 1, 0.5), 2: num(parsed?.fit2, 0, 1, 0.5) };
    } catch {}
  }
  // 적합도 사후 보정: 명중한 피해에 (0.85 + fit·0.3) 배율 재적용 (기준 0.5 → 1.0 배)
  for (const e of pre.events) if (e.hit && e.dmg) {
    const tgt = e.who === 1 ? b : a;
    if (tgt.hp === 0) continue;                                      // 이미 쓰러진 결과(서술에 반영됨)는 되살리지 않는다
    const f = fit[e.who], adj = Math.round(e.dmg * (0.85 + f * 0.3)) - e.dmg;
    if (adj) { tgt.hp = Math.max(1, Math.min(tgt.char.stats.hp, tgt.hp - adj)); e.dmg += adj; e.fit = f; }
  }
  return { events: pre.events, first: pre.first, narration, fit, usedAi, quotaBlocked: !r.ok ? r.reason : null };
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
  let parsed, usage;
  try { ({ parsed, usage } = await ask(env, SYS_JUDGE, `이름: ${name}\n설정: ${setting}`, 0.2)); await record(env, usage); }
  catch (e) { return json({ error: 'ai_failed', message: e.message, quota: await quota(env, ip) }, 502); }
  if (!parsed || parsed.error || !parsed.alloc) return json({ error: 'ai_reject', quota: await quota(env, ip) }, 422);
  const ult = parsed.ult || {};
  const c = {
    id: uid(), name, info: setting, fiction: clip(parsed.concept, LEN.fiction) || '이름 없는 몽상가',
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
  if (e.gauge >= ULT_COST && rnd() < (e.hp < e.char.stats.hp * 0.5 ? 0.85 : 0.5)) return { type: 'ult', text: `필살기 ${e.char.ult.name}` };
  if (me.gauge >= ULT_COST && e.hp < e.char.stats.hp * 0.4 && rnd() < 0.35) return { type: 'defend', text: '방어 태세' };
  return { type: 'attack', text: '기본 공격' };
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
function parseAct(body) { return { type: ['attack', 'ult', 'defend'].includes(body.type) ? body.type : 'attack', text: clip(body.text, LEN.text) }; }

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
  const actMe = parseAct(body), actFoe = enemyDecide(st.foe, st.me);
  const t = await narrateTurn(env, ip, st.me, st.foe, actMe, actFoe);
  st.log.push({ turn: st.turn, acts: { 1: actMe, 2: actFoe }, first: t.first, events: t.events, narration: t.narration, ai: t.usedAi });
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

// ─── 온라인 대전 ────────────────────────────────────────────────────
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
const slotOf = (s, t) => s.tokens[1] === t ? 1 : s.tokens[2] === t ? 2 : 0;
function pub(s, slot) {
  const { tokens, ...rest } = s;
  return { ...rest, you: slot, moves: { 1: !!s.moves[1], 2: !!s.moves[2], mine: s.moves[slot] || null } };
}
async function createRoom(body, env) {
  const c = await loadChar(env, body.charId, body.token);
  if (!c) return json({ error: 'forbidden' }, 403);
  await env.DB.prepare('DELETE FROM rpg_rooms WHERE updated < ?').bind(Date.now() - ROOM_TTL).run();
  const code = code6(), rt = uid(), now = Date.now();
  const s = { code, p: { 1: { char: c, hp: c.stats.hp, gauge: 0, guard: false }, 2: null }, tokens: { 1: rt, 2: null }, round: 0, moves: {}, log: [], status: 'waiting', winner: null };
  await env.DB.prepare('INSERT INTO rpg_rooms (code, created, updated, state) VALUES (?, ?, ?, ?)').bind(code, now, now, JSON.stringify(s)).run();
  return json({ code, roomToken: rt, slot: 1, state: pub(s, 1) });
}
async function joinRoom(code, body, env) {
  const c = await loadChar(env, body.charId, body.token);
  if (!c) return json({ error: 'forbidden' }, 403);
  const r = await loadRoom(env, code);
  if (!r) return json({ error: 'no_room' }, 404);
  if (r.s.p[2]) return json({ error: 'full' }, 409);
  if (r.s.p[1].char.id === c.id) return json({ error: 'self' }, 409);
  const rt = uid();
  r.s.p[2] = { char: c, hp: c.stats.hp, gauge: 0, guard: false }; r.s.tokens[2] = rt; r.s.status = 'playing'; r.s.round = 1;
  if (!(await saveRoom(env, code, r.s, r.v))) return json({ error: 'retry' }, 409);
  return json({ code, roomToken: rt, slot: 2, state: pub(r.s, 2) });
}
async function getRoom(code, t, env) {
  const r = await loadRoom(env, code);
  if (!r) return json({ error: 'no_room' }, 404);
  const slot = slotOf(r.s, t);
  return slot ? json({ state: pub(r.s, slot) }) : json({ error: 'forbidden' }, 403);
}
async function roomAction(code, body, env, ip) {
  const r = await loadRoom(env, code);
  if (!r) return json({ error: 'no_room' }, 404);
  const s = r.s, slot = slotOf(s, body.token);
  if (!slot) return json({ error: 'forbidden' }, 403);
  if (s.status !== 'playing') return json({ state: pub(s, slot) });
  if (s.moves[slot]) return json({ state: pub(s, slot) });
  s.moves[slot] = parseAct(body);
  const other = slot === 1 ? 2 : 1;
  if (!s.moves[other]) {
    if (!(await saveRoom(env, code, s, r.v))) return json({ error: 'retry' }, 409);
    return json({ state: pub(s, slot) });
  }
  // 둘 다 냈다 → 이 요청이 판정 (낙관적 잠금으로 한 번만)
  s.busy = true;
  const v = await saveRoom(env, code, s, r.v);
  if (!v) return json({ error: 'retry' }, 409);
  const t = await narrateTurn(env, ip, s.p[1], s.p[2], s.moves[1], s.moves[2]);
  s.log.push({ round: s.round, acts: { ...s.moves }, first: t.first, events: t.events, narration: t.narration, ai: t.usedAi });
  if (s.log.length > 40) s.log.shift();
  if (s.p[1].hp <= 0 || s.p[2].hp <= 0) {
    s.status = 'finished'; s.winner = s.p[1].hp <= 0 && s.p[2].hp <= 0 ? 0 : s.p[1].hp <= 0 ? 2 : 1;
    for (const k of [1, 2]) { const c = s.p[k].char; if (s.winner === k) c.wins++; else if (s.winner) c.losses++; await saveChar(env, c); }
  } else s.round++;
  s.moves = {}; s.busy = false;
  await saveRoom(env, code, s, v);
  return json({ state: pub(s, slot), quota: await quota(env, ip), quotaBlocked: t.quotaBlocked });
}
