/* AI 어시스턴트 검증 — 모의 프록시로 Interactions / generateContent 양쪽 형식과
   function calling 실행 루프를 확인한다. */
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const statics = http.createServer((rq, rs) => {
  const f = path.join(__dirname, rq.url === '/' ? 'index.html' : rq.url.split('?')[0]);
  fs.readFile(f, (e, d) => {
    if (e) { rs.writeHead(404); return rs.end(); }
    rs.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' }); rs.end(d);
  });
});

/* ── 모의 프록시 ──────────────────────────────────────────────────────
   script: 요청마다 꺼내 쓰는 응답 큐. { status, kind, body } 또는 함수     */
let script = [], seen = [];
const proxy = http.createServer((rq, rs) => {
  const cors = {
    'Access-Control-Allow-Origin': rq.headers.origin || '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
  if (rq.method === 'OPTIONS') { rs.writeHead(204, cors); return rs.end(); }
  if (rq.url === '/health') {
    rs.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    return rs.end(JSON.stringify({ ok: true, hasKey: true }));
  }
  let raw = '';
  rq.on('data', c => raw += c);
  rq.on('end', () => {
    let body = {}; try { body = JSON.parse(raw); } catch (e) {}
    seen.push({ path: body.__path, auth: rq.headers.authorization || '', body });
    const next = script.shift();
    const out = typeof next === 'function' ? next(body) : next;
    if (!out) { rs.writeHead(500, cors); return rs.end('{}'); }
    rs.writeHead(out.status || 200, { ...cors, 'Content-Type': 'application/json' });
    rs.end(JSON.stringify(out.body || {}));
  });
});

/* 응답 헬퍼 */
const intCall = (id, calls, text) => ({
  status: 200,
  body: {
    id,
    execution_steps: [
      ...calls.map((c, i) => ({ step_type: 'function_call', function_call: { id: 'c' + i, name: c.name, arguments: c.args } })),
      ...(text ? [{ step_type: 'model_output', model_output: { text } }] : [])
    ]
  }
});
const genCall = (calls, text) => ({
  status: 200,
  body: {
    candidates: [{
      content: {
        role: 'model',
        parts: [
          ...calls.map(c => ({ functionCall: { name: c.name, args: c.args } })),
          ...(text ? [{ text }] : [])
        ]
      }
    }]
  }
});

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/* 픽스처의 '오늘' 은 컨테이너의 UTC 가 아니라 **브라우저가 돌 시간대(Asia/Seoul)** 의
   날짜여야 한다. 두 날짜는 매일 15:00 UTC 부터 자정까지 하루 어긋나고, 그 사이에 돌리면
   shift(0) 이 '어제', shift(1) 이 '오늘' 이 되어 오늘 뷰 관련 단언이 통째로 무너진다.
   (실제로 겪었다 — 아침에 통과하던 정렬 테스트가 저녁에 3건 깨졌다.) */
const seoulNow = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
const sh = n => { const d = seoulNow(); d.setDate(d.getDate() + n); return ymd(d) + 'T00:00:00.000Z'; };
const LISTS = [{ id: 'GL_work', title: '업무' }, { id: 'GL_lab', title: '프로젝트' }];
const mkTasks = () => ({
  GL_work: [
    { id: 'gid_alpha', title: '분기 예산안 검토', notes: '⟦p1 @긴급⟧', due: sh(0), status: 'needsAction', position: '001' },
    { id: 'gid_beta', title: '보안 점검 대응 자료', notes: '', due: sh(-3), status: 'needsAction', position: '002' }
  ],
  GL_lab: [
    { id: 'gid_gamma', title: '배포 파이프라인 2차 점검', notes: '⟦p2 @검증⟧', due: sh(2), status: 'needsAction', position: '001' }
  ]
});

(async () => {
  await new Promise(r => statics.listen(4180, r));
  await new Promise(r => proxy.listen(4181, r));
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
  let bad = 0; const errs = [];
  const A = (n, c, extra) => { console.log(`  ${c ? '✓' : '✗'} ${n}${c ? '' : (extra ? '  → ' + extra : '')}`); if (!c) bad++; };

  async function boot(variantSeed) {
    const TASKS = mkTasks();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
    page.on('console', m => {
      const t = m.text();
      if (m.type() !== 'error') return;
      if (/favicon/.test(t)) return;
      if (/Failed to load resource/.test(t)) return;   // 의도적으로 스크립트한 4xx 응답
      errs.push('CONSOLE: ' + t);
    });
    await page.addInitScript(seed => {
      window.google = { accounts: { oauth2: { initTokenClient: cfg => ({
        callback: cfg.callback,
        requestAccessToken() { setTimeout(() => this.callback({ access_token: 'tok_test', expires_in: 3600 }), 10); }
      }) } } };
      try {
        localStorage.setItem('malro.clientId', 'test.apps.googleusercontent.com');
        localStorage.setItem('malro.aiUrl', 'http://localhost:4181');
        localStorage.setItem('malro.aiVariant', seed || '');
      } catch (e) {}
    }, variantSeed);
    await page.route('https://tasks.googleapis.com/**', route => {
      const u = new URL(route.request().url()), method = route.request().method();
      if (u.pathname.endsWith('/users/@me/lists')) return route.fulfill({ json: { items: LISTS } });
      const lm = u.pathname.match(/\/lists\/([^/]+)\/tasks$/);
      if (lm && method === 'GET') return route.fulfill({ json: { items: TASKS[lm[1]] || [] } });
      if (method === 'POST') {
        const b = JSON.parse(route.request().postData() || '{}');
        const created = { ...b, id: 'gid_new' + Math.random().toString(36).slice(2, 6), position: '900' };
        const lid = (u.pathname.match(/\/lists\/([^/]+)\/tasks/) || [])[1];
        if (lid) (TASKS[lid] = TASKS[lid] || []).push(created);
        return route.fulfill({ json: created });
      }
      if (method === 'PATCH' || method === 'PUT') {
        const b = JSON.parse(route.request().postData() || '{}');
        const id = u.pathname.split('/').pop();
        for (const k of Object.keys(TASKS)) {
          const i = TASKS[k].findIndex(x => x.id === id);
          if (i >= 0) { TASKS[k][i] = { ...TASKS[k][i], ...b }; return route.fulfill({ json: TASKS[k][i] }); }
        }
        return route.fulfill({ json: { id, ...b } });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    await page.route('https://accounts.google.com/**', r => r.fulfill({ body: '', contentType: 'text/javascript' }));
    await page.goto('http://localhost:4180/index.html');
    await page.waitForTimeout(300);
    await page.locator('#authBtn').click();
    await page.waitForTimeout(800);
    return page;
  }

  async function ask(page, text) {
    await page.locator('#chatInput').fill(text);
    await page.locator('#chatSend').click();
    await page.waitForFunction(() => !document.querySelector('.bub.typing'), null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);
  }

  /* ── 1. Interactions 형식 + 태스크 생성 ── */
  console.log('\n[Interactions 형식 · 태스크 생성]');
  let page = await boot('int-input');        // 이 구간은 Interactions 형식을 고정해 검증
  script = []; seen = [];
  await page.locator('[data-ai]').click();
  await page.waitForTimeout(400);
  A('챗 패널 열림', await page.locator('#chat').evaluate(e => e.classList.contains('on')));
  A('빈 상태 프리셋 칩 3개', (await page.locator('.chip-btn').count()) === 3);
  await page.screenshot({ path: 'shot-19-chat-empty.png' });

  script = [
    intCall('int_1', [{ name: 'create_task', args: { title: '회귀테스트 계획 수립', due: ymd(new Date(Date.now() + 6 * 864e5)), priority: 2, list: '업무', labels: ['품질'] } }]),
    intCall('int_2', [], '회귀테스트 계획 수립을 업무에 추가했습니다.')
  ];
  await ask(page, '다음주에 회귀테스트 계획 수립 추가해 줘');
  A('도구 실행 표시', (await page.locator('.msg.tool').count()) === 1);
  A('어시스턴트 응답 표시', (await page.locator('.msg.ai .bub').last().innerText()).includes('추가'));
  A('실제 태스크 생성됨', (await page.locator('#wrap').innerText()).includes('회귀테스트 계획 수립')
    || (await page.evaluate(() => allTasks().some(t => t.title === '회귀테스트 계획 수립'))));
  A('두 번째 요청에 previous_interaction_id 전달', seen[1].body.previous_interaction_id === 'int_1', JSON.stringify(Object.keys(seen[1].body)));
  A('Authorization 헤더 전달', /^Bearer tok_test$/.test(seen[0].auth));
  A('경로가 interactions', seen[0].path === '/v1beta/interactions');
  await page.screenshot({ path: 'shot-20-chat-created.png' });

  /* ── 2. 실제 Google 태스크 ID 가 전송되지 않는지 ── */
  const sysText = String(seen[0].body.system_instruction || '');
  A('실제 태스크 ID 미전송 (별칭만)', !sysText.includes('gid_alpha') && !sysText.includes('GL_work'),
    sysText.includes('gid_alpha') ? 'gid_alpha 노출' : 'GL_work 노출');
  A('별칭 t1 포함', sysText.includes('"id":"t1"'), sysText.slice(sysText.indexOf('"tasks"'), sysText.indexOf('"tasks"') + 120));
  A('스냅샷에 오늘 날짜 포함', sysText.includes(ymd(seoulNow())));

  /* ── 3. 별칭으로 완료 처리 ── */
  console.log('\n[별칭 해석 · 완료 처리]');
  script = [
    intCall('int_3', [{ name: 'complete_task', args: { id: 't1' } }]),
    intCall('int_4', [], '완료 처리했습니다.')
  ];
  const firstTitle = await page.evaluate(() => allTasks().filter(t => !t.done)[0].title);
  await ask(page, '첫 번째 항목 완료 처리해 줘');
  A(`별칭 t1 이 올바른 태스크로 해석됨 (${firstTitle})`,
    await page.evaluate(t => allTasks().some(x => x.title === t && x.done), firstTitle));

  /* ── 4. 한 응답에 여러 도구 호출 ── */
  console.log('\n[다중 도구 호출]');
  script = [
    intCall('int_5', [
      { name: 'create_task', args: { title: '이슈 A 조치', list: '프로젝트' } },
      { name: 'create_task', args: { title: '이슈 B 조치', list: '프로젝트' } }
    ]),
    intCall('int_6', [], '두 건 추가했습니다.')
  ];
  await ask(page, '프로젝트에 이슈 A 조치, 이슈 B 조치 두 개 추가');
  A('도구 두 번 실행', (await page.evaluate(() => allTasks().filter(t => /이슈 [AB] 조치/.test(t.title)).length)) === 2);

  /* ── 5. 오류 메시지 한국어 노출 ── */
  console.log('\n[오류 처리]');
  script = [{ status: 401, body: { error: 'unauthorized', reason: 'email-not-allowed' } }];
  await ask(page, '아무거나');
  let errText = await page.locator('.msg.err').last().innerText();
  A('401 email-not-allowed → ALLOWED_EMAILS 안내', /ALLOWED_EMAILS/.test(errText), errText);

  script = [{ status: 401, body: { error: 'unauthorized', reason: 'no-email' } }];
  await ask(page, '아무거나');
  errText = await page.locator('.msg.err').last().innerText();
  A('401 no-email → 권한 재요청 안내 (원인이 다르면 안내도 달라야 함)',
    /새로고침|권한/.test(errText) && !/ALLOWED_EMAILS/.test(errText), errText);

  script = [{ status: 403, body: { error: 'origin-not-allowed' } }];
  await ask(page, '아무거나');
  errText = await page.locator('.msg.err').last().innerText();
  A('403 → ALLOWED_ORIGINS 안내', /ALLOWED_ORIGINS/.test(errText), errText);
  A('형식이 확정된 뒤에는 폴백하지 않음', script.length === 0);

  /* ── 6. 기본 경로: generateContent (실측상 확실히 동작하는 형식) ── */
  console.log('\n[기본 경로 = generateContent]');
  const page2 = await boot('');
  script = [
    genCall([{ name: 'create_task', args: { title: '기본 경로 확인', list: '프로젝트' } }]),
    genCall([], '추가했습니다.')
  ];
  seen = [];
  await page2.locator('[data-ai]').click(); await page2.waitForTimeout(300);
  await ask(page2, '기본 경로 확인 추가해 줘');
  A('첫 시도가 generateContent', seen[0].path.includes(':generateContent'), seen.map(s => s.path).join(' | '));
  A('태스크 생성', await page2.evaluate(() => allTasks().some(t => t.title === '기본 경로 확인')));
  A('형식을 gen 으로 기억', await page2.evaluate(() => localStorage.getItem('malro.aiVariant')) === 'gen');
  A('히스토리에 functionResponse 포함',
    JSON.stringify(seen[1].body.contents || []).includes('functionResponse'));
  const genSys = ((seen[0].body.systemInstruction || {}).parts || [{}])[0].text || '';
  A('시스템 지시에 스냅샷 포함', genSys.includes('"id":"t1"'), genSys.slice(-160));
  A('gen 경로도 실제 ID 미전송', !genSys.includes('gid_alpha') && !genSys.includes('GL_work'));

  /* ── 6b. generateContent 가 막히면 Interactions 로 폴백 ── */
  console.log('\n[폴백: gen 실패 → Interactions]');
  const page3 = await boot('');
  script = [
    { status: 400, body: { error: { message: 'generateContent is not supported' } } },
    intCall('int_f1', [{ name: 'create_task', args: { title: '폴백 경로 확인', list: '프로젝트' } }]),
    intCall('int_f2', [], '추가했습니다.')
  ];
  seen = [];
  await page3.locator('[data-ai]').click(); await page3.waitForTimeout(300);
  await ask(page3, '폴백 경로 확인 추가해 줘');
  A('gen 실패 후 interactions 로 재시도',
    seen.length >= 2 && seen[0].path.includes(':generateContent') && seen[1].path === '/v1beta/interactions',
    seen.map(s => s.path).join(' | '));
  A('폴백 후 태스크 생성', await page3.evaluate(() => allTasks().some(t => t.title === '폴백 경로 확인')));
  A('통한 형식을 기억', await page3.evaluate(() => localStorage.getItem('malro.aiVariant')) === 'int-input');
  A('실패한 시도가 히스토리를 오염시키지 않음',
    !JSON.stringify(seen[1].body).includes('generateContent'));

  /* ── 6c. 분석 답변이 화면에 나오는가 (실사용에서 잡힌 버그) ──
     증상: "지연 항목을 분석해 줘" 에 대해 본문 대신 "완료했습니다." 만 떴다.
     원인 두 가지 — (a) 모델이 사고에 출력 예산을 다 써 본문 없이 MAX_TOKENS 로 끝남
                    (b) 앱이 빈 텍스트를 "완료했습니다." 로 덮어써 원인을 감춤 */
  console.log('\n[분석 답변 렌더링]');
  /* .bub 만 보면 오류 말풍선(.msg.err)을 놓친다 — 실제로 이 테스트를 처음 쓸 때 놓쳤다 */
  const bubbles = p => p.evaluate(() => [...document.querySelectorAll('#chatBody .msg')].map(e => e.innerText.trim()));

  const pA = await boot('gen');
  script = [genCall([], '지연 3건은 모두 외부 회신 대기입니다. 보안 점검 대응 자료가 3일 밀렸습니다.')];
  await pA.locator('[data-ai]').click(); await pA.waitForTimeout(300);
  seen = [];
  await ask(pA, '기한이 지난 항목들을 분석해 줘');
  let bs = await bubbles(pA);
  A('분석 본문이 그대로 표시됨', bs.some(t => t.includes('외부 회신 대기')), bs.join(' | '));
  A('"완료했습니다." 로 덮어쓰지 않음', !bs.some(t => t === '완료했습니다.'), bs.join(' | '));
  A('도구 호출 없이 1회만 요청', seen.length === 1, String(seen.length));
  A('maxOutputTokens 를 명시해 잘림 방지',
    (seen[0].body.generationConfig || {}).maxOutputTokens >= 4096,
    JSON.stringify(seen[0].body.generationConfig));

  /* MAX_TOKENS 로 본문 없이 끝나면 생각을 끄고 한 번 재시도한다 */
  const pB = await boot('gen');
  script = [
    { status: 200, body: { candidates: [{ finishReason: 'MAX_TOKENS' }] } },
    genCall([], '재시도에서 나온 분석 본문입니다.')
  ];
  await pB.locator('[data-ai]').click(); await pB.waitForTimeout(300);
  seen = [];
  await ask(pB, '지연 분석해 줘');
  bs = await bubbles(pB);
  A('빈 응답이면 재시도함', seen.length === 2, String(seen.length));
  A('재시도는 사고를 끈다', seen[1] && (seen[1].body.generationConfig || {}).thinkingConfig?.thinkingBudget === 0,
    JSON.stringify(seen[1] && seen[1].body.generationConfig));
  A('재시도 본문이 표시됨', bs.some(t => t.includes('재시도에서 나온')), bs.join(' | '));
  A('재시도 시 사용자 발화를 중복 전송하지 않음',
    JSON.stringify(seen[1].body.contents).split('지연 분석해 줘').length - 1 === 1);

  /* 재시도까지 비면, 지어내지 말고 사유를 말한다 */
  const pC = await boot('gen');
  script = [
    { status: 200, body: { candidates: [{ finishReason: 'MAX_TOKENS' }] } },
    { status: 200, body: { candidates: [{ finishReason: 'MAX_TOKENS' }] } }
  ];
  await pC.locator('[data-ai]').click(); await pC.waitForTimeout(300);
  await ask(pC, '분석해 줘');
  bs = await bubbles(pC);
  A('빈 응답 사유를 사람 말로 알림', bs.some(t => /출력 한도/.test(t)), bs.join(' | '));
  A('빈 응답을 완료로 위장하지 않음', !bs.some(t => t === '완료했습니다.'), bs.join(' | '));

  /* 차단된 경우도 사유를 그대로 */
  const pD = await boot('gen');
  script = [
    { status: 200, body: { promptFeedback: { blockReason: 'SAFETY' }, candidates: [] } },
    { status: 200, body: { promptFeedback: { blockReason: 'SAFETY' }, candidates: [] } }
  ];
  await pD.locator('[data-ai]').click(); await pD.waitForTimeout(300);
  await ask(pD, '분석해 줘');
  bs = await bubbles(pD);
  A('차단 사유를 알림', bs.some(t => /차단/.test(t) && /SAFETY/.test(t)), bs.join(' | '));

  /* 생각 파트는 화면에도 히스토리에도 넣지 않는다 */
  const pE = await boot('gen');
  script = [
    { status: 200, body: { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: '내부 사고 흔적', thought: true }] } }] } },
    genCall([], '실제 답변입니다.')
  ];
  await pE.locator('[data-ai]').click(); await pE.waitForTimeout(300);
  seen = [];
  await ask(pE, '분석해 줘');
  bs = await bubbles(pE);
  A('생각 파트를 화면에 쓰지 않음', !bs.some(t => t.includes('내부 사고 흔적')), bs.join(' | '));
  A('생각뿐인 턴을 히스토리에 넣지 않음',
    !JSON.stringify(seen[1].body.contents).includes('내부 사고 흔적'));
  A('생각 이후 실제 답변이 표시됨', bs.some(t => t.includes('실제 답변입니다')), bs.join(' | '));

  /* 도구 실행 후 마무리 문장이 비어도 위장하지 않는다 */
  const pF = await boot('gen');
  script = [
    genCall([{ name: 'create_task', args: { title: '신규 도구 도입 평가', list: '프로젝트' } }]),
    { status: 200, body: { candidates: [{ finishReason: 'MAX_TOKENS' }] } },
    genCall([], '프로젝트에 추가했습니다.')
  ];
  await pF.locator('[data-ai]').click(); await pF.waitForTimeout(300);
  await ask(pF, '신규 도구 도입 평가를 오늘 할 일에 넣어줘');
  bs = await bubbles(pF);
  A('도구 실행은 그대로 성공', await pF.evaluate(() => allTasks().some(t => t.title === '신규 도구 도입 평가')));
  A('도구 후 빈 마무리도 재시도로 복구', bs.some(t => t.includes('프로젝트에 추가했습니다')), bs.join(' | '));

  /* ── 6d. 아이폰에서 반드시 걸리는 프록시 주소 문제 ──
     localhost 는 아이폰 자신을 가리키고, HTTPS 페이지는 http:// 호출을 차단한다.
     둘 다 브라우저가 모호하게 실패시키므로 앱이 먼저 말로 설명해야 한다. */
  console.log('\n[프록시 주소 검사]');
  const chk = (url, host, proto) => pA.evaluate(
    ([u, h, p]) => aiUrlProblem(u, { hostname: h, protocol: p }), [url, host, proto]);

  A('맥 로컬(http 페이지 + localhost)은 문제 없음',
    (await chk('http://localhost:8787', 'localhost', 'http:')) === '');
  {
    /* 맥에서 이 경고를 보면 "아이폰 얘기"로 읽고 넘어가 버린다 — 실제로 그랬다.
       맥의 조치(localhost:4173 으로 열기)와 모바일의 제약을 둘 다 말해야 한다. */
    const msg = await chk('http://localhost:8787', 'malro.app', 'https:');
    A('공개 https 페이지 + localhost → 문제로 잡는다', !!msg, msg);
    A('맥에서 할 조치를 알려준다', /localhost:4173/.test(msg), msg);
    A('모바일 제약도 함께 설명', /아이폰/.test(msg), msg);
    A('지금 열린 주소를 그대로 보여준다', /malro\.app/.test(msg), msg);
  }
  A('공개 https 페이지 + http 프록시 → 혼합 콘텐츠 차단 설명',
    /브라우저가 차단/.test(await chk('http://proxy.example.com', 'malro.app', 'https:')));
  A('공개 https 페이지 + https 프록시 → 문제 없음',
    (await chk('https://proxy.example.com', 'malro.app', 'https:')) === '');
  A('주소 형식 오류를 구분',
    /형식이 올바르지 않/.test(await chk('그냥글자', 'malro.app', 'https:')));
  A('빈 주소는 여기서 판정하지 않음', (await chk('', 'malro.app', 'https:')) === '');

  /* 실제 호출 경로에서도 막히는가 — 네트워크로 나가기 전에 걸러야 한다 */
  const pG = await boot('gen');
  await pG.evaluate(() => { AI.url = 'http://localhost:9999'; });
  await pG.locator('[data-ai]').click(); await pG.waitForTimeout(300);
  seen = []; script = [];
  await pG.evaluate(() => {                       // 오리진만 공개 https 인 것처럼 바꿔 호출
    window.__origProblem = aiUrlProblem;
    window.aiUrlProblem = u => window.__origProblem(u, { hostname: 'malro.app', protocol: 'https:' });
  });
  await ask(pG, '분석해 줘');
  bs = await bubbles(pG);
  A('닿지 않는 주소면 요청을 보내지 않음', seen.length === 0, String(seen.length));
  A('이유를 화면에 표시', bs.some(t => /localhost 프록시에 닿을 수 없습니다/.test(t)), bs.join(' | '));

  /* ── 6e. Apps Script 백엔드 모드 ──
     프록시가 script.google.com 이면 프로토콜이 통째로 다르다. 서버가 대화 전체를
     처리하므로 브라우저는 문장 한 줄만 보낸다. preflight 를 부르는 헤더를 하나라도
     붙이면 Apps Script 는 요청 자체를 못 받는다 — 그래서 헤더까지 검사한다. */
  console.log('\n[Apps Script 백엔드]');
  const GAS = 'https://script.google.com/macros/s/AKfyTEST/exec';

  async function bootGas(script) {
    const pg = await boot('');
    const seenReq = [];
    await pg.route('https://script.google.com/**', async route => {
      const rq = route.request();
      seenReq.push({ method: rq.method(), url: rq.url(), headers: rq.headers(), body: rq.postData() });
      const next = script.shift();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(next) });
    });
    await pg.evaluate(u => {
      AI.url = u; try { localStorage.setItem('malro.aiSecret', 'S'.repeat(40)); } catch (e) {}
    }, GAS);
    await pg.locator('[data-ai]').click(); await pg.waitForTimeout(250);
    return { pg, seenReq };
  }

  {
    const { pg, seenReq } = await bootGas([{ ok: true, speak: '지연 3건은 모두 외부 회신 대기입니다.', actions: [], changed: false }]);
    await ask(pg, '지연 분석해 줘');
    const bs2 = await bubbles(pg);
    A('Apps Script 주소면 그쪽으로 보낸다', seenReq.length === 1, JSON.stringify(seenReq.length));
    A('POST 로 먼저 시도', seenReq[0].method === 'POST', seenReq[0].method);
    A('preflight 를 부르는 Content-Type 을 쓰지 않는다',
      /text\/plain/.test(seenReq[0].headers['content-type'] || ''), seenReq[0].headers['content-type']);
    A('Authorization 헤더를 붙이지 않는다', !seenReq[0].headers['authorization']);
    const body = JSON.parse(seenReq[0].body || '{}');
    A('문장 한 줄만 보낸다 (도구 정의·스냅샷 없음)',
      !!body.text && !body.tools && !body.contents && !body.systemInstruction, seenReq[0].body.slice(0, 120));
    A('action 은 chat', body.action === 'chat');
    A('시크릿을 본문에 싣는다 (URL 아님)',
      body.secret === 'S'.repeat(40) && !seenReq[0].url.includes('secret='));
    A('응답 본문을 그대로 표시', bs2.some(t => /외부 회신 대기/.test(t)), bs2.join(' | '));
  }

  {
    /* 302 에서 본문이 사라지면 서버는 action 을 못 받아 상태 JSON 을 돌려준다.
       그게 신호다 — 쿼리 방식으로 한 번 더 시도해야 한다. */
    const { pg, seenReq } = await bootGas([
      { ok: true, service: 'malro-voice', hasKey: true, hasSecret: true },
      { ok: true, speak: '쿼리 경로로 처리했습니다.', actions: [], changed: false }
    ]);
    await ask(pg, '오늘 뭐 해야 하지');
    const bs3 = await bubbles(pg);
    A('본문 유실을 감지해 쿼리로 재시도', seenReq.length === 2, String(seenReq.length));
    A('재시도는 GET', seenReq[1] && seenReq[1].method === 'GET', seenReq[1] && seenReq[1].method);
    A('재시도 쿼리에 action·text 가 실린다',
      /action=chat/.test(seenReq[1].url) && /text=/.test(seenReq[1].url));
    A('재시도 결과가 표시됨', bs3.some(t => /쿼리 경로로 처리/.test(t)), bs3.join(' | '));
  }

  {
    const { pg, seenReq } = await bootGas([
      { ok: true, speak: '프로젝트에 추가했습니다.', actions: ['create_task'], changed: true }
    ]);
    await ask(pg, '내일 센서 점검 추가해 줘');
    const bs4 = await bubbles(pg);
    A('서버가 실행한 도구를 칩으로 보여준다', bs4.some(t => /태스크 생성/.test(t)), bs4.join(' | '));
    A('changed 면 동기화해서 화면을 맞춘다',
      await pg.evaluate(() => S.lists.length > 0));
  }

  {
    /* 시크릿 없이 부르면 네트워크로 나가기 전에 막아야 한다 */
    const pg = await boot('');
    let hit = 0;
    await pg.route('https://script.google.com/**', r => { hit++; r.fulfill({ status: 200, body: '{}' }); });
    await pg.evaluate(u => { AI.url = u; try { localStorage.removeItem('malro.aiSecret'); } catch (e) {} }, GAS);
    await pg.locator('[data-ai]').click(); await pg.waitForTimeout(250);
    await ask(pg, '아무거나');
    const bs5 = await bubbles(pg);
    A('시크릿이 없으면 요청을 보내지 않는다', hit === 0, String(hit));
    A('무엇이 없는지 말해 준다', bs5.some(t => /시크릿/.test(t)), bs5.join(' | '));
  }

  /* ── 7. 설정 화면 ── */
  console.log('\n[설정]');
  await page3.locator('#chatCog').click(); await page2.waitForTimeout(300);
  A('설정 패널 열림', await page3.locator('#chatSettings').evaluate(e => e.classList.contains('on')));
  A('프록시 주소 표시', (await page3.locator('#aiUrl').inputValue()) === 'http://localhost:4181');
  await page3.locator('#aiTest').click(); await page2.waitForTimeout(700);
  A('연결 확인 성공 표시', /연결됨/.test(await page3.locator('#aiMsg').innerText()));
  await page3.screenshot({ path: 'shot-21-chat-settings.png' });

  /* ── 8. 모바일 ── */
  const mctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, locale: 'ko-KR' });
  const mp = await mctx.newPage();
  await mp.addInitScript(() => {
    window.google = { accounts: { oauth2: { initTokenClient: cfg => ({ callback: cfg.callback, requestAccessToken() { setTimeout(() => this.callback({ access_token: 'tok_test', expires_in: 3600 }), 10); } }) } } };
    try { localStorage.setItem('malro.clientId', 'x'); localStorage.setItem('malro.aiUrl', 'http://localhost:4181'); } catch (e) {}
  });
  await mp.route('https://tasks.googleapis.com/**', r => {
    const u = new URL(r.request().url());
    if (u.pathname.endsWith('/users/@me/lists')) return r.fulfill({ json: { items: LISTS } });
    return r.fulfill({ json: { items: [] } });
  });
  await mp.route('https://accounts.google.com/**', r => r.fulfill({ body: '', contentType: 'text/javascript' }));
  await mp.goto('http://localhost:4180/index.html');
  await mp.waitForTimeout(400); await mp.locator('#authBtn').click(); await mp.waitForTimeout(700);
  await mp.locator('#menuBtn').click(); await mp.waitForTimeout(400);
  await mp.locator('[data-ai]').click(); await mp.waitForTimeout(500);
  console.log('\n[모바일]');
  A('아이폰 폭에서 전체 화면 패널', (await mp.locator('#chat').boundingBox()).width >= 390);
  A('가로 스크롤 없음', await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await mp.screenshot({ path: 'shot-22-chat-iphone.png' });

  console.log('\n[오류] ' + (errs.length ? '\n  ' + errs.join('\n  ') : '없음'));
  console.log(`\n실패 ${bad}건`);
  process.exitCode = (bad || errs.length) ? 1 : 0;
  await browser.close(); statics.close(); proxy.close();
})();
