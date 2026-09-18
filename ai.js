/* ==========================================================================
   Saydo AI — Gemini function calling 기반 태스크 어시스턴트
   --------------------------------------------------------------------------
   구조
     [챗 패널] → [어댑터] → [Cloudflare Worker 프록시] → [Gemini]
                    ↑                                        │
                    └──── 도구 실행 결과 (실제 태스크 변경) ←┘

   왜 어댑터가 있는가
     Gemini 가 Interactions API 로 전환 중이라 요청·응답 형식이 두 가지 공존한다.
       int  : POST /v1beta/interactions            { input | user_input, tools:[{type:'function',...}] }
       gen  : POST /v1beta/models/{m}:generateContent { contents, tools:[{functionDeclarations:[...]}] }
     어느 쪽이 살아 있는지 런타임에 확인해 통하는 형식을 기억한다.
     프록시는 본문을 해석하지 않으므로 형식이 또 바뀌어도 이 파일만 고치면 된다.

   보내는 데이터
     열려 있는 태스크의 제목·기한·우선순위·라벨·목록만 압축해 보낸다.
     실제 Google 태스크 ID 는 보내지 않고 t1, t2 … 별칭으로 치환한다.
     (토큰 절약 + 식별자 노출 최소화)
   ========================================================================== */
'use strict';

const AI_LS = { url: 'saydo.aiUrl', model: 'saydo.aiModel', variant: 'saydo.aiVariant' };
/* 뒤의 두 별칭은 은퇴하지 않는다. 모델 이름이 사라져 404 가 나는 사고를 겪은 뒤 추가했다. */
const AI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.7-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
  'gemini-flash-lite-latest', 'gemini-flash-latest'];
const AI_MAX_STEPS = 6;                    // 도구 호출 왕복 상한 (무한 루프 방지)
const AI_MAX_OUT = 8192;                   // 분석 답변이 잘리지 않도록 넉넉히

const AI = {
  url: store.get(AI_LS.url) || '',
  model: store.get(AI_LS.model) || AI_MODELS[0],
  variant: store.get(AI_LS.variant) || '',   // '' = 미확정, 'int-input' | 'int-user_input' | 'gen'
  open: false, busy: false,
  msgs: [],            // {role:'user'|'ai'|'tool'|'err', text, detail}
  lastId: null,        // Interactions 서버측 대화 id
  contents: [],        // generateContent 용 클라이언트측 히스토리
  alias: new Map()     // 't3' -> 'listId/taskId'
};

/* ─────────────────────────── 1. 컨텍스트 스냅샷 ─────────────────────────── */
function aiSnapshot() {
  const ts = allTasks();
  AI.alias = new Map();
  const rev = new Map();                              // 실제 id -> 별칭
  let n = 0;
  const open = ts.filter(t => !t.done);
  for (const t of open) { const a = 't' + (++n); AI.alias.set(a, t.listId + '/' + t.id); rev.set(t.id, a); }

  const rows = open.map(t => {
    const r = { id: rev.get(t.id), title: t.title, list: t.listTitle };
    if (t.due) r.due = t.due;
    if (t.time) r.time = t.time;
    if (t.p < 4) r.priority = t.p;
    if (t.labels.length) r.labels = t.labels;
    if (t.parent && rev.has(t.parent)) r.parent = rev.get(t.parent);
    if (t.rec) r.repeat = recLabel(t.rec);
    if (t.body) r.notes = t.body.slice(0, 140);
    if (t.due && diffDays(t.due, todayY()) < 0) r.overdue_days = -diffDays(t.due, todayY());
    return r;
  });

  const doneRecent = ts.filter(t => t.done && t.completed &&
    diffDays(t.completed.slice(0, 10), todayY()) >= -7).length;

  return {
    today: todayY(),
    weekday: DOW[new Date().getDay()] + '요일',
    timezone: 'Asia/Seoul',
    lists: S.lists.map(l => l.title),
    completed_last_7_days: doneRecent,
    tasks: rows
  };
}
const aiResolve = a => AI.alias.get(String(a || '')) || null;

/* ─────────────────────────── 2. 도구 정의 ─────────────────────────── */
const AI_TOOLS = [
  {
    name: 'create_task',
    description: '새 태스크를 만든다. 사용자가 할 일을 추가해 달라고 하면 이 도구를 쓴다.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '태스크 제목. 날짜·우선순위 표현은 제목에서 빼고 각 인자로 넣을 것' },
        notes: { type: 'string', description: '설명 (선택)' },
        due: { type: 'string', description: '마감일 YYYY-MM-DD (선택)' },
        time: { type: 'string', description: '시각 HH:MM 24시간제 (선택)' },
        priority: { type: 'integer', description: '1=긴급 2=높음 3=보통 4=없음 (기본 4)' },
        labels: { type: 'array', items: { type: 'string' }, description: '라벨 (선택)' },
        list: { type: 'string', description: '목록 이름. 생략하면 기본 목록' },
        parent_id: { type: 'string', description: '상위 태스크의 id(t3 형식). 지정하면 서브태스크로 만든다' },
        repeat: { type: 'string', description: '반복: daily, weekdays, weekly, monthly, yearly 중 하나 (선택)' }
      },
      required: ['title']
    }
  },
  {
    name: 'update_task',
    description: '기존 태스크의 제목·기한·우선순위·라벨·설명을 바꾼다.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '태스크 id (t3 형식)' },
        title: { type: 'string' }, notes: { type: 'string' },
        due: { type: 'string', description: 'YYYY-MM-DD. 빈 문자열이면 기한 해제' },
        time: { type: 'string', description: 'HH:MM. 빈 문자열이면 해제' },
        priority: { type: 'integer' },
        labels: { type: 'array', items: { type: 'string' } }
      },
      required: ['id']
    }
  },
  {
    name: 'complete_task',
    description: '태스크를 완료 처리한다. 반복 태스크는 다음 회차로 넘어간다.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  },
  {
    name: 'move_task',
    description: '태스크를 다른 목록으로 옮기거나, 다른 태스크의 서브태스크로 만들거나, 최상위로 올린다.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        list: { type: 'string', description: '옮길 목록 이름 (선택)' },
        parent_id: { type: 'string', description: '상위로 삼을 태스크 id. 빈 문자열이면 최상위로 올린다 (선택)' }
      },
      required: ['id']
    }
  },
  {
    name: 'delete_task',
    description: '태스크를 삭제한다. 되돌리기 어려우므로 사용자가 명시적으로 삭제를 요청했을 때만 쓴다.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  },
  {
    name: 'create_list',
    description: '새 목록(프로젝트)을 만든다.',
    parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }
  }
];

function aiSystem(snap) {
  return [
    '너는 Saydo 라는 개인 태스크 관리 앱의 어시스턴트다. 한국어로 간결하게 답한다.',
    '',
    '규칙:',
    '- 태스크를 만들거나 바꿔 달라는 요청에는 반드시 도구를 호출한다. 말로만 "추가했습니다" 라고 하지 않는다.',
    '- 여러 건을 요청받으면 도구를 여러 번 호출한다.',
    '- 태스크 id 는 아래 목록의 id 값(t1, t2 …)을 그대로 쓴다. 목록에 없는 id 를 지어내지 않는다.',
    '- 날짜는 today 기준으로 계산해 YYYY-MM-DD 로 넣는다. "다음주 화요일" 같은 표현을 그대로 넘기지 않는다.',
    '- 삭제는 사용자가 명시적으로 요청했을 때만 한다.',
    '- 요청이 모호하면 추측해서 만들지 말고 한 번 되묻는다.',
    '- 도구 실행 후에는 무엇을 했는지 한두 문장으로 짧게 알린다. 목록을 장황하게 다시 읽지 않는다.',
    '- 분석·계획·리뷰·요약 요청에는 도구를 호출하지 말고 반드시 본문 텍스트로 답한다.',
    '  이때는 짧게가 아니라 충실하게 쓴다. 근거가 되는 태스크 제목을 구체적으로 인용하고,',
    '  패턴을 짚은 뒤 실행 가능한 제안으로 끝낸다. 빈 응답이나 "완료했습니다" 같은 답은 금지한다.',
    '',
    '현재 상태 (JSON):',
    JSON.stringify(snap)
  ].join('\n');
}

/* ─────────────────────────── 3. 어댑터 ─────────────────────────── */
/** 형식별 요청 본문을 만든다. kind: 'first' | 'toolResult' */
function aiBuildRequest(variant, opts) {
  const { systemText, userText, results, noThink } = opts;
  if (variant === 'gen') {
    if (userText != null) AI.contents.push({ role: 'user', parts: [{ text: userText }] });
    if (results) {
      AI.contents.push({
        role: 'user',
        parts: results.map(r => ({ functionResponse: { name: r.name, response: { result: r.result } } }))
      });
    }
    /* maxOutputTokens 를 명시하는 이유: 분석 요청의 답변은 길다. 기본값에 맡기면
       사고형 모델이 생각에 예산을 쓰고 본문 앞에서 MAX_TOKENS 로 잘린다. */
    const gc = { temperature: 0.2, maxOutputTokens: AI_MAX_OUT };
    if (noThink) gc.thinkingConfig = { thinkingBudget: 0 };
    return {
      __path: `/v1beta/models/${AI.model}:generateContent`,
      model: AI.model,
      systemInstruction: { parts: [{ text: systemText }] },
      contents: AI.contents,
      tools: [{ functionDeclarations: AI_TOOLS }],
      generationConfig: gc
    };
  }
  // Interactions API — 입력 필드명이 문서마다 input / user_input 으로 갈린다
  const field = variant === 'int-user_input' ? 'user_input' : 'input';
  const body = {
    __path: '/v1beta/interactions',
    model: AI.model,
    system_instruction: systemText,
    tools: AI_TOOLS.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })),
    generation_config: { temperature: 0.2 }
  };
  if (AI.lastId) body.previous_interaction_id = AI.lastId;
  body[field] = results
    ? results.map(r => ({
        type: 'function_result', name: r.name, call_id: r.callId,
        result: [{ type: 'text', text: JSON.stringify(r.result) }]
      }))
    : userText;
  return body;
}

/** 형식이 무엇이든 { id, text, calls[], finish, blocked, thoughtOnly } 로 정규화한다.
 *
 *  finish / blocked 를 함께 들고 나오는 이유:
 *  사고형(thinking) 모델은 출력 예산을 생각에만 다 쓰고 본문 없이 끝나는 경우가 있다.
 *  그때 응답에는 parts 자체가 없고 finishReason 만 MAX_TOKENS 로 온다.
 *  이걸 그냥 "빈 텍스트" 로 뭉개면 앱이 "완료했습니다" 같은 거짓말을 하게 된다. */
function aiParseReply(j) {
  const out = { id: j.id || j.interaction_id || null, text: '', calls: [], finish: '', blocked: '', thoughtOnly: false };
  const cand = (j.candidates && j.candidates[0]) || null;
  out.finish = String((cand && (cand.finishReason || cand.finish_reason)) || '');
  out.blocked = String((j.promptFeedback && j.promptFeedback.blockReason) ||
                       (cand && (cand.blockReason || '')) || '');

  // (A) Interactions
  const steps = j.execution_steps || j.steps || j.output || null;
  if (Array.isArray(steps)) {
    for (const s of steps) {
      const type = s.step_type || s.type || '';
      const fc = s.function_call || s.functionCall || (type === 'function_call' ? s : null);
      if (fc && fc.name) {
        out.calls.push({
          id: fc.id || fc.call_id || s.id || fc.name,
          name: fc.name,
          args: fc.arguments || fc.args || fc.parameters || {}
        });
        continue;
      }
      const mo = s.model_output || s.output || null;
      if (mo && (mo.text || typeof mo === 'string')) out.text += (mo.text || mo);
      else if (type === 'model_output' && s.text) out.text += s.text;
      else if (!type && typeof s.text === 'string') out.text += s.text;
    }
    if (typeof j.text === 'string' && !out.text) out.text = j.text;
    if (out.text || out.calls.length) return out;
  }

  // (B) generateContent
  const parts = cand && cand.content && cand.content.parts;
  if (Array.isArray(parts)) {
    let thoughts = 0;
    for (const p of parts) {
      if (p.functionCall) out.calls.push({ id: p.functionCall.name, name: p.functionCall.name, args: p.functionCall.args || {} });
      else if (p.thought) thoughts++;                 // 생각 요약은 화면에 쓰지 않는다
      else if (typeof p.text === 'string') out.text += p.text;
    }
    out.thoughtOnly = !!thoughts && !out.text && !out.calls.length;
    /* 생각뿐인 턴은 히스토리에 넣지 않는다. 넣으면 다음 요청의 마지막 턴이 model 이 되어
       이어 붙이기가 깨진다. */
    if (out.text || out.calls.length) AI.contents.push(cand.content);
    return out;
  }

  if (typeof j.text === 'string') out.text = j.text;
  return out;
}

/** 프록시 주소가 이 기기·이 오리진에서 실제로 닿을 수 있는지 미리 본다.
 *
 *  아이폰에서 반드시 걸리는 두 가지를 브라우저의 모호한 실패 대신 말로 설명한다.
 *    1) HTTPS 페이지가 http:// 를 부르면 브라우저가 혼합 콘텐츠로 막는다 (조용히 실패).
 *    2) 아이폰의 localhost 는 맥이 아니라 아이폰 자신이다. 절대 닿지 않는다.
 *  빈 문자열이면 문제 없음. */
function aiUrlProblem(url, loc) {
  loc = loc || location;                       // 두 번째 인자는 테스트에서 오리진을 갈아끼우기 위한 것
  if (!url) return '';
  let u; try { u = new URL(url); } catch (e) { return '프록시 주소 형식이 올바르지 않습니다.'; }
  const isLocal = h => /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(h);
  const local = isLocal(u.hostname);
  const hereLocal = isLocal(loc.hostname);
  /* 같은 "localhost 인데 안 된다" 라도 기기에 따라 조치가 다르다.
     맥  : 프록시는 여기 돌고 있다. 앱을 localhost 주소로 열면 된다.
     아이폰: localhost 가 아이폰 자신이라 맥에 닿을 길이 없다. 공개 주소가 필요하다.
     한 문장으로 뭉치면 맥에서 "아이폰 얘기네" 하고 넘기게 된다 — 실제로 그랬다. */
  if (local && !hereLocal) {
    return '이 페이지는 ' + loc.protocol + '//' + loc.hostname + ' 로 열려 있어 localhost 프록시에 닿을 수 없습니다. '
      + '맥이라면 앱을 http://localhost:4173 으로 열면 그대로 동작합니다. '
      + '아이폰·아이패드에서는 localhost 가 그 기기 자신을 가리키므로 공개 주소가 필요합니다.';
  }
  if (loc.protocol === 'https:' && u.protocol === 'http:') {
    return 'HTTPS 페이지에서 http:// 주소는 브라우저가 차단합니다. 프록시도 https 로 열어야 합니다.';
  }
  return '';
}

/** 프록시 호출. 형식이 미확정이면 통하는 형식을 찾아 기억한다. */
async function aiSend(opts) {
  if (!AI.url) throw new Error('프록시 주소가 설정되지 않았습니다');
  const bad = aiUrlProblem(AI.url);
  if (bad) throw new Error(bad);
  const token = await ensureToken();
  if (!token) throw new Error('Google 계정 연결이 필요합니다');

  /* 순서는 실측 근거를 따른다. 2026-08 기준 generateContent 는 확실히 동작하고
     Interactions 는 계정·모델에 따라 열려 있지 않을 수 있어 뒤로 보낸다. */
  const order = AI.variant ? [AI.variant] : ['gen', 'int-input', 'int-user_input'];
  let lastErr = null;
  for (const variant of order) {
    const before = AI.contents.length;
    const body = aiBuildRequest(variant, opts);
    let r, txt;
    try {
      r = await fetch(AI.url.replace(/\/+$/, ''), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(body)
      });
      txt = await r.text();
    } catch (e) {
      throw new Error('프록시에 연결하지 못했습니다. 주소와 배포 상태를 확인해 주세요.');
    }
    if (r.ok) {
      if (!AI.variant) { AI.variant = variant; store.set(AI_LS.variant, variant); }
      let j; try { j = JSON.parse(txt); } catch (e) { throw new Error('응답을 해석하지 못했습니다'); }
      const parsed = aiParseReply(j);
      if (parsed.id) AI.lastId = parsed.id;
      return parsed;
    }
    AI.contents.length = before;                    // 실패한 시도의 히스토리 오염 제거
    lastErr = aiHttpError(r.status, txt);
    if (r.status === 401 || r.status === 403 || r.status === 429) throw new Error(lastErr);
    if (AI.variant) throw new Error(lastErr);       // 이미 확정된 형식이면 폴백하지 않는다
  }
  throw new Error(lastErr || '요청이 실패했습니다');
}

/* 401 의 실제 사유. 이걸 감추면 "왜 안 되는지" 를 찾는 데 시간이 오래 걸린다. */
const AI_WHY = {
  'missing-token': 'Google 계정 연결이 필요합니다.',
  'bad-token': '토큰이 만료됐습니다. 사이드바 새로고침 후 다시 시도해 주세요.',
  'no-email': '토큰에 이메일 정보가 없습니다. 사이드바 새로고침(↻)을 눌러 권한을 다시 받아 주세요.',
  'email-not-allowed': '이 Google 계정이 Worker 의 ALLOWED_EMAILS 에 없습니다.',
  'aud-mismatch': '이 토큰은 다른 앱에서 발급된 것입니다. Worker 의 ALLOWED_AUD 를 확인해 주세요.',
  'geo-blocked': 'Gemini 가 프록시 서버의 IP 위치를 거부했습니다. 프록시 호스트를 옮겨야 합니다 (worker/README 의 "지역 차단" 항목 참고).'
};
function aiHttpError(status, txt) {
  let detail = '', why = '';
  try {
    const j = JSON.parse(txt);
    why = j.reason || '';
    detail = AI_WHY[why] || (j.error && (j.error.message || j.error)) || why || '';
  } catch (e) { detail = txt.slice(0, 200); }
  const map = {
    400: '요청 실패 (400)',
    401: '프록시 인증 실패',
    403: '이 주소에서는 프록시 호출이 허용되지 않았습니다. Worker 의 ALLOWED_ORIGINS 를 확인해 주세요.',
    429: '호출이 너무 잦습니다. 잠시 후 다시 시도해 주세요.',
    500: '프록시 설정 오류입니다. GEMINI_API_KEY 시크릿이 등록됐는지 확인해 주세요.',
    502: 'Gemini 에 연결하지 못했습니다.'
  };
  return (map[status] || `요청 실패 (${status})`) + (detail ? ` — ${String(detail).slice(0, 200)}` : '');
}

/* ─────────────────────────── 4. 도구 실행 ─────────────────────────── */
const AI_REPEAT = {
  daily: { type: 'day', interval: 1 }, weekdays: { type: 'weekday', interval: 1 },
  weekly: { type: 'week', interval: 1, days: [] }, monthly: { type: 'month', interval: 1 },
  yearly: { type: 'year', interval: 1 }
};
function aiListId(name) {
  if (!name) return null;
  const q = String(name).toLowerCase().replace(/\s/g, '');
  const hit = S.lists.find(l => l.title.toLowerCase().replace(/\s/g, '') === q)
    || S.lists.find(l => l.title.toLowerCase().replace(/\s/g, '').includes(q));
  return hit ? hit.id : null;
}
function aiTaskOf(alias) {
  const key = aiResolve(alias);
  return key ? taskByKey(key) : null;
}

function aiRunTool(name, args) {
  args = args || {};
  try {
    if (name === 'create_task') {
      const listId = aiListId(args.list) || (args.parent_id && (aiTaskOf(args.parent_id) || {}).listId) || defaultListId();
      const parent = args.parent_id ? aiTaskOf(args.parent_id) : null;
      createTask({
        title: String(args.title || '').trim(),
        body: args.notes || '',
        due: args.due || null,
        time: args.time || null,
        p: Number(args.priority) >= 1 && Number(args.priority) <= 4 ? Number(args.priority) : 4,
        labels: Array.isArray(args.labels) ? args.labels : [],
        rec: AI_REPEAT[String(args.repeat || '').toLowerCase()] || null,
        listId: parent ? parent.listId : listId,
        parent: parent ? parent.id : null
      });
      return { ok: true, created: args.title, list: (S.lists.find(l => l.id === (parent ? parent.listId : listId)) || {}).title };
    }
    if (name === 'create_list') { createList(String(args.title || '').trim()); return { ok: true, created_list: args.title }; }

    const t = aiTaskOf(args.id);
    if (!t) return { ok: false, error: `id ${args.id} 를 찾을 수 없습니다` };

    if (name === 'complete_task') { toggleDone(t); return { ok: true, completed: t.title }; }
    if (name === 'delete_task') { deleteTask(t); return { ok: true, deleted: t.title }; }
    if (name === 'move_task') {
      const toList = args.list ? aiListId(args.list) : null;
      if (args.parent_id === '' || args.parent_id === null) applyMove(t, { parentId: null, destList: toList || undefined });
      else if (args.parent_id) {
        const p = aiTaskOf(args.parent_id);
        if (!p) return { ok: false, error: `상위 id ${args.parent_id} 를 찾을 수 없습니다` };
        nestUnder(t, p.listId + '/' + p.id);
      } else if (toList) moveToList(t, toList);
      else return { ok: false, error: 'list 또는 parent_id 중 하나가 필요합니다' };
      return { ok: true, moved: t.title };
    }
    if (name === 'update_task') {
      const patch = {};
      if (typeof args.title === 'string' && args.title.trim()) patch.title = args.title.trim();
      if ('due' in args) patch.due = args.due ? ymdToDue(args.due) : null;
      if (Object.keys(patch).length) patchTask(t, patch);

      const meta = {};
      if ('time' in args) meta.time = args.time || null;
      if ('priority' in args) meta.p = Number(args.priority) || 4;
      if (Array.isArray(args.labels)) meta.labels = args.labels;
      if (typeof args.notes === 'string') {
        const cur = taskByKey(t.listId + '/' + t.id) || t;
        patchTask(cur, { notes: encodeNotes(args.notes, { ...cur, ...meta }) });
      } else if (Object.keys(meta).length) {
        updateMeta(taskByKey(t.listId + '/' + t.id) || t, meta);
      }
      return { ok: true, updated: t.title };
    }
    return { ok: false, error: `알 수 없는 도구: ${name}` };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

const AI_TOOL_LABEL = {
  create_task: '태스크 생성', update_task: '태스크 수정', complete_task: '완료 처리',
  move_task: '이동', delete_task: '삭제', create_list: '목록 생성'
};

/* ─────────────────────────── 5. 대화 루프 ─────────────────────────── */
/* ── Apps Script 백엔드 모드 ──────────────────────────────────────────────
   프록시가 script.google.com 이면 프로토콜이 통째로 다르다.

   왜 다른가
     Apps Script 는 OPTIONS 를 처리하지 못해 preflight 가 뜨는 요청은 아예 막힌다.
     Authorization 헤더도, application/json 도 preflight 를 부른다. 남는 것은
     "단순 요청"뿐이고, 그러려면 본문을 text/plain 으로 보내야 한다.
     게다가 도구 정의와 스냅샷을 다 실으면 GET 폴백에서 URL 길이를 넘긴다.

   그래서 서버가 대화 전체를 처리한다. 여기서는 문장 한 줄만 보낸다.
   도구 실행도 서버에서 하므로, 끝나면 동기화해서 결과를 화면에 반영한다. */
const isAppsScript = u => /(^|\/\/)script\.google\.com\//.test(String(u || ''));

async function aiAskScript(text) {
  const url = AI.url.replace(/\/+$/, '');
  const secret = store.get('saydo.aiSecret') || '';
  if (!secret) throw new Error('Apps Script 백엔드에는 시크릿이 필요합니다. 설정에서 넣어 주세요.');

  const history = AI.msgs.filter(m => m.role === 'user' || m.role === 'ai')
    .slice(-6).map(m => ({ role: m.role, text: String(m.text).slice(0, 600) }));
  const payload = { secret, action: 'chat', text, history };

  /* POST(text/plain) 를 먼저 쓴다 — 시크릿이 URL 에 실리지 않는다.
     Apps Script 의 302 리디렉션에서 본문이 사라지는 환경이 있어, 그때는
     쿼리 방식으로 내려간다. 시리 단축어에서 실제로 겪은 경로다. */
  let j = null;
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                                 body: JSON.stringify(payload) });
    const t = await r.text();
    try { j = JSON.parse(t); } catch (e) { j = null; }
  } catch (e) { j = null; }

  /* 본문이 유실되면 서버는 action 을 못 받아 상태 JSON 을 돌려준다 — 그게 신호다. */
  if (!j || (j.service && !j.speak)) {
    const q = url + '?secret=' + encodeURIComponent(secret) + '&action=chat'
            + '&text=' + encodeURIComponent(text)
            + '&history=' + encodeURIComponent(JSON.stringify(history));
    const r2 = await fetch(q);
    const t2 = await r2.text();
    try { j = JSON.parse(t2); }
    catch (e) { throw new Error('백엔드 응답을 해석하지 못했습니다. 배포가 "모든 사용자" 인지 확인해 주세요.'); }
  }
  return j;
}

async function aiAsk(text) {
  if (AI.busy) return;
  if (!AI.url) { aiPush('err', '먼저 프록시 주소를 설정해 주세요. 우측 상단 톱니 버튼입니다.'); return; }

  if (isAppsScript(AI.url)) {
    AI.busy = true; aiPush('user', text); aiRender();
    try {
      const j = await aiAskScript(text);
      if (j.speak) aiPush(j.ok ? 'ai' : 'err', j.speak);
      else aiPush('err', '백엔드가 빈 응답을 반환했습니다.');
      (j.actions || []).forEach(n => aiPush('tool', AI_TOOL_LABEL[n] || n));
      if (j.changed) await fullSync(true);        // 서버가 데이터를 바꿨다 — 간격과 무관하게 맞춘다
    } catch (e) {
      aiPush('err', String(e && e.message || e));
    } finally { AI.busy = false; aiRender(); render(); }
    return;
  }

  AI.busy = true;
  aiPush('user', text);
  aiRender();

  try {
    const snap = aiSnapshot();
    let reply = await aiSend({ systemText: aiSystem(snap), userText: text });

    let lastSystem = aiSystem(snap);
    for (let step = 0; step < AI_MAX_STEPS; step++) {
      if (!reply.calls.length) break;
      const results = [];
      for (const c of reply.calls) {
        const res = aiRunTool(c.name, c.args);
        results.push({ name: c.name, callId: c.id, result: res });
        aiPush('tool', `${AI_TOOL_LABEL[c.name] || c.name}${res.ok ? '' : ' 실패'}`, res);
      }
      aiRender();
      lastSystem = aiSystem(aiSnapshot());        // 변경 후 상태를 다시 실어 보낸다
      reply = await aiSend({ systemText: lastSystem, results });
      if (!reply.calls.length && !reply.text) break;
    }

    /* 본문 없이 끝난 턴은 재시도한다. 사고형 모델이 출력 예산을 생각에 다 쓴 경우가
       대부분이라, 생각을 끄고 한 번만 다시 물으면 본문이 나온다. */
    if (!reply.text && !reply.calls.length && AI.variant === 'gen') {
      try { reply = await aiSend({ systemText: lastSystem, noThink: true }); }
      catch (e) { /* 재시도 실패는 아래 진단으로 넘긴다 */ }
    }

    if (reply.text) aiPush('ai', reply.text);
    else aiPush('err', aiEmptyWhy(reply));
  } catch (e) {
    aiPush('err', String(e && e.message || e));
  } finally {
    AI.busy = false; aiRender(); render();
  }
}
function aiPush(role, text, detail) { AI.msgs.push({ role, text, detail }); }

/** 모델이 본문 없이 끝났을 때, 왜인지 그대로 말한다. 지어내지 않는다. */
function aiEmptyWhy(reply) {
  if (reply.blocked) return `Gemini 가 응답을 차단했습니다 (${reply.blocked}). 표현을 바꿔 다시 시도해 주세요.`;
  switch (reply.finish) {
    case 'MAX_TOKENS':
      return '답변이 출력 한도에 걸려 잘렸습니다. 질문 범위를 좁히거나 설정에서 더 가벼운 모델로 바꿔 보세요.';
    case 'SAFETY':
    case 'PROHIBITED_CONTENT':
      return `Gemini 안전 필터에 걸렸습니다 (${reply.finish}).`;
    case 'RECITATION':
      return 'Gemini 가 인용 정책으로 응답을 중단했습니다.';
  }
  if (reply.thoughtOnly) return '모델이 생각만 하고 답변을 내지 않았습니다. 다시 한 번 물어봐 주세요.';
  return `모델이 빈 응답을 반환했습니다${reply.finish ? ` (${reply.finish})` : ''}. 다시 시도해 주세요.`;
}

/* ─────────────────────────── 6. UI ─────────────────────────── */
const AI_PRESETS = [
  ['오늘 계획', '오늘 처리할 일을 우선순위와 근거를 붙여 순서대로 정리해 줘. 무리한 분량이면 무엇을 미룰지도 알려 줘.'],
  ['지연 분석', '기한이 지난 항목들을 분석해 줘. 어떤 패턴으로 밀리고 있는지 짚고, 재조정안을 제안해 줘.'],
  ['주간 리뷰', '목록·라벨별 부하 분포와 완료율을 요약하고 병목이 어디인지 알려 줘.']
];

function aiOpen() { AI.open = true; $('chat').classList.add('on'); aiRender(); setTimeout(() => $('chatInput').focus(), 120); }
function aiClose() { AI.open = false; $('chat').classList.remove('on'); }

function aiRender() {
  const box = $('chatBody');
  if (!AI.msgs.length) {
    box.innerHTML = `<div class="chat-empty">
      <div class="ci">${I.spark}</div>
      <p>할 일을 말로 정리하세요</p>
      <div class="sm">"다음주 화요일까지 회귀테스트 계획 잡고<br>담당 이슈 3개를 서브태스크로 넣어 줘"</div>
      <div class="chips">${AI_PRESETS.map(([l], i) => `<button class="chip-btn" data-preset="${i}">${esc(l)}</button>`).join('')}</div>
      ${DEMO ? '<div class="sm" style="margin-top:18px;opacity:.85">데모에서는 AI 호출이 비활성화됩니다.<br>실제 사용에는 Cloudflare Worker 프록시가 필요합니다.</div>'
             : (!AI.url ? '<div class="sm" style="margin-top:18px;color:var(--p1)">프록시 주소가 설정되지 않았습니다 — 우측 상단 톱니</div>' : '')}
    </div>`;
  } else {
    box.innerHTML = AI.msgs.map(m => {
      if (m.role === 'tool') {
        const ok = m.detail && m.detail.ok;
        return `<div class="msg tool ${ok ? '' : 'bad'}">${ok ? I.check2 : I.warn}<span>${esc(m.text)}</span>
          ${m.detail && m.detail.error ? `<em>${esc(m.detail.error)}</em>` : ''}</div>`;
      }
      if (m.role === 'err') return `<div class="msg err">${I.warn}<span>${esc(m.text)}</span></div>`;
      return `<div class="msg ${m.role}"><div class="bub">${esc(m.text).replace(/\n/g, '<br>')}</div></div>`;
    }).join('');
  }
  if (AI.busy) box.innerHTML += `<div class="msg ai"><div class="bub typing"><i></i><i></i><i></i></div></div>`;
  box.scrollTop = box.scrollHeight;
  $('chatSend').disabled = AI.busy || !$('chatInput').value.trim();
}

function aiRenderSettings() {
  const s = $('chatSettings');
  s.innerHTML = `
    <div class="field"><label>프록시 주소</label>
      <input id="aiUrl" placeholder="맥: http://localhost:8787  ·  전 기기: Apps Script 웹앱 주소" value="${esc(AI.url)}" spellcheck="false"></div>
    <div class="field" id="aiSecField"><label>Apps Script 시크릿</label>
      <input id="aiSecret" type="password" placeholder="setupSecret 로 만든 40자" value="${esc(store.get('saydo.aiSecret') || '')}" spellcheck="false" autocomplete="off"></div>
    <div class="field"><label>모델</label>
      <select id="aiModel" class="pill" style="width:100%">
        ${AI_MODELS.map(m => `<option value="${m}"${m === AI.model ? ' selected' : ''}>${m}</option>`).join('')}
      </select></div>
    <p class="note">API 키는 이 브라우저에 저장되지 않습니다. 프록시 서버에만 있습니다.
      태스크 제목이 Gemini 로 전송되므로 <b>유료 티어 키</b>를 쓰십시오 — 무료 티어는 약관상
      Google 이 학습에 사용하고 사람이 검토할 수 있습니다.<br>
      아이폰·아이패드에서는 <b>localhost 가 닿지 않습니다</b>. 맥의 프록시를 쓰려면 공개 주소가 필요합니다.</p>
    <div class="row">
      <button class="btn ghost" id="aiTest">연결 확인</button>
      <div class="spacer"></div>
      <button class="btn primary" id="aiSave">저장</button>
    </div>
    <div class="err hide" id="aiMsg"></div>`;
  s.classList.add('on');

  /* 시크릿 칸은 Apps Script 주소일 때만 의미가 있다 — 맥 로컬 프록시는 Google 토큰으로
     인증하므로 시크릿을 쓰지 않는다. 쓰이지 않는 칸을 띄워 두면 헷갈린다. */
  const syncSecField = () => $('aiSecField').classList.toggle('hide', !isAppsScript($('aiUrl').value));
  syncSecField();
  $('aiUrl').addEventListener('input', syncSecField);

  $('aiSave').onclick = () => {
    const u = $('aiUrl').value.trim();
    AI.url = u; store.set(AI_LS.url, u);
    store.set('saydo.aiSecret', $('aiSecret').value.trim());
    AI.model = $('aiModel').value; store.set(AI_LS.model, AI.model);
    AI.variant = ''; store.set(AI_LS.variant, '');      // 모델·주소가 바뀌면 형식 재탐색
    s.classList.remove('on'); toast('저장했습니다');
  };
  $('aiTest').onclick = async () => {
    const el = $('aiMsg'); el.classList.remove('hide'); el.textContent = '확인 중…';
    const u = $('aiUrl').value.trim().replace(/\/+$/, '');
    const bad = aiUrlProblem(u);
    if (bad) { el.style.color = 'var(--p1)'; el.textContent = bad; return; }
    try {
      const r = await fetch(isAppsScript(u) ? u : u + '/health');
      const j = await r.json();
      el.style.color = j.ok && j.hasKey ? 'var(--ok)' : 'var(--p1)';
      el.textContent = j.ok
        ? (j.hasKey
            ? '연결됨 · API 키 등록 확인' + (j.hasSecret === false ? ' (시크릿 미설정)' : '')
            : '연결됐지만 GEMINI_API_KEY 가 없습니다')
        : '응답이 예상과 다릅니다';
    } catch (e) {
      el.style.color = 'var(--p1)';
      el.textContent = '연결 실패 — 주소와 배포 상태를 확인해 주세요';
    }
  };
}

function aiWire() {
  $('chatIcon').innerHTML = I.spark;
  $('chatClose').innerHTML = I.close;
  $('chatCog').innerHTML = I.cog;
  $('chatSend').innerHTML = I.send;
  $('chatClose').onclick = aiClose;
  $('chatCog').onclick = aiRenderSettings;
  $('chatSettings').addEventListener('click', e => { if (e.target.id === 'chatSettings') e.target.classList.remove('on'); });

  const inp = $('chatInput');
  const grow = () => { inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 140) + 'px'; };
  inp.addEventListener('input', () => { grow(); $('chatSend').disabled = AI.busy || !inp.value.trim(); });
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  const submit = () => {
    const v = inp.value.trim(); if (!v || AI.busy) return;
    inp.value = ''; grow(); aiAsk(v);
  };
  $('chatSend').onclick = submit;
  $('chatBody').addEventListener('click', e => {
    const p = e.target.closest('[data-preset]');
    if (p) aiAsk(AI_PRESETS[+p.dataset.preset][1]);
  });
  $('chatClear').innerHTML = I.trash;
  $('chatClear').onclick = () => { AI.msgs = []; AI.lastId = null; AI.contents = []; aiRender(); };

  document.addEventListener('keydown', e => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
    if (e.key === 'a' || e.key === 'ㅁ') { e.preventDefault(); AI.open ? aiClose() : aiOpen(); }
  });
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-ai]');
    if (b) { e.preventDefault(); e.stopPropagation(); aiOpen(); }
  }, true);
}
aiWire();
aiRender();

