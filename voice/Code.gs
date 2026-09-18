/* ==========================================================================
   Saydo Voice — 시리 단축어용 Apps Script 백엔드
   --------------------------------------------------------------------------
   목표
     아이폰에서 앱을 열지 않고 말로 할 일을 확인하고 등록한다.
     "시리야, 할 일 추가"  → 받아쓰기 → 태스크 생성 → 결과를 말로 들려줌
     "시리야, 오늘 할 일"  → 오늘·지연 요약을 말로 들려줌

   왜 Apps Script 인가 (다른 후보가 전부 막혔다)
     Cloudflare Workers : Gemini 가 Cloudflare egress IP 를 거부 (지역 차단)
     Cloud Run          : 조직 정책이 allUsers invoker 를 금지 → 403
     맥 로컬            : 아이폰에서 localhost 는 아이폰 자신이라 닿지 않음
     Apps Script        : 호출이 Google 인프라에서 나가고, 항상 떠 있고,
                          키는 Script Properties 에 남고, 회사 Workspace 안이다.

   보안 모델
     1. GEMINI_API_KEY 와 SHARED_SECRET 은 Script Properties 에만 있다.
        코드에도, 단축어에도, 브라우저에도 키 자체는 들어가지 않는다.
     2. 모든 요청은 SHARED_SECRET 으로 검증한다. 타이밍 공격에 견디는 비교를 쓴다.
     3. Tasks API 는 ScriptApp.getOAuthToken() — 스크립트 소유자(=나) 권한으로만 돈다.
        남이 엔드포인트를 알아내도 시크릿이 없으면 아무것도 못 한다.
     4. 실패는 조용히 넘기지 않고 speak 로 이유를 돌려준다.

   데이터 호환
     Saydo 앱과 같은 ⟦…⟧ 메타 인코딩을 쓴다. 어느 쪽에서 만들어도 서로 읽는다.
   ========================================================================== */

var TASKS = 'https://tasks.googleapis.com/tasks/v1';
var GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';

/* 모델 이름을 하나로 박아 두면 그 모델이 은퇴하는 날 조용히 404 가 난다 —
   실제로 그렇게 겪었다. 후보를 순서대로 시도하고, 통한 것을 기억한다.
   스크립트 속성 GEMINI_MODEL 을 넣으면 그것만 쓴다. */
var MODEL_CANDIDATES = [
  'gemini-3.5-flash-lite', 'gemini-3.7-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
  /* 마지막 보루. 버전 별칭은 은퇴하지 않으므로, 위 이름들이 전부 사라진 뒤에도
     이 두 개는 남는다. 성능 특성이 조용히 바뀔 수 있어 앞에 두지는 않는다. */
  'gemini-flash-lite-latest', 'gemini-flash-latest'
];

/* 지정한 모델을 맨 앞에 두되, 후보를 끄지는 않는다.
   지정을 절대적으로 따르게 했더니 속성 오타 하나가 영구 404 가 됐다.
   개인용 도구에서는 "지정대로 실패" 보다 "지정을 우선하되 살아남기" 가 낫다. */
function modelList() {
  var out = [];
  var push = function (m) { if (m && out.indexOf(m) < 0) out.push(m); };
  push(props().getProperty('GEMINI_MODEL'));       // 사람이 고른 것
  push(props().getProperty('GEMINI_MODEL_OK'));    // 지난번에 통한 것
  MODEL_CANDIDATES.forEach(push);                  // 나머지 후보
  return out;
}
var META_OPEN = '⟦', META_CLOSE = '⟧';
var DOW = ['일', '월', '화', '수', '목', '금', '토'];

/* ───────────────────────── 진입점 ───────────────────────── */

function doPost(e) {
  try {
    return out(handle(JSON.parse((e && e.postData && e.postData.contents) || '{}')));
  } catch (err) {
    return out({ ok: false, speak: '오류가 발생했습니다. ' + trim(String(err), 120) });
  }
}

/* GET 은 두 가지 역할을 한다.
 *   (1) 파라미터가 없으면 배포 상태만 알려 준다 (비밀값은 절대 노출하지 않는다).
 *   (2) action 파라미터가 있으면 POST 와 똑같이 처리한다.
 *
 * (2)가 필요한 이유: Apps Script 의 /exec 는 googleusercontent.com 으로 302 를 보내는데,
 * 많은 HTTP 클라이언트(iOS 단축어 포함)가 302 에서 POST 를 GET 으로 바꾸며 본문을 버린다.
 * 그러면 서버는 doGet 을 받고 사용자는 "왜 상태 JSON 만 오지" 하게 된다.
 * POST 를 우선 쓰되, 막히면 쿼리 파라미터로 우회할 수 있게 열어 둔다.
 * 다만 쿼리에 시크릿을 실으면 URL 로그에 남으므로 폴백으로만 쓴다. */
function doGet(e) {
  var q = (e && e.parameter) || {};
  if (q.action) {
    try { return out(handle(q)); }
    catch (err) { return out({ ok: false, speak: '오류가 발생했습니다. ' + trim(String(err), 120) }); }
  }
  var p = props();
  return out({
    ok: true,
    service: 'saydo-voice',
    hasKey: !!p.getProperty('GEMINI_API_KEY'),
    hasSecret: !!p.getProperty('SHARED_SECRET')
  });
}

/** POST 본문과 GET 쿼리가 같은 모양이라 처리를 한 곳에 모은다. */
function handle(req) {
  /* 진단은 시크릿 검사 앞에 둔다 — 시크릿이 틀렸을 때 쓰는 기능이기 때문이다.
     대신 스크립트 속성 DEBUG=1 일 때만 응답한다. 문제를 잡은 뒤 그 속성을 지우면
     이 경로는 다시 닫힌다. */
  if (String(req.action || '') === 'debug') {
    if (props().getProperty('DEBUG') !== '1') return { ok: false, speak: '진단이 꺼져 있습니다.' };
    return debugSecret(req.secret);
  }
  if (!secretOk(req.secret)) return { ok: false, speak: '인증에 실패했습니다.' };
  var text = String(req.text || '').trim();
  switch (String(req.action || 'add')) {
    case 'add':    return actionAdd(text);
    case 'today':  return actionToday();
    case 'chat':   return actionChat(text, parseHistory(req.history), truthy(req.voice));
    case 'models': return actionModels();
    case 'ping':   return { ok: true, speak: '연결됐습니다.' };
    default:      return { ok: false, speak: '알 수 없는 동작입니다.' };
  }
}

/** 대화 이력. POST 본문이면 배열로, GET 쿼리면 JSON 문자열로 온다.
 *  깨져 있으면 이력 없이 진행한다 — 이력 때문에 대화 자체가 막히면 안 된다. */
function parseHistory(h) {
  if (Array.isArray(h)) return h.slice(-8);
  if (typeof h === 'string' && h) {
    try { var a = JSON.parse(h); return Array.isArray(a) ? a.slice(-8) : []; } catch (e) { return []; }
  }
  return [];
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ───────────────────────── 인증 ───────────────────────── */

function props() { return PropertiesService.getScriptProperties(); }

/** 길이 정보까지 감추지는 못하지만, 앞자리만 맞아도 통과하는 조기 종료는 막는다. */
function secretOk(given) {
  var want = props().getProperty('SHARED_SECRET') || '';
  var got = String(given || '');
  if (!want || want.length !== got.length) return false;
  var diff = 0;
  for (var i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

/** 시크릿이 왜 안 맞는지 알려 준다. 값 자체는 절대 돌려주지 않는다.
 *
 *  돌려주는 것은 길이, 지문(SHA-256 앞 8자리), 앞뒤 공백 여부뿐이다.
 *  지문 8자리는 32비트라 역산으로 원문을 얻을 수 없고, 두 지문이 같은지만 알려 준다.
 *  실제로 이 세 가지로 원인 대부분이 잡힌다 —
 *    길이가 다르다     → 따옴표가 붙었거나 복사가 잘렸다
 *    앞뒤 공백이 있다  → 붙여넣기에 줄바꿈·공백이 딸려 왔다
 *    길이는 같은데 지문이 다르다 → 곱은따옴표 등 눈에 안 보이는 글자 치환 */
function debugSecret(given) {
  var want = props().getProperty('SHARED_SECRET') || '';
  var got = given == null ? '' : String(given);
  return {
    ok: true,
    speak: '진단 결과입니다.',
    want_len: want.length,
    got_len: got.length,
    want_fp: fp(want),
    got_fp: fp(got),
    got_has_outer_space: got !== got.replace(/^\s+|\s+$/g, ''),
    got_nonascii: /[^\x20-\x7E]/.test(got),
    match: secretOk(got)
  };
}

function fp(s) {
  if (!s) return '';
  var b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  var h = '';
  for (var i = 0; i < 4; i++) {
    var v = (b[i] + 256) % 256;
    h += (v < 16 ? '0' : '') + v.toString(16);
  }
  return h;
}

/* ───────────────────────── 동작 1: 말로 등록 ───────────────────────── */

function actionAdd(text) {
  if (!text) return { ok: false, speak: '무엇을 추가할지 못 들었습니다.' };

  var parsed = geminiParse(text);
  if (!parsed.ok) return { ok: false, speak: parsed.speak };

  var lists = listTasklists();
  var prob = listsProblem();
  if (prob) return { ok: false, speak: prob };
  if (!lists.length) return { ok: false, speak: '태스크 목록이 하나도 없습니다.' };

  var target = matchList(lists, parsed.list) || lists[0];
  var meta = {
    p: parsed.priority || 4,
    labels: parsed.labels || [],
    time: parsed.time || null,
    rec: null, dur: null
  };

  var task = { title: parsed.title, notes: encodeNotes(parsed.notes || '', meta) };
  if (parsed.due) task.due = parsed.due + 'T00:00:00.000Z';

  var made = api('POST', '/lists/' + target.id + '/tasks', task);
  if (!made || !made.id) {
    return { ok: false, speak: '태스크를 만들지 못했습니다. ' + (API_LAST_ERROR || '') };
  }

  var when = parsed.due ? humanDate(parsed.due, parsed.time) : '기한 없이';
  var pri = parsed.priority && parsed.priority < 4 ? ' 우선순위 ' + parsed.priority + '로' : '';
  return { ok: true, speak: when + pri + ' ' + parsed.title + ', ' + target.title + '에 추가했습니다.' };
}

/* ───────────────────────── 동작 2: 오늘 할 일 ───────────────────────── */

function actionToday() {
  var today = todayY();
  var overdue = [], due = [];

  var lists = listTasklists();
  var prob = listsProblem();
  if (prob) return { ok: false, speak: prob };
  if (!lists.length) return { ok: false, speak: '태스크 목록이 하나도 없습니다.' };

  lists.forEach(function (l) {
    (fetchTasks(l.id) || []).forEach(function (t) {
      if (t.status === 'completed' || !t.due) return;
      var d = t.due.slice(0, 10);                       // 타임존 변환 금지
      var gap = diffDays(d, today);
      var row = { title: t.title, list: l.title, gap: gap, meta: decodeNotes(t.notes || '').meta };
      if (gap < 0) overdue.push(row); else if (gap === 0) due.push(row);
    });
  });

  if (!overdue.length && !due.length) return { ok: true, speak: '오늘 기한인 할 일이 없습니다.' };

  var parts = [];
  if (due.length) {
    parts.push('오늘 할 일 ' + due.length + '건입니다. ' + speakList(sortByPriority(due)));
  }
  if (overdue.length) {
    overdue.sort(function (a, b) { return a.gap - b.gap; });
    parts.push('기한이 지난 것은 ' + overdue.length + '건이고, 가장 오래된 것은 '
      + (-overdue[0].gap) + '일 지난 ' + overdue[0].title + '입니다.');
  }
  return { ok: true, speak: parts.join(' ') };
}

function sortByPriority(rows) {
  return rows.slice().sort(function (a, b) { return (a.meta.p || 4) - (b.meta.p || 4); });
}

/** 말로 듣는 것이라 다섯 건에서 끊는다. 열 건을 읽어 주면 아무것도 안 남는다. */
function speakList(rows) {
  var top = rows.slice(0, 5).map(function (r) {
    return (r.meta.p === 1 ? '긴급, ' : '') + r.title;
  }).join('. ');
  return top + (rows.length > 5 ? '. 그 외 ' + (rows.length - 5) + '건이 더 있습니다.' : '.');
}

/* ───────────────────────── Gemini ───────────────────────── */

/** 이 키로 실제 쓸 수 있는 모델을 물어본다. 404 가 났을 때 추측을 끝내는 수단이다. */
function actionModels() {
  var key = props().getProperty('GEMINI_API_KEY');
  if (!key) return { ok: false, speak: 'API 키가 설정되지 않았습니다.' };

  var res = UrlFetchApp.fetch(GEMINI + '?pageSize=200', {
    method: 'get', headers: { 'x-goog-api-key': key }, muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    return { ok: false, speak: '모델 목록 조회 실패 ' + res.getResponseCode() + ' ' + trim(res.getContentText(), 150) };
  }

  var items = (JSON.parse(res.getContentText() || '{}').models) || [];
  var usable = [];
  items.forEach(function (m) {
    var methods = m.supportedGenerationMethods || m.supported_generation_methods || [];
    if (methods.indexOf('generateContent') >= 0) usable.push(String(m.name || '').replace(/^models\//, ''));
  });

  return {
    ok: true,
    speak: '사용 가능한 모델 ' + usable.length + '개입니다.',
    current: props().getProperty('GEMINI_MODEL') || props().getProperty('GEMINI_MODEL_OK') || '(미확정)',
    candidates: MODEL_CANDIDATES,
    usable: usable
  };
}

function geminiParse(text) {
  var key = props().getProperty('GEMINI_API_KEY');
  if (!key) return { ok: false, speak: 'API 키가 설정되지 않았습니다.' };

  var today = todayY();
  var lists = listTasklists().map(function (l) { return l.title; });

  var prompt = [
    '너는 한국어 음성 지시를 태스크로 바꾸는 파서다. JSON 만 출력한다.',
    '오늘은 ' + today + ' (' + DOW[new Date().getDay()] + '요일), 시간대는 Asia/Seoul.',
    '사용 가능한 목록: ' + lists.join(', '),
    '',
    '규칙:',
    '- title 에서 날짜·시간·우선순위 표현을 빼고 할 일만 남긴다.',
    '- due 는 YYYY-MM-DD 로 오늘 기준 계산한다. "내일" "다음주 화요일" 같은 말을 그대로 두지 않는다.',
    '- time 은 HH:MM 24시간제. 없으면 생략.',
    '- priority 는 1=긴급 2=높음 3=보통 4=없음. "급한" "중요" 같은 말이 있을 때만 4 미만.',
    '- list 는 위 목록 중 하나와 정확히 일치시키고, 확신이 없으면 생략한다.',
    '- 받아쓰기 오류가 있을 수 있으니 문맥으로 자연스럽게 교정한다.',
    '',
    '입력: ' + text
  ].join('\n');

  var schema = {
    type: 'OBJECT',
    properties: {
      title: { type: 'STRING' },
      due: { type: 'STRING' },
      time: { type: 'STRING' },
      priority: { type: 'INTEGER' },
      labels: { type: 'ARRAY', items: { type: 'STRING' } },
      list: { type: 'STRING' },
      notes: { type: 'STRING' }
    },
    required: ['title']
  };

  var payload = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
      responseSchema: schema
    }
  });

  var models = modelList(), code = 0, raw = '', used = '';
  for (var mi = 0; mi < models.length; mi++) {
    var res = UrlFetchApp.fetch(GEMINI + '/' + models[mi] + ':generateContent', {
      method: 'post', contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      muteHttpExceptions: true, payload: payload
    });
    code = res.getResponseCode(); raw = res.getContentText();
    if (code === 200) { used = models[mi]; break; }
    if (code === 404) continue;              // 이 모델이 없다 — 다음 후보로
    break;                                   // 그 밖의 오류는 모델을 바꿔도 같다
  }

  if (code !== 200) {
    if (/User location is not supported/i.test(raw)) {
      return { ok: false, speak: 'Gemini 가 이 서버 위치를 거부했습니다.' };
    }
    if (code === 404) {
      return { ok: false, speak: '쓸 수 있는 Gemini 모델을 찾지 못했습니다. '
        + 'action=models 로 사용 가능한 모델을 확인한 뒤 스크립트 속성 GEMINI_MODEL 에 넣어 주세요.' };
    }
    if (code === 400 && /API key not valid/i.test(raw)) {
      return { ok: false, speak: 'Gemini API 키가 유효하지 않습니다.' };
    }
    if (code === 429) return { ok: false, speak: 'Gemini 호출 한도를 넘었습니다.' };
    return { ok: false, speak: 'Gemini 요청이 실패했습니다. 코드 ' + code + ' ' + trim(raw, 100) };
  }

  /* 통한 모델을 기억해 다음부터는 한 번에 간다. */
  if (used && used !== props().getProperty('GEMINI_MODEL_OK')) {
    props().setProperty('GEMINI_MODEL_OK', used);
  }

  var j = JSON.parse(raw);
  var cand = (j.candidates || [])[0] || {};
  var parts = ((cand.content || {}).parts) || [];
  var body = '';
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].thought) continue;                    // 생각 파트는 본문이 아니다
    if (typeof parts[i].text === 'string') body += parts[i].text;
  }
  if (!body) {
    return { ok: false, speak: cand.finishReason === 'MAX_TOKENS'
      ? '응답이 너무 길어 잘렸습니다.' : '해석하지 못했습니다. 다시 말씀해 주세요.' };
  }

  var o;
  try { o = JSON.parse(body); } catch (e) { return { ok: false, speak: '해석 결과를 읽지 못했습니다.' }; }
  if (!o.title) return { ok: false, speak: '무엇을 추가할지 파악하지 못했습니다.' };

  o.ok = true;
  return o;
}

/* ───────────────────────── Google Tasks ───────────────────────── */

/* 마지막 Tasks API 실패를 담아 둔다.
   실패를 null 로만 돌려주면 "목록이 비었다" 와 "못 읽었다" 가 구분되지 않는다.
   그러면 권한이 없을 때 "할 일이 없습니다" 라고 태연히 말하게 된다 — 앱에서 이미
   한 번 겪은 실수라 여기서는 처음부터 구분한다. */
var API_LAST_ERROR = null;

function api(method, path, payload) {
  var opt = {
    method: method,
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }
  };
  if (payload) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(payload); }
  var res = UrlFetchApp.fetch(TASKS + path, opt);
  var code = res.getResponseCode();
  if (code >= 300) {
    API_LAST_ERROR = code + ' ' + trim(String(res.getContentText() || ''), 200);
    return null;
  }
  API_LAST_ERROR = null;
  return JSON.parse(res.getContentText() || '{}');
}

/** 목록을 못 읽은 이유를 사람 말로. 읽었으면 빈 문자열.
 *
 *  403 을 한 덩어리로 다루면 안 된다. 실제로 겪은 두 경우가 조치가 정반대다.
 *    SERVICE_DISABLED : Tasks API 가 이 프로젝트에서 꺼져 있다 → 서비스 추가
 *    권한 미승인       : 스코프를 승인하지 않았다              → checkSetup 실행 */
function listsProblem() {
  if (!API_LAST_ERROR) return '';
  if (/SERVICE_DISABLED|has not been used in project|is disabled/i.test(API_LAST_ERROR)) {
    return 'Google Tasks API 가 이 스크립트의 프로젝트에서 꺼져 있습니다. '
         + '편집기 왼쪽 서비스 + 에서 Tasks API 를 추가해 주세요.';
  }
  if (/^401/.test(API_LAST_ERROR) || /insufficient|unauthorized|invalid_token/i.test(API_LAST_ERROR)) {
    return 'Google 태스크 접근 권한이 없습니다. 편집기에서 checkSetup 을 실행해 권한을 승인해 주세요.';
  }
  if (/^403/.test(API_LAST_ERROR)) {
    return 'Google 태스크 접근이 거부됐습니다. ' + trim(API_LAST_ERROR, 120);
  }
  return 'Google 태스크를 읽지 못했습니다. ' + trim(API_LAST_ERROR, 120);
}

function listTasklists() {
  var r = api('GET', '/users/@me/lists?maxResults=100');
  return (r && r.items) || [];
}

function fetchTasks(listId) {
  var r = api('GET', '/lists/' + listId + '/tasks?maxResults=100&showCompleted=false');
  return (r && r.items) || [];
}

/** 이름이 정확히 같은 것 우선, 없으면 부분 일치. Saydo 앱과 같은 규칙. */
function matchList(lists, name) {
  if (!name) return null;
  var q = String(name).toLowerCase().replace(/\s/g, '');
  var exact = null, partial = null;
  lists.forEach(function (l) {
    var t = l.title.toLowerCase().replace(/\s/g, '');
    if (t === q && !exact) exact = l;
    else if (t.indexOf(q) >= 0 && !partial) partial = l;
  });
  return exact || partial;
}

/* ───────────────────────── 메타 인코딩 (core.js 와 동일) ───────────────────────── */

function encodeNotes(body, meta) {
  var t = [];
  if (meta.p && meta.p < 4) t.push('p' + meta.p);
  (meta.labels || []).forEach(function (l) { t.push('@' + String(l).replace(/\s+/g, '_')); });
  if (meta.time) t.push('⏰' + meta.time);
  if (meta.rec) t.push('↻' + serRec(meta.rec));
  if (meta.dur) t.push('⏳' + meta.dur);
  var base = String(body || '').replace(/\s+$/, '');
  if (!t.length) return base;
  return (base ? base + '\n\n' : '') + META_OPEN + t.join(' ') + META_CLOSE;
}

function decodeNotes(notes) {
  var meta = { p: 4, labels: [], time: null, rec: null, dur: null };
  if (!notes) return { body: '', meta: meta };
  var m = String(notes).match(/\n?⟦([^⟧]*)⟧\s*$/);
  if (!m) return { body: notes, meta: meta };
  m[1].split(/\s+/).forEach(function (tok) {
    if (!tok) return;
    if (/^p[1-4]$/.test(tok)) meta.p = +tok[1];
    else if (tok.charAt(0) === '@') meta.labels.push(tok.slice(1).replace(/_/g, ' '));
    else if (tok.charAt(0) === '⏰') meta.time = tok.slice(1);
    else if (tok.charAt(0) === '↻') meta.rec = parseRec(tok.slice(1));
    else if (tok.charAt(0) === '⏳') meta.dur = +tok.slice(1) || null;
  });
  return { body: notes.slice(0, m.index).replace(/\s+$/, ''), meta: meta };
}

/* ───────────────────────── 반복 ─────────────────────────
   **core.js 와 글자 단위로 같은 규칙이어야 한다.** 앱과 이 백엔드가 같은 notes 를
   읽고 쓰기 때문에, 한쪽이 ↻ 를 모르면 그쪽에서 저장하는 순간 반복 규칙이 사라진다.
   실제로 그랬다 — decodeNotes 가 ↻ 를 버리고 encodeNotes 가 다시 쓰지 않아서,
   시리나 AI 로 태스크를 한 번만 고쳐도 "매주 월요일" 이 조용히 일회성이 됐다.
   voicetest.js 가 두 구현의 결과를 대조한다. */
function parseRec(s) {
  if (s === 'wd') return { type: 'weekday', interval: 1 };
  var m = s.match(/^w(\d+):([0-6]*)$/);
  if (m) return { type: 'week', interval: +m[1], days: m[2].split('').map(Number) };
  m = s.match(/^([dwmy])(\d+)$/);
  if (!m) return null;
  var type = { d: 'day', w: 'week', m: 'month', y: 'year' }[m[1]];
  return type === 'week' ? { type: type, interval: +m[2], days: [] } : { type: type, interval: +m[2] };
}
function serRec(r) {
  if (r.type === 'weekday') return 'wd';
  if (r.type === 'week') return 'w' + r.interval + ':' + ((r.days || []).join(''));
  return r.type.charAt(0) + r.interval;
}
/** 반복 태스크를 완료했을 때 옮겨 갈 다음 기한. core.js 의 nextDue 와 같은 규칙. */
function nextDue(y, r) {
  if (!r) return null;
  var cur = y || todayY();
  if (diffDays(cur, todayY()) < 0) cur = todayY();
  if (r.type === 'day') return addDays(cur, r.interval);
  if (r.type === 'month') return addMonths(cur, r.interval);
  if (r.type === 'year') return addMonths(cur, 12 * r.interval);
  if (r.type === 'weekday') { var n = addDays(cur, 1); while ([0, 6].indexOf(fromYmd(n).getDay()) >= 0) n = addDays(n, 1); return n; }
  if (r.type === 'week') {
    var days = (r.days && r.days.length) ? r.days.slice().sort() : [fromYmd(cur).getDay()];
    for (var i = 1; i <= 7; i++) { var c = addDays(cur, i); if (days.indexOf(fromYmd(c).getDay()) >= 0) return c; }
    return addDays(cur, 7 * r.interval);
  }
  return null;
}

/* ───────────────────────── 날짜 ───────────────────────── */

function pad(n) { return String(n).length < 2 ? '0' + n : String(n); }
function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function todayY() { return ymd(new Date()); }
function fromYmd(s) { var a = s.split('-'); return new Date(+a[0], +a[1] - 1, +a[2]); }
function diffDays(a, b) { return Math.round((fromYmd(a) - fromYmd(b)) / 864e5); }
function addDays(s, n) { var d = fromYmd(s); d.setDate(d.getDate() + n); return ymd(d); }
function addMonths(s, n) {
  var d = fromYmd(s), day = d.getDate();
  d.setDate(1); d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return ymd(d);
}

function humanDate(y, time) {
  var d = diffDays(y, todayY()), dt = fromYmd(y), s;
  if (d === 0) s = '오늘';
  else if (d === 1) s = '내일';
  else if (d === -1) s = '어제';
  else if (d > 1 && d < 7) s = DOW[dt.getDay()] + '요일';
  else s = (dt.getMonth() + 1) + '월 ' + dt.getDate() + '일';
  return time ? s + ' ' + time.replace(':', '시 ') + '분에' : s + '에';
}

function trim(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }
/* 쿼리로 들어오면 값이 문자열이다 — '1'·'true'·'yes' 를 참으로 본다. */
function truthy(v) { var t = String(v == null ? '' : v).toLowerCase(); return t === '1' || t === 'true' || t === 'yes'; }

/* 시리로 읽어 줄 문장은 길면 안 된다. 문장 경계에서 자르되, 경계를 못 찾으면 그냥 자른다.
   화면에서는 길어도 스크롤하면 되지만 음성은 끝까지 들어야 하므로 한도를 둔다. */
var VOICE_MAX = 420;
function trimSpeech(s) {
  s = String(s || '').replace(/[*_#`>|]/g, '').replace(/\s*\n+\s*/g, ' ').trim();
  if (s.length <= VOICE_MAX) return s;
  var cut = s.slice(0, VOICE_MAX);
  var m = cut.lastIndexOf('. '), m2 = cut.lastIndexOf('다. ');
  var at = Math.max(m, m2);
  return (at > VOICE_MAX * 0.5 ? cut.slice(0, at + 1) : cut) + ' 자세한 내용은 앱에서 확인하세요.';
}

/* ───────────────────────── 설치 도우미 ───────────────────────── */

/** 편집기에서 한 번 실행한다. 시크릿을 만들어 로그에 찍어 준다.
 *  이미 있으면 덮어쓰지 않는다 (단축어가 죽는 것을 막기 위해). */
function setupSecret() {
  var p = props();
  var cur = p.getProperty('SHARED_SECRET');
  if (cur) { Logger.log('이미 있습니다: ' + cur); return; }
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  var s = '';
  for (var i = 0; i < 40; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  p.setProperty('SHARED_SECRET', s);
  Logger.log('SHARED_SECRET = ' + s);
}

/** 편집기에서 실행해 설정 전체를 한 번에 점검한다.
 *  배포하지 않아도 되므로 문제를 잡을 때는 여기부터 본다. */
function checkSetup() {
  var p = props();
  Logger.log('GEMINI_API_KEY: ' + (p.getProperty('GEMINI_API_KEY') ? '있음' : '없음'));
  Logger.log('SHARED_SECRET : ' + (p.getProperty('SHARED_SECRET') ? '있음' : '없음'));

  var lists = listTasklists();
  if (API_LAST_ERROR) Logger.log('Tasks API 실패: ' + API_LAST_ERROR);
  Logger.log('목록 ' + lists.length + '개: ' + lists.map(function (l) { return l.title; }).join(', '));
  Logger.log('오늘 요약 시험: ' + JSON.stringify(actionToday()));

  /* 모델은 은퇴한다. 어떤 이름이 살아 있는지 배포 없이 여기서 확인한다. */
  var m = actionModels();
  Logger.log('현재 모델: ' + (m.current || '-'));
  Logger.log('사용 가능 모델: ' + (m.usable ? m.usable.join(', ') : m.speak));

  Logger.log('등록 시험(실제로 만들지는 않음): ' + JSON.stringify(geminiParse('내일 오후 3시 설정 점검 급한 걸로')));
}

/* ═══════════════════════ 동작 3: 대화형 어시스턴트 ═══════════════════════
   앱(브라우저)이 부르는 창구다. 시리 경로와 같은 엔진·같은 키·같은 메타 인코딩을 쓴다.

   왜 도구 실행까지 서버에서 하는가
     브라우저가 프롬프트를 만들어 보내던 기존 구조는 Apps Script 로 못 옮긴다.
       · CORS  : Authorization 헤더 + application/json 은 preflight(OPTIONS)를 부르는데
                 Apps Script 는 OPTIONS 를 처리하지 못한다.
       · 크기  : 도구 정의 6개 + 태스크 스냅샷 전체는 GET 쿼리에 담을 수 없다.
     그래서 브라우저는 사용자 문장 한 줄만 보내고, 스냅샷 수집·모델 호출·도구 실행을
     전부 여기서 한다. 요청이 작아져 GET 으로도 넘어가고, 음성과 앱이 한 구현을 공유한다.

   보내는 데이터
     열려 있는 태스크의 제목·기한·우선순위·라벨·목록만. 실제 Google ID 는 보내지 않고
     t1, t2 … 별칭으로 치환한다 (토큰 절약 + 식별자 노출 최소화).            */

var CHAT_MAX_STEPS = 6;      // 도구 호출 왕복 상한 (무한 루프 방지)
var CHAT_MAX_OUT = 8192;     // 분석 답변이 잘리지 않도록

var CHAT_TOOLS = [
  { name: 'create_task',
    description: '새 태스크를 만든다. 할 일을 추가해 달라는 요청에 쓴다.',
    parameters: { type: 'OBJECT', properties: {
      title: { type: 'STRING', description: '제목. 날짜·우선순위 표현은 빼고 각 인자로' },
      notes: { type: 'STRING' }, due: { type: 'STRING', description: 'YYYY-MM-DD' },
      time: { type: 'STRING', description: 'HH:MM 24시간제' },
      priority: { type: 'INTEGER', description: '1=긴급 2=높음 3=보통 4=없음' },
      labels: { type: 'ARRAY', items: { type: 'STRING' } },
      list: { type: 'STRING', description: '목록 이름' },
      parent_id: { type: 'STRING', description: '상위 태스크 id(t3 형식). 지정하면 서브태스크' }
    }, required: ['title'] } },
  { name: 'update_task',
    description: '기존 태스크의 제목·기한·우선순위·라벨·설명을 바꾼다.',
    parameters: { type: 'OBJECT', properties: {
      id: { type: 'STRING' }, title: { type: 'STRING' }, notes: { type: 'STRING' },
      due: { type: 'STRING', description: 'YYYY-MM-DD. 빈 문자열이면 기한 해제' },
      time: { type: 'STRING' }, priority: { type: 'INTEGER' },
      labels: { type: 'ARRAY', items: { type: 'STRING' } }
    }, required: ['id'] } },
  { name: 'complete_task', description: '태스크를 완료 처리한다.',
    parameters: { type: 'OBJECT', properties: { id: { type: 'STRING' } }, required: ['id'] } },
  { name: 'move_task',
    description: '다른 목록으로 옮기거나, 다른 태스크의 서브태스크로 만들거나, 최상위로 올린다.',
    parameters: { type: 'OBJECT', properties: {
      id: { type: 'STRING' }, list: { type: 'STRING' },
      parent_id: { type: 'STRING', description: '빈 문자열이면 최상위로' }
    }, required: ['id'] } },
  { name: 'delete_task', description: '삭제한다. 사용자가 명시적으로 요청했을 때만 쓴다.',
    parameters: { type: 'OBJECT', properties: { id: { type: 'STRING' } }, required: ['id'] } },
  { name: 'create_list', description: '새 목록을 만든다.',
    parameters: { type: 'OBJECT', properties: { title: { type: 'STRING' } }, required: ['title'] } }
];

/** 별칭 t1..tN ↔ 실제 {listId,taskId}. 요청 한 번 동안만 유효하다. */
var CHAT_ALIAS = {};

function chatSnapshot() {
  CHAT_ALIAS = {};
  var lists = listTasklists();
  var prob = listsProblem();
  if (prob) return { error: prob };

  var rows = [], n = 0, rev = {};
  lists.forEach(function (l) {
    (fetchTasks(l.id) || []).forEach(function (t) {
      if (t.status === 'completed') return;
      var a = 't' + (++n);
      CHAT_ALIAS[a] = { listId: l.id, taskId: t.id };
      rev[t.id] = a;
      var d = decodeNotes(t.notes || '');
      var r = { id: a, title: t.title, list: l.title };
      if (t.due) {
        r.due = t.due.slice(0, 10);
        var gap = diffDays(r.due, todayY());
        if (gap < 0) r.overdue_days = -gap;
      }
      if (d.meta.time) r.time = d.meta.time;
      if (d.meta.p < 4) r.priority = d.meta.p;
      if (d.meta.labels.length) r.labels = d.meta.labels;
      if (d.body) r.notes = d.body.slice(0, 140);
      if (t.parent) r._parent = t.parent;
      rows.push(r);
    });
  });
  /* 부모도 별칭으로 — 실제 id 가 모델에 새어 나가지 않게 한다 */
  rows.forEach(function (r) {
    if (r._parent) { if (rev[r._parent]) r.parent = rev[r._parent]; delete r._parent; }
  });

  return { today: todayY(), weekday: DOW[new Date().getDay()] + '요일', timezone: 'Asia/Seoul',
           lists: lists.map(function (l) { return l.title; }), tasks: rows };
}

function chatSystem(snap, voice) {
  /* 같은 도구·같은 스냅샷을 쓰되 **답을 어디로 내보내느냐**가 다르다.
     화면(앱 어시스턴트)에서는 길어도 스크롤하면 되지만, 시리는 끝까지 들어야 하므로
     길이·형식 규칙이 정반대가 된다. 그래서 이 한 덩어리만 갈아 끼운다. */
  var tail = voice
    ? ['- **이 답은 시리가 소리내어 읽는다.** 마크다운·목록기호·괄호·이모지를 쓰지 않는다.',
       '- 3문장 이내, 200자 안쪽으로 말하듯이 답한다. 숫자는 "세 건" 처럼 읽기 좋게 쓴다.',
       '- 할 일을 열거할 때는 가장 급한 것 위주로 최대 다섯 개까지만 말하고,',
       '  나머지는 "그 밖에 몇 건 더 있습니다" 로 뭉뚱그린다.',
       '- 분석·계획·리뷰 요청이어도 길게 늘어놓지 않는다. 핵심 한 가지와 다음 행동 한 가지만 말한다.']
    : ['- 도구 실행 후에는 무엇을 했는지 한두 문장으로 짧게 알린다.',
       '- 분석·계획·리뷰·요약 요청에는 도구를 호출하지 말고 반드시 본문 텍스트로 답한다.',
       '  짧게가 아니라 충실하게 쓴다. 근거가 되는 태스크 제목을 인용하고, 패턴을 짚은 뒤',
       '  실행 가능한 제안으로 끝낸다. 빈 응답이나 "완료했습니다" 같은 답은 금지한다.'];

  return [
    '너는 Saydo 라는 개인 태스크 관리 앱의 어시스턴트다. 한국어로 답한다.',
    '',
    '규칙:',
    '- 태스크를 만들거나 바꿔 달라는 요청에는 반드시 도구를 호출한다. 말로만 "추가했습니다" 라고 하지 않는다.',
    '- 여러 건이면 도구를 여러 번 호출한다.',
    '- 태스크 id 는 아래 목록의 id(t1, t2 …)를 그대로 쓴다. 없는 id 를 지어내지 않는다.',
    '- 날짜는 today 기준으로 계산해 YYYY-MM-DD 로 넣는다. "다음주 화요일" 을 그대로 넘기지 않는다.',
    '- 삭제는 사용자가 명시적으로 요청했을 때만 한다.'
  ].concat(tail).concat([
    '',
    '현재 상태 (JSON):',
    JSON.stringify(snap)
  ]).join('\n');
}

function actionChat(text, history, voice) {
  if (!text) return { ok: false, speak: '무엇을 도와드릴까요?' };
  /* voice=1 이면 시리가 읽어 줄 답이다 — 프롬프트와 길이 규칙이 달라진다. */
  var say = function (t) { return voice ? trimSpeech(t) : t; };
  var key = props().getProperty('GEMINI_API_KEY');
  if (!key) return { ok: false, speak: 'API 키가 설정되지 않았습니다.' };

  var snap = chatSnapshot();
  if (snap.error) return { ok: false, speak: snap.error };

  var contents = [];
  (history || []).forEach(function (h) {
    if (h && h.role && h.text) contents.push({ role: h.role === 'ai' ? 'model' : 'user', parts: [{ text: String(h.text) }] });
  });
  contents.push({ role: 'user', parts: [{ text: text }] });

  var done = [], changed = false;

  for (var step = 0; step <= CHAT_MAX_STEPS; step++) {
    var r = geminiCall(key, chatSystem(snap, voice), contents);
    if (!r.ok) return { ok: false, speak: r.speak };

    if (!r.calls.length) {
      if (r.text) return { ok: true, speak: say(r.text), actions: done, changed: changed };
      /* 본문 없이 끝났다 — 생각에 예산을 다 쓴 경우다. 생각을 끄고 한 번만 다시 묻는다. */
      if (step < CHAT_MAX_STEPS) {
        var r2 = geminiCall(key, chatSystem(snap, voice), contents, true);
        if (r2.ok && r2.text) return { ok: true, speak: say(r2.text), actions: done, changed: changed };
      }
      return { ok: false, speak: chatEmptyWhy(r), actions: done, changed: changed };
    }

    contents.push(r.content);
    var parts = [];
    r.calls.forEach(function (c) {
      var res = chatRunTool(c.name, c.args);
      if (res.ok) { changed = true; done.push(c.name); }
      parts.push({ functionResponse: { name: c.name, response: { result: res } } });
    });
    contents.push({ role: 'user', parts: parts });
    snap = chatSnapshot();                       // 바뀐 상태를 다시 싣는다
    if (snap.error) return { ok: false, speak: snap.error, actions: done, changed: changed };
  }
  return { ok: true, speak: '요청을 처리했습니다.', actions: done, changed: changed };
}

function chatEmptyWhy(r) {
  if (r.blocked) return 'Gemini 가 응답을 차단했습니다 (' + r.blocked + '). 표현을 바꿔 다시 시도해 주세요.';
  if (r.finish === 'MAX_TOKENS') return '답변이 출력 한도에 걸려 잘렸습니다. 질문 범위를 좁혀 주세요.';
  if (r.finish === 'SAFETY' || r.finish === 'PROHIBITED_CONTENT') return 'Gemini 안전 필터에 걸렸습니다 (' + r.finish + ').';
  return '모델이 빈 응답을 반환했습니다' + (r.finish ? ' (' + r.finish + ')' : '') + '. 다시 시도해 주세요.';
}

/** 도구 정의를 붙여 Gemini 를 부른다. geminiParse 와 달리 스키마 대신 함수 선언을 쓴다. */
function geminiCall(key, systemText, contents, noThink) {
  var gc = { temperature: 0.2, maxOutputTokens: CHAT_MAX_OUT };
  if (noThink) gc.thinkingConfig = { thinkingBudget: 0 };
  var payload = JSON.stringify({
    systemInstruction: { parts: [{ text: systemText }] },
    contents: contents,
    tools: [{ functionDeclarations: CHAT_TOOLS }],
    generationConfig: gc
  });

  var models = modelList(), code = 0, raw = '', used = '';
  for (var i = 0; i < models.length; i++) {
    var res = UrlFetchApp.fetch(GEMINI + '/' + models[i] + ':generateContent', {
      method: 'post', contentType: 'application/json',
      headers: { 'x-goog-api-key': key }, muteHttpExceptions: true, payload: payload
    });
    code = res.getResponseCode(); raw = res.getContentText();
    if (code === 200) { used = models[i]; break; }
    if (code === 404) continue;
    break;
  }
  if (code !== 200) {
    if (/User location is not supported/i.test(raw)) return { ok: false, speak: 'Gemini 가 이 서버 위치를 거부했습니다.' };
    if (code === 404) return { ok: false, speak: '쓸 수 있는 Gemini 모델을 찾지 못했습니다.' };
    if (code === 429) return { ok: false, speak: 'Gemini 호출 한도를 넘었습니다.' };
    return { ok: false, speak: 'Gemini 요청이 실패했습니다. 코드 ' + code + ' ' + trim(raw, 100) };
  }
  if (used && used !== props().getProperty('GEMINI_MODEL_OK')) props().setProperty('GEMINI_MODEL_OK', used);

  var j = JSON.parse(raw), cand = (j.candidates || [])[0] || {};
  var out = { ok: true, text: '', calls: [], content: cand.content || { role: 'model', parts: [] },
              finish: String(cand.finishReason || ''),
              blocked: String((j.promptFeedback && j.promptFeedback.blockReason) || '') };
  ((cand.content || {}).parts || []).forEach(function (p) {
    if (p.functionCall) out.calls.push({ name: p.functionCall.name, args: p.functionCall.args || {} });
    else if (p.thought) { /* 생각은 본문이 아니다 */ }
    else if (typeof p.text === 'string') out.text += p.text;
  });
  return out;
}

/* ───────────────────────── 도구 실행 ───────────────────────── */

function chatResolve(alias) { return CHAT_ALIAS[String(alias || '')] || null; }

function chatRunTool(name, args) {
  args = args || {};
  try {
    switch (name) {
      case 'create_task':   return toolCreate(args);
      case 'update_task':   return toolUpdate(args);
      case 'complete_task': return toolComplete(args);
      case 'move_task':     return toolMove(args);
      case 'delete_task':   return toolDelete(args);
      case 'create_list':   return toolCreateList(args);
    }
    return { ok: false, error: '알 수 없는 도구: ' + name };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

function toolCreate(a) {
  var lists = listTasklists();
  if (!lists.length) return { ok: false, error: '목록이 없습니다' };
  var target = matchList(lists, a.list) || lists[0];
  var meta = { p: a.priority || 4, labels: a.labels || [], time: a.time || null, dur: null };
  var body = { title: String(a.title || '').slice(0, 1024), notes: encodeNotes(a.notes || '', meta) };
  if (a.due) body.due = a.due + 'T00:00:00.000Z';

  var parent = a.parent_id ? chatResolve(a.parent_id) : null;
  var path = '/lists/' + target.id + '/tasks';
  if (parent && parent.listId === target.id) path += '?parent=' + encodeURIComponent(parent.taskId);

  var made = api('POST', path, body);
  if (!made || !made.id) return { ok: false, error: '생성 실패 ' + (API_LAST_ERROR || '') };
  return { ok: true, created: made.title, list: target.title };
}

function toolUpdate(a) {
  var ref = chatResolve(a.id);
  if (!ref) return { ok: false, error: '없는 id: ' + a.id };
  var cur = api('GET', '/lists/' + ref.listId + '/tasks/' + ref.taskId);
  if (!cur) return { ok: false, error: '조회 실패 ' + (API_LAST_ERROR || '') };

  var d = decodeNotes(cur.notes || ''), body = {};
  if (typeof a.title === 'string' && a.title) body.title = a.title.slice(0, 1024);
  if (typeof a.due === 'string') body.due = a.due ? a.due + 'T00:00:00.000Z' : null;

  var meta = { p: d.meta.p, labels: d.meta.labels, time: d.meta.time, dur: d.meta.dur };
  var touched = false;
  if (a.priority) { meta.p = Number(a.priority) || 4; touched = true; }
  if (Array.isArray(a.labels)) { meta.labels = a.labels; touched = true; }
  if (typeof a.time === 'string') { meta.time = a.time || null; touched = true; }
  if (typeof a.notes === 'string' || touched) {
    body.notes = encodeNotes(typeof a.notes === 'string' ? a.notes : d.body, meta);
  }

  var r = api('PATCH', '/lists/' + ref.listId + '/tasks/' + ref.taskId, body);
  if (!r) return { ok: false, error: '수정 실패 ' + (API_LAST_ERROR || '') };
  return { ok: true, updated: r.title || cur.title };
}

function toolComplete(a) {
  var ref = chatResolve(a.id);
  if (!ref) return { ok: false, error: '없는 id: ' + a.id };

  /* 반복 태스크는 **완료가 아니라 다음 회차로 넘기는 것**이다. 앱의 toggleDone 이
     그렇게 동작하므로 여기서도 같아야 한다. 예전에는 그냥 completed 로 찍어서,
     "시리야, 스탠드업 완료" 한 번이면 매일 반복이 영영 사라졌다. */
  var cur = api('GET', '/lists/' + ref.listId + '/tasks/' + ref.taskId);
  var rec = cur ? decodeNotes(cur.notes || '').meta.rec : null;
  if (rec) {
    var nd = nextDue(cur.due ? String(cur.due).slice(0, 10) : null, rec);
    var rolled = api('PATCH', '/lists/' + ref.listId + '/tasks/' + ref.taskId,
      { due: nd ? nd + 'T00:00:00.000Z' : null });
    if (!rolled) return { ok: false, error: '반복 이월 실패 ' + (API_LAST_ERROR || '') };
    return { ok: true, rolled: rolled.title, next: nd };
  }

  var r = api('PATCH', '/lists/' + ref.listId + '/tasks/' + ref.taskId,
    { status: 'completed', completed: new Date().toISOString() });
  if (!r) return { ok: false, error: '완료 실패 ' + (API_LAST_ERROR || '') };
  return { ok: true, completed: r.title };
}

function toolMove(a) {
  var ref = chatResolve(a.id);
  if (!ref) return { ok: false, error: '없는 id: ' + a.id };
  var q = [];
  if (a.list) {
    var hit = matchList(listTasklists(), a.list);
    if (!hit) return { ok: false, error: '없는 목록: ' + a.list };
    if (hit.id !== ref.listId) q.push('destinationTasklist=' + encodeURIComponent(hit.id));
  }
  if (typeof a.parent_id === 'string') {
    if (a.parent_id) {
      var p = chatResolve(a.parent_id);
      if (!p) return { ok: false, error: '없는 상위 id: ' + a.parent_id };
      q.push('parent=' + encodeURIComponent(p.taskId));
    }
    /* 빈 문자열이면 parent 를 넘기지 않는다 = 최상위로 */
  }
  var r = api('POST', '/lists/' + ref.listId + '/tasks/' + ref.taskId + '/move' + (q.length ? '?' + q.join('&') : ''));
  if (!r) return { ok: false, error: '이동 실패 ' + (API_LAST_ERROR || '') };
  return { ok: true, moved: r.title };
}

function toolDelete(a) {
  var ref = chatResolve(a.id);
  if (!ref) return { ok: false, error: '없는 id: ' + a.id };
  var r = api('DELETE', '/lists/' + ref.listId + '/tasks/' + ref.taskId);
  if (r === null && API_LAST_ERROR) return { ok: false, error: '삭제 실패 ' + API_LAST_ERROR };
  return { ok: true, deleted: a.id };
}

function toolCreateList(a) {
  var r = api('POST', '/users/@me/lists', { title: String(a.title || '').slice(0, 1024) });
  if (!r || !r.id) return { ok: false, error: '목록 생성 실패 ' + (API_LAST_ERROR || '') };
  return { ok: true, list: r.title };
}
