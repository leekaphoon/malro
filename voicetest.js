/* Malro Voice — Apps Script 백엔드의 순수 로직 검증.
   Apps Script 는 로컬에서 못 돌리므로, GAS 전역(PropertiesService 등)을 흉내 낸 뒤
   순수 함수만 core.js 와 대조한다. 핵심 질문: 두 앱이 같은 메타를 쓰는가. */
'use strict';
const fs = require('fs');
const vm = require('vm');
const core = require('./core.js');

let bad = 0;
const A = (n, c, extra) => { console.log(`  ${c ? '✓' : '✗'} ${n}${c ? '' : (extra ? '  → ' + extra : '')}`); if (!c) bad++; };

/* ── GAS 전역 스텁 ── */
const store = new Map();
const sandbox = {
  PropertiesService: { getScriptProperties: () => ({
    getProperty: k => (store.has(k) ? store.get(k) : null),
    setProperty: (k, v) => store.set(k, v)
  }) },
  ScriptApp: { getOAuthToken: () => 'stub-token' },
  UrlFetchApp: { fetch: () => { throw new Error('네트워크 호출은 이 테스트 범위 밖'); } },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ _s: s, setMimeType() { return this; } }) },
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
    computeDigest: (_alg, s) => [...require('crypto').createHash('sha256').update(s, 'utf8').digest()]
      .map(b => (b > 127 ? b - 256 : b))          // GAS 는 부호 있는 바이트를 준다
  },
  Logger: { log: () => {} },
  console
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('./voice/Code.gs', 'utf8'), sandbox);
const G = sandbox;

console.log('\n[메타 인코딩 — Malro 앱과 동일해야 함]');
/* ⚠ 예전에는 비교 직전에 `{ ...meta, rec: null }` 로 **반복을 빼고** 대조했다.
   그래서 "바이트 단위로 같다" 는 검증이 반복에 대해서는 한 번도 이뤄지지 않았고,
   Code.gs 가 ↻ 를 읽지도 쓰지도 않는다는 사실이 가려졌다. 결과는 단순한 누락이 아니라
   **데이터 파괴**였다 — 시리나 AI 로 태스크를 한 번 고치면 decode(반복 없음) →
   encode(반복 없음) 를 거쳐 "매주 월요일" 이 영영 사라졌다.
   이제 rec 를 포함해 그대로 비교한다. */
const cases = [
  ['', { p: 1, labels: ['검증'], time: '14:30', rec: null, dur: 30 }],
  ['설명 본문', { p: 2, labels: [], time: null, rec: null, dur: null }],
  ['', { p: 4, labels: [], time: null, rec: null, dur: null }],
  ['두 줄\n본문', { p: 3, labels: ['긴급 대응', 'AM'], time: '09:05', rec: null, dur: null }],
  ['', { p: 4, labels: ['라벨'], time: null, rec: null, dur: 120 }],
  // 반복 — 다섯 종류 전부
  ['', { p: 1, labels: [], time: null, rec: { type: 'weekday', interval: 1 }, dur: null }],
  ['', { p: 2, labels: ['팀'], time: '09:00', rec: { type: 'week', interval: 1, days: [1] }, dur: null }],
  ['본문', { p: 4, labels: [], time: null, rec: { type: 'week', interval: 2, days: [1, 3, 5] }, dur: null }],
  ['', { p: 3, labels: [], time: null, rec: { type: 'day', interval: 3 }, dur: 45 }],
  ['', { p: 4, labels: [], time: null, rec: { type: 'month', interval: 1 }, dur: null }],
  ['', { p: 4, labels: [], time: null, rec: { type: 'year', interval: 1 }, dur: null }]
];
cases.forEach(([body, meta], i) => {
  const mine = G.encodeNotes(body, meta);
  const theirs = core.encodeNotes(body, meta);          // ← 손대지 않고 그대로 넘긴다
  A(`인코딩 ${i + 1} 이 core.js 와 바이트 단위로 같음`, mine === theirs,
    JSON.stringify({ mine, theirs }));
});

console.log('\n[디코딩 — core.js 와 같은 결과를 내는가]');
/* 기댓값을 손으로 적지 않고 core.js 와 대조한다.
   손으로 적었더니 "@ 없는 토큰은 라벨이 아니다" 를 내가 틀리게 적어 테스트가 거짓
   실패를 냈다. 정답을 아는 쪽(core.js)에 물어보는 편이 정확하다. */
[
  '일감\n\n⟦p1 @검증 ⏰14:30 ⏳45⟧',
  '⟦p2⟧',
  '메타 없음',
  '⟦@두_단어 @라벨⟧',
  '⟦@두_단어 라벨⟧',                       // @ 없는 토큰은 무시돼야 한다
  '',
  '본문만 여러 줄\n둘째 줄',
  '⟦⟧',
  '⟦p9 @x⟧',                               // 범위 밖 우선순위는 무시
  '⟦p1 @검증 ⏰08:00 ↻w1:1⟧',               // 반복 — 매주 월
  '⟦↻wd⟧',                                 // 평일마다
  '⟦↻d3 ⏳30⟧',                             // 3일마다
  '⟦↻m1⟧', '⟦↻y1⟧', '⟦↻w2:135⟧'
].forEach((notes, i) => {
  const mine = G.decodeNotes(notes), theirs = core.decodeNotes(notes);
  const same = mine.body === theirs.body && mine.meta.p === theirs.meta.p &&
    mine.meta.time === theirs.meta.time && mine.meta.dur === theirs.meta.dur &&
    JSON.stringify(mine.meta.labels) === JSON.stringify(theirs.meta.labels) &&
    JSON.stringify(mine.meta.rec || null) === JSON.stringify(theirs.meta.rec || null);
  A(`디코딩 ${i + 1} 이 core.js 와 일치`, same,
    JSON.stringify({ mine: mine.meta, theirs: theirs.meta, mb: mine.body, tb: theirs.body }));
});

console.log('\n[반복이 음성 백엔드를 왕복해도 살아남는가]');
{
  /* 여기가 핵심이다. 백엔드가 ↻ 를 **읽고 다시 쓸 수 있어야** 한다.
     읽기만 하고 쓰지 못하면, 시리로 우선순위 하나만 바꿔도 반복 규칙이 사라진다. */
  const withRec = core.encodeNotes('본문', { p: 1, labels: ['검증'], time: '08:00', rec: { type: 'week', interval: 1, days: [1] }, dur: null });
  const m = G.decodeNotes(withRec).meta;
  A('반복 토큰이 있어도 우선순위를 읽는다', m.p === 1, JSON.stringify(m));
  A('반복 토큰이 있어도 시각을 읽는다', m.time === '08:00');
  A('반복 토큰이 있어도 라벨을 읽는다', JSON.stringify(m.labels) === '["검증"]');
  A('본문을 메타와 분리한다', G.decodeNotes(withRec).body === '본문');
  A('**반복 규칙 자체를 읽는다**', JSON.stringify(m.rec) === JSON.stringify({ type: 'week', interval: 1, days: [1] }), JSON.stringify(m.rec));

  // 왕복: 디코딩 → (우선순위만 변경) → 인코딩 → 반복이 그대로 남아 있어야 한다
  const d = G.decodeNotes(withRec);
  d.meta.p = 2;
  const again = G.encodeNotes(d.body, d.meta);
  A('시리로 다른 필드를 고쳐도 반복이 지워지지 않는다', /↻w1:1/.test(again), again);
  A('왕복 결과가 core.js 가 쓴 것과 같다',
    again === core.encodeNotes('본문', { p: 2, labels: ['검증'], time: '08:00', rec: { type: 'week', interval: 1, days: [1] }, dur: null }), again);
}

const todayYmd = () => { const d = new Date(); const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
const ymdAddYear = (s, n) => (Number(s.slice(0, 4)) + n) + s.slice(4);
console.log('\n[반복 완료 — 앱과 같은 날짜로 이월하는가]');
{
  /* 앱의 toggleDone 과 백엔드의 toolComplete 가 **같은 날짜**를 내야 한다.
     다르면 기기에 따라 다음 회차가 달라진다. 규칙을 두 곳에 적어야 하는 구조이므로
     (Apps Script 는 core.js 를 import 할 수 없다) 결과를 대조하는 수밖에 없다. */
  const recs = [
    { type: 'weekday', interval: 1 },
    { type: 'week', interval: 1, days: [1] },
    { type: 'week', interval: 2, days: [1, 3, 5] },
    { type: 'day', interval: 3 },
    { type: 'month', interval: 1 },
    { type: 'year', interval: 1 }
  ];
  const bases = ['2026-09-18', '2026-01-31', '2026-02-27', '2024-02-29', null];
  let bad = 0, sample = '';
  recs.forEach(r => bases.forEach(b => {
    const mine = G.nextDue(b, r), theirs = core.nextDue(b, r);
    if (mine !== theirs) { bad++; if (!sample) sample = JSON.stringify({ r, b, mine, theirs }); }
  }));
  A(`다음 회차 계산이 core.js 와 전부 일치 (${recs.length * bases.length}조합)`, bad === 0, sample);
  /* 기한이 **지난** 반복은 오늘 기준으로 이월한다(과거로 밀리면 영원히 지연 상태가 된다).
     그래서 월말 절삭을 보려면 미래 날짜를 써야 한다 — 처음에 과거 날짜로 기댓값을 적었다가
     틀렸다. 두 구현이 서로 일치한다고 말한 위 단언이 맞았고 내 손계산이 틀렸다. */
  const future = ymdAddYear(todayYmd(), 1).slice(0, 4) + '-10-31';
  A('월말 기준 매월 반복이 존재하는 날짜로 절삭된다',
    G.nextDue(future, { type: 'month', interval: 1 }) === future.slice(0, 4) + '-11-30',
    G.nextDue(future, { type: 'month', interval: 1 }));
  A('지난 기한은 오늘 기준으로 이월한다 (과거로 밀지 않는다)',
    G.nextDue('2020-01-31', { type: 'day', interval: 1 }) === core.nextDue('2020-01-31', { type: 'day', interval: 1 }) &&
    G.nextDue('2020-01-31', { type: 'day', interval: 1 }) > todayYmd(),
    G.nextDue('2020-01-31', { type: 'day', interval: 1 }));
}

console.log('\n[날짜 — 타임존 변환 없이]');
{
  const t = G.todayY();
  A('오늘이 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(t));
  A('core.js 의 오늘과 일치', t === core.todayY(), `${t} vs ${core.todayY()}`);
  A('일수 차 계산이 core.js 와 일치',
    G.diffDays('2026-03-01', '2026-02-27') === core.diffDays('2026-03-01', '2026-02-27'));
  A('말로 읽는 날짜 — 오늘', G.humanDate(t, null) === '오늘에', G.humanDate(t, null));
  A('말로 읽는 날짜 — 시각 포함', /15시 00분에$/.test(G.humanDate(t, '15:00')), G.humanDate(t, '15:00'));
}

console.log('\n[시크릿 검증]');
{
  store.set('SHARED_SECRET', 'abcdefghij');
  A('정확히 같으면 통과', G.secretOk('abcdefghij'));
  A('한 글자 다르면 거부', !G.secretOk('abcdefghiX'));
  A('길이가 다르면 거부', !G.secretOk('abcdefghi'));
  A('앞부분만 같아도 거부 (조기 종료 없음)', !G.secretOk('abcde'));
  A('빈 값 거부', !G.secretOk(''));
  A('undefined 거부', !G.secretOk(undefined));
  store.delete('SHARED_SECRET');
  A('시크릿 미설정이면 무엇도 통과시키지 않음', !G.secretOk('') && !G.secretOk('아무거나'));
  store.set('SHARED_SECRET', 'abcdefghij');
}

console.log('\n[인증 실패 시 아무 일도 하지 않는가]');
{
  const r = JSON.parse(G.doPost({ postData: { contents: JSON.stringify({ secret: '틀린값', action: 'add', text: '뭔가' }) } })._s);
  A('잘못된 시크릿은 거부', r.ok === false && /인증/.test(r.speak), JSON.stringify(r));
  const r2 = JSON.parse(G.doPost({ postData: { contents: '{{깨진 JSON' } })._s);
  A('깨진 본문에도 죽지 않고 응답', r2.ok === false, JSON.stringify(r2));
  const r3 = JSON.parse(G.doPost({})._s);
  A('본문이 없어도 죽지 않음', r3.ok === false);
}

console.log('\n[정상 시크릿 + 동작 분기]');
{
  const ping = JSON.parse(G.doPost({ postData: { contents: JSON.stringify({ secret: 'abcdefghij', action: 'ping' }) } })._s);
  A('ping 은 네트워크 없이 응답', ping.ok === true, JSON.stringify(ping));
  const unknown = JSON.parse(G.doPost({ postData: { contents: JSON.stringify({ secret: 'abcdefghij', action: '없는동작' }) } })._s);
  A('모르는 동작은 거부', unknown.ok === false);
  const empty = JSON.parse(G.doPost({ postData: { contents: JSON.stringify({ secret: 'abcdefghij', action: 'add', text: '  ' }) } })._s);
  A('빈 받아쓰기는 Gemini 를 부르지 않고 되묻는다', empty.ok === false && /못 들었/.test(empty.speak), JSON.stringify(empty));
}

console.log('\n[Tasks API 실패를 "할 일 없음"으로 뭉개지 않는가]');
{
  /* 실사용에서 잡힌 문제: 권한이 없어 목록을 못 읽었는데 "오늘 기한인 할 일이
     없습니다" 라고 태연히 답했다. 앱에서 겪은 것과 같은 계열의 실수 —
     실패를 빈 값으로 바꾸면 원인이 숨는다. */
  const call = (action, secret) => JSON.parse(
    G.doPost({ postData: { contents: JSON.stringify({ secret: secret || 'abcdefghij', action }) } })._s);

  store.set('SHARED_SECRET', 'abcdefghij');

  /* 실사용에서 나온 진짜 403 본문. 조치가 "서비스 추가" 이지 "권한 승인" 이 아니다 —
     처음엔 403 을 한 덩어리로 다뤄 엉뚱한 안내를 했다. */
  sandbox.UrlFetchApp.fetch = () => ({
    getResponseCode: () => 403,
    getContentText: () => '{"error":{"code":403,"message":"Google Tasks API has not been used in project 569405120624 before or it is disabled."}}'
  });
  let r = call('today');
  A('API 미활성화를 서비스 추가로 안내', r.ok === false && /서비스/.test(r.speak) && /Tasks API/.test(r.speak), JSON.stringify(r));
  A('미활성화를 권한 문제로 오진하지 않음', !/checkSetup/.test(r.speak), r.speak);

  sandbox.UrlFetchApp.fetch = () => ({ getResponseCode: () => 401, getContentText: () => '{"error":"invalid_token"}' });
  r = call('today');
  A('401 은 권한 승인으로 안내', r.ok === false && /checkSetup/.test(r.speak), JSON.stringify(r));

  sandbox.UrlFetchApp.fetch = () => ({ getResponseCode: () => 500, getContentText: () => 'boom' });
  r = call('today');
  A('그 밖의 실패도 "없음" 으로 뭉개지 않는다', r.ok === false && /읽지 못했/.test(r.speak), JSON.stringify(r));

  sandbox.UrlFetchApp.fetch = () => ({ getResponseCode: () => 200, getContentText: () => '{"items":[]}' });
  r = call('today');
  A('목록이 진짜 없으면 그렇게 말한다', r.ok === false && /목록이 하나도 없/.test(r.speak), JSON.stringify(r));

  /* 목록은 있는데 기한 있는 항목이 없는 경우 — 이때만 "할 일 없음" 이 맞다 */
  let call_n = 0;
  sandbox.UrlFetchApp.fetch = () => ({
    getResponseCode: () => 200,
    getContentText: () => (call_n++ === 0 ? '{"items":[{"id":"L1","title":"업무"}]}' : '{"items":[]}')
  });
  r = call('today');
  A('목록은 있고 항목이 없을 때만 "할 일 없음"', r.ok === true && /할 일이 없습니다/.test(r.speak), JSON.stringify(r));

  sandbox.UrlFetchApp.fetch = () => { throw new Error('네트워크 호출은 이 테스트 범위 밖'); };
}

console.log('\n[모델 은퇴 대응 — 이름을 하나로 박아 두면 조용히 404 가 난다]');
{
  const call = (action, text) => JSON.parse(
    G.doPost({ postData: { contents: JSON.stringify({ secret: 'abcdefghij', action, text }) } })._s);
  store.set('SHARED_SECRET', 'abcdefghij');
  store.set('GEMINI_API_KEY', 'k');
  store.delete('GEMINI_MODEL'); store.delete('GEMINI_MODEL_OK');

  const listsOk = () => ({ getResponseCode: () => 200, getContentText: () => '{"items":[{"id":"L1","title":"프로젝트"}]}' });

  /* 앞의 두 모델은 404, 세 번째가 응답 — 세 번째를 써야 하고 기억해야 한다 */
  let tried = [];
  sandbox.UrlFetchApp.fetch = (url, opt) => {
    if (String(url).indexOf('tasks.googleapis.com') >= 0) {
      return (opt && opt.method === 'POST')
        ? { getResponseCode: () => 200, getContentText: () => '{"id":"T1","title":"회귀 시험"}' }
        : listsOk();
    }
    const m = String(url).match(/models\/([^:]+):/);
    tried.push(m[1]);
    if (tried.length < 3) return { getResponseCode: () => 404, getContentText: () => '{"error":"not found"}' };
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify({
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"title":"회귀 시험","due":"2026-09-01"}' }] } }]
    }) };
  };

  let r = call('add', '내일 회귀 시험');
  A('404 면 다음 모델로 넘어간다', tried.length === 3, JSON.stringify(tried));
  A('통한 모델로 등록이 완료된다', r.ok === true && /회귀 시험/.test(r.speak), JSON.stringify(r));
  A('통한 모델을 기억한다', store.get('GEMINI_MODEL_OK') === tried[2], String(store.get('GEMINI_MODEL_OK')));

  /* 기억한 뒤에는 그 모델을 먼저 부른다 */
  const remembered = store.get('GEMINI_MODEL_OK');
  tried = [];
  r = call('add', '두 번째');
  A('다음부터는 기억한 모델을 먼저 부른다', tried[0] === remembered, JSON.stringify(tried));

  /* 사람이 지정한 모델에 오타가 있어도 살아남아야 한다.
     지정을 절대적으로 따르게 했더니 속성 오타 하나로 영구 404 가 났다. */
  store.delete('GEMINI_MODEL_OK');
  store.set('GEMINI_MODEL', 'gemini-flash-lte-latest');   // 오타: lte
  tried = [];
  sandbox.UrlFetchApp.fetch = (url, opt) => {
    if (String(url).indexOf('tasks.googleapis.com') >= 0) {
      return (opt && opt.method === 'POST')
        ? { getResponseCode: () => 200, getContentText: () => '{"id":"T2","title":"오타 복구"}' }
        : listsOk();
    }
    const m = String(url).match(/models\/([^:]+):/);
    tried.push(m[1]);
    if (m[1].indexOf('lte') >= 0) return { getResponseCode: () => 404, getContentText: () => '{}' };
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"title":"오타 복구"}' }] } }]
    }) };
  };
  r = call('add', '오타 복구');
  A('지정한 모델을 가장 먼저 시도한다', tried[0] === 'gemini-flash-lte-latest', JSON.stringify(tried));
  A('지정에 오타가 있어도 후보로 살아남는다', r.ok === true, JSON.stringify(r));
  store.delete('GEMINI_MODEL'); store.delete('GEMINI_MODEL_OK');

  /* 전부 404 면 지어내지 말고 진단 경로를 안내 */
  store.delete('GEMINI_MODEL_OK'); tried = [];
  sandbox.UrlFetchApp.fetch = (url, opt) => {
    if (String(url).indexOf('tasks.googleapis.com') >= 0) return listsOk();
    return { getResponseCode: () => 404, getContentText: () => '{"error":"not found"}' };
  };
  r = call('add', '아무거나');
  A('전부 404 면 모델을 못 찾았다고 말한다', r.ok === false && /모델을 찾지 못했/.test(r.speak), JSON.stringify(r));
  A('action=models 로 확인하라고 안내', /models/.test(r.speak));

  /* 지역 차단은 모델 문제와 구분해야 한다 — 모델을 바꿔 봐야 소용없다 */
  tried = [];
  sandbox.UrlFetchApp.fetch = (url) => {
    if (String(url).indexOf('tasks.googleapis.com') >= 0) return listsOk();
    return { getResponseCode: () => 400, getContentText: () => '{"error":{"message":"User location is not supported for the API use."}}' };
  };
  r = call('add', '아무거나');
  A('지역 차단은 그대로 지목', /서버 위치를 거부/.test(r.speak), JSON.stringify(r));
  A('지역 차단이면 다른 모델을 시도하지 않는다', tried.length <= 1, JSON.stringify(tried));

  /* 모델 목록 조회 */
  sandbox.UrlFetchApp.fetch = () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({
    models: [
      { name: 'models/gemini-x-pro', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-9', supportedGenerationMethods: ['embedContent'] }
    ]
  }) });
  r = call('models');
  A('generateContent 되는 모델만 골라 준다',
    r.usable.length === 1 && r.usable[0] === 'gemini-x-pro', JSON.stringify(r));

  store.delete('GEMINI_API_KEY'); store.delete('GEMINI_MODEL_OK');
  sandbox.UrlFetchApp.fetch = () => { throw new Error('네트워크 호출은 이 테스트 범위 밖'); };
}

console.log('\n[대화형 어시스턴트 — 도구 실행을 서버에서]');
{
  store.set('SHARED_SECRET', 'abcdefghij');
  store.set('GEMINI_API_KEY', 'k');
  store.delete('GEMINI_MODEL'); store.delete('GEMINI_MODEL_OK');

  const LISTS = '{"items":[{"id":"L1","title":"프로젝트"},{"id":"L2","title":"개인"}]}';
  const TASKS_L1 = JSON.stringify({ items: [
    { id: 'gid_a', title: '배포 파이프라인 검증', notes: '본문\n\n⟦p1 @검증 ⏰14:30⟧', due: '2026-08-20T00:00:00.000Z', status: 'needsAction' },
    { id: 'gid_b', title: '보안 점검 자료', notes: '', status: 'needsAction' }
  ] });

  /* Gemini 응답을 대본으로 주고, Tasks 호출은 기록만 한다 */
  let script = [], calls = [];
  const mock = (url, opt) => {
    url = String(url);
    if (url.indexOf('tasks.googleapis.com') >= 0) {
      calls.push({ method: (opt && opt.method) || 'GET', url: url, body: opt && opt.payload });
      if (/\/users\/@me\/lists\?/.test(url)) return { getResponseCode: () => 200, getContentText: () => LISTS };
      if (/\/lists\/L1\/tasks\?/.test(url)) return { getResponseCode: () => 200, getContentText: () => TASKS_L1 };
      if (/\/lists\/L2\/tasks\?/.test(url)) return { getResponseCode: () => 200, getContentText: () => '{"items":[]}' };
      if (/\/tasks\/gid_a$/.test(url) && (!opt || opt.method === 'GET')) {
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(JSON.parse(TASKS_L1).items[0]) };
      }
      return { getResponseCode: () => 200, getContentText: () => '{"id":"gid_new","title":"만들어짐"}' };
    }
    const next = script.shift() || { candidates: [{ content: { parts: [{ text: '끝.' }] } }] };
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify(next) };
  };
  sandbox.UrlFetchApp.fetch = mock;

  const chat = (text, history) => JSON.parse(G.doPost({ postData: { contents:
    JSON.stringify({ secret: 'abcdefghij', action: 'chat', text: text, history: history }) } })._s);

  /* 1) 도구 없이 본문만 — 분석 요청 */
  script = [{ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '지연 1건, 배포 파이프라인 검증입니다.' }] } }] }];
  calls = [];
  let r = chat('지연 분석해 줘');
  A('분석 요청은 본문으로 답한다', r.ok === true && /배포/.test(r.speak), JSON.stringify(r));
  A('아무것도 바꾸지 않았다고 알린다', r.changed === false);
  A('쓰기 호출이 없다', calls.every(c => c.method === 'GET'), JSON.stringify(calls.map(c => c.method)));

  /* 2) 모델이 실제 Google ID 를 보지 못한다 */
  const sysSent = (() => {
    let captured = '';
    sandbox.UrlFetchApp.fetch = (url, opt) => {
      if (String(url).indexOf('generativelanguage') >= 0 && !captured) captured = String(opt.payload);
      return mock(url, opt);
    };
    script = [{ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }];
    chat('뭐 있지');
    sandbox.UrlFetchApp.fetch = mock;
    return captured;
  })();
  /* systemInstruction 안에 스냅샷 JSON 이 문자열로 들어가므로 따옴표가 이스케이프된다.
     원문에 정규식을 걸면 거짓 실패가 난다 — 실제로 그렇게 한 번 틀렸다. 풀어서 본다. */
  const sysText = ((JSON.parse(sysSent).systemInstruction || {}).parts || [{}])[0].text || '';
  A('실제 태스크 ID 를 모델에 보내지 않는다', sysText.indexOf('gid_a') < 0, sysText.slice(-120));
  A('실제 목록 ID 도 보내지 않는다', !/"list(Id)?":"L1"/.test(sysText) && sysText.indexOf('"L1"') < 0);
  A('별칭으로 치환해 보낸다', /"id":"t1"/.test(sysText), sysText.slice(-160));
  A('목록은 이름으로만 보낸다', /"lists":\["프로젝트","개인"\]/.test(sysText), sysText.slice(-200));

  /* 3) 도구 호출 → 실행 → 결과를 다시 물어봄 */
  script = [
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'create_task',
        args: { title: '회귀 시험', due: '2026-09-05', priority: 1, list: '프로젝트' } } }] } }] },
    { candidates: [{ content: { parts: [{ text: '프로젝트에 추가했습니다.' }] } }] }
  ];
  calls = [];
  r = chat('회귀 시험 추가해 줘');
  A('도구를 서버에서 실행한다', r.ok === true && (r.actions || []).indexOf('create_task') >= 0, JSON.stringify(r));
  A('바뀐 것이 있다고 알린다', r.changed === true);
  const post = calls.find(c => c.method === 'POST' && /\/lists\/L1\/tasks$/.test(c.url));
  A('올바른 목록에 생성', !!post, JSON.stringify(calls.map(c => c.method + ' ' + c.url)));
  A('메타 인코딩이 앱과 같은 형식', /⟦p1⟧/.test(post.body), post.body);
  A('기한을 RFC3339 로 변환', /2026-09-05T00:00:00\.000Z/.test(post.body));

  /* 4) 별칭으로 기존 태스크 수정 — 실제 ID 로 되돌려야 한다 */
  script = [
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'complete_task', args: { id: 't1' } } }] } }] },
    { candidates: [{ content: { parts: [{ text: '완료 처리했습니다.' }] } }] }
  ];
  calls = [];
  r = chat('배포 파이프라인 검증 완료');
  const patch = calls.find(c => c.method === 'PATCH');
  A('별칭 t1 을 실제 ID 로 되돌린다', !!patch && /gid_a/.test(patch.url), JSON.stringify(calls.map(c => c.url)));
  A('completed 상태로 바꾼다', /"status":"completed"/.test(patch.body));

  /* 5) 없는 별칭은 지어내지 말고 오류로 */
  script = [
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'complete_task', args: { id: 't99' } } }] } }] },
    { candidates: [{ content: { parts: [{ text: '그런 항목이 없습니다.' }] } }] }
  ];
  calls = [];
  r = chat('t99 완료');
  A('없는 별칭은 쓰기를 시도하지 않는다', !calls.some(c => c.method === 'PATCH'), JSON.stringify(calls.map(c => c.method)));
  A('도구 실패는 changed 로 세지 않는다', r.changed === false, JSON.stringify(r));

  /* 6) 본문 없이 끝나면 생각을 끄고 재시도 */
  script = [
    { candidates: [{ finishReason: 'MAX_TOKENS' }] },
    { candidates: [{ content: { parts: [{ text: '재시도에서 나온 답변' }] } }] }
  ];
  r = chat('분석');
  A('빈 응답이면 생각을 끄고 재시도', r.ok === true && /재시도에서 나온/.test(r.speak), JSON.stringify(r));

  /* 7) 이력 */
  A('POST 이력은 배열로 받는다', G.parseHistory([{ role: 'user', text: 'a' }]).length === 1);
  A('GET 이력은 JSON 문자열로 받는다', G.parseHistory('[{"role":"user","text":"a"}]').length === 1);
  A('깨진 이력은 버리고 계속한다', G.parseHistory('{{깨짐').length === 0);
  A('이력이 길면 최근 것만', G.parseHistory(new Array(30).fill({ role: 'user', text: 'x' })).length === 8);

  store.delete('GEMINI_API_KEY'); store.delete('GEMINI_MODEL_OK');
  sandbox.UrlFetchApp.fetch = () => { throw new Error('네트워크 호출은 이 테스트 범위 밖'); };
}

console.log('\n[GET 폴백 — 302 리디렉션으로 POST 본문이 유실될 때]');
{
  const get = q => JSON.parse(G.doGet({ parameter: q })._s);
  A('파라미터가 없으면 상태만 알려준다', get({}).service === 'malro-voice');
  A('action 이 있으면 POST 와 같게 처리', get({ secret: 'abcdefghij', action: 'ping' }).ok === true);
  A('GET 경로에서도 시크릿을 검사한다',
    get({ secret: '틀린값', action: 'ping' }).ok === false);
  A('시크릿 없이 action 만 있으면 거부',
    get({ action: 'today' }).ok === false);
  A('GET 경로도 빈 받아쓰기를 되묻는다',
    /못 들었/.test(get({ secret: 'abcdefghij', action: 'add', text: '' }).speak));
  A('e 가 없어도 죽지 않는다', JSON.parse(G.doGet()._s).ok === true);
}

console.log('\n[시크릿 진단 — DEBUG=1 일 때만, 값은 절대 노출하지 않고]');
{
  const dbg = given => JSON.parse(G.doPost({ postData: { contents: JSON.stringify({ action: 'debug', secret: given }) } })._s);
  store.set('SHARED_SECRET', 'abcdefghij');

  store.delete('DEBUG');
  A('DEBUG 가 꺼져 있으면 응답하지 않음', dbg('아무거나').ok === false);

  store.set('DEBUG', '1');
  const same = dbg('abcdefghij');
  A('일치하면 match=true', same.match === true, JSON.stringify(same));
  A('지문이 서로 같다', same.want_fp === same.got_fp && same.want_fp.length === 8, JSON.stringify(same));

  const quoted = dbg("'abcdefghij'");
  A('따옴표가 붙으면 길이 차이로 드러남', quoted.got_len === 12 && quoted.want_len === 10, JSON.stringify(quoted));
  A('따옴표가 붙으면 match=false', quoted.match === false);

  const spaced = dbg(' abcdefghij\n');
  A('앞뒤 공백을 지목함', spaced.got_has_outer_space === true, JSON.stringify(spaced));

  const curly = dbg('abcdefghi’');                 // 곱은따옴표 — 길이는 같고 글자만 다름
  A('길이가 같아도 지문이 달라 구분됨',
    curly.got_len === curly.want_len && curly.got_fp !== curly.want_fp, JSON.stringify(curly));
  A('비ASCII 글자를 지목함', curly.got_nonascii === true);

  A('진단이 시크릿 원문을 돌려주지 않음',
    !JSON.stringify(same).includes('abcdefghij'), JSON.stringify(same));
  A('시크릿을 안 보내도 죽지 않음', dbg(undefined).got_len === 0);
  store.delete('DEBUG');
}

console.log('\n[doGet 이 비밀값을 노출하지 않는가]');
{
  /* 키 모양 문자열을 소스에 통째로 적지 않는다 — 배포 스크립트의 비밀값 검사에
     이 테스트 파일이 걸려 배포가 막힌다. 검사가 무뎌지는 것보다 이쪽을 쪼갠다. */
  const FAKE = 'AIza' + 'Sy' + 'NOT_A_REAL_KEY_test_only_00000';
  store.set('GEMINI_API_KEY', FAKE);
  const g = G.doGet()._s;
  A('키 원문이 응답에 없음', g.indexOf(FAKE) < 0 && !/AIza/.test(g), g);
  A('시크릿 원문이 응답에 없음', !/abcdefghij/.test(g), g);
  A('설정 여부만 알려줌', /"hasKey":true/.test(g) && /"hasSecret":true/.test(g), g);
}

console.log('\n[목록 이름 매칭 — 앱과 같은 규칙]');
{
  const lists = [{ id: 'a', title: '프로젝트' }, { id: 'b', title: '회사 업무' }, { id: 'c', title: '개인' }];
  A('정확 일치', G.matchList(lists, '회사 업무').id === 'b');
  A('공백 무시', G.matchList(lists, '회사업무').id === 'b');
  A('부분 일치', G.matchList(lists, '프로젝트').id === 'a');
  A('없으면 null', G.matchList(lists, '없는목록') === null);
  A('빈 값이면 null', G.matchList(lists, '') === null);
}

console.log('\n[말로 듣기 좋은 길이로 끊는가]');
{
  const mk = n => Array.from({ length: n }, (_, i) => ({ title: '일감' + (i + 1), meta: { p: 4 } }));
  A('5건 이하는 그대로', !/그 외/.test(G.speakList(mk(3))), G.speakList(mk(3)));
  A('6건부터는 5건까지만 읽고 나머지는 건수로', /그 외 3건/.test(G.speakList(mk(8))), G.speakList(mk(8)));
  A('P1 은 긴급으로 표시', /긴급, /.test(G.speakList([{ title: 'x', meta: { p: 1 } }])));
  const sorted = G.sortByPriority([{ title: 'c', meta: { p: 4 } }, { title: 'a', meta: { p: 1 } }, { title: 'b', meta: { p: 2 } }]);
  A('우선순위 순으로 읽는다', sorted.map(r => r.title).join('') === 'abc', sorted.map(r => r.title).join(''));
}

console.log('\n[setupSecret]');
{
  store.delete('SHARED_SECRET');
  G.setupSecret();
  const s1 = store.get('SHARED_SECRET');
  A('40자 시크릿 생성', s1 && s1.length === 40, String(s1));
  A('혼동되는 글자 제외 (0/O/1/l/I)', !/[0O1lI]/.test(s1), s1);
  G.setupSecret();
  A('두 번 실행해도 덮어쓰지 않음 (단축어가 죽지 않게)', store.get('SHARED_SECRET') === s1);
}

console.log('\n[음성 모드 (voice=1)]');
{
  /* 같은 chat 경로를 화면(앱 어시스턴트)과 시리가 함께 쓴다. 다른 것은 **답을 어디로
     내보내느냐** 하나뿐이라, 프롬프트와 길이 규칙이 실제로 갈라지는지 본다. */
  const snap = { today: '2026-09-03', lists: [], tasks: [] };
  const screen = G.chatSystem(snap, false);
  const voice = G.chatSystem(snap, true);

  A('두 모드의 프롬프트가 실제로 다르다', screen !== voice);
  A('음성 모드는 소리내어 읽힌다고 알려 준다', /소리내어 읽는다/.test(voice));
  A('음성 모드는 마크다운을 금지한다', /마크다운/.test(voice));
  A('음성 모드는 길이를 제한한다', /3문장 이내/.test(voice));
  A('화면 모드는 여전히 충실한 답을 요구한다', /충실하게/.test(screen));
  A('화면 모드에는 음성 규칙이 새어 들어가지 않는다', !/소리내어 읽는다/.test(screen));
  A('공통 규칙(도구 호출)은 양쪽 모두 유지', /반드시 도구를 호출한다/.test(screen) && /반드시 도구를 호출한다/.test(voice));
  A('스냅샷은 양쪽 모두 실린다', screen.includes('2026-09-03') && voice.includes('2026-09-03'));

  /* 쿼리로 오면 값은 문자열이다 */
  A("truthy: '1' 은 참", G.truthy('1') === true);
  A("truthy: 'true' 는 참", G.truthy('true') === true);
  A("truthy: '0'·빈값·없음은 거짓",
    G.truthy('0') === false && G.truthy('') === false && G.truthy(undefined) === false);

  /* 낭독 길이 */
  const short = '오늘 할 일은 세 건입니다. 가장 급한 것은 배포 파이프라인 점검입니다.';
  A('짧은 답은 그대로 둔다', G.trimSpeech(short) === short, G.trimSpeech(short));
  A('마크다운 기호를 걷어낸다', !/[*_#`]/.test(G.trimSpeech('**굵게** 그리고 `코드`')), G.trimSpeech('**굵게** 그리고 `코드`'));
  A('줄바꿈을 한 줄로 편다', !/\n/.test(G.trimSpeech('첫 줄\n\n둘째 줄')), JSON.stringify(G.trimSpeech('첫 줄\n\n둘째 줄')));

  const long = ('프로젝트 조직개편 초안을 먼저 마무리하는 것이 좋겠습니다. ').repeat(20);
  const cut = G.trimSpeech(long);
  A('긴 답은 잘라 낸다', cut.length < long.length && cut.length <= 480, String(cut.length));
  A('잘랐다는 사실을 알려 준다', /앱에서 확인/.test(cut));
  A('문장 중간에서 끊지 않는다', /(다\.|\.)\s*자세한 내용은/.test(cut), cut.slice(-60));
}

console.log(`\n실패 ${bad}건`);
process.exitCode = bad ? 1 : 0;
