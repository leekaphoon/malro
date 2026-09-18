/* UI 스모크 테스트 — 가짜 Google Tasks API 로 렌더/상호작용 검증 후 스크린샷 */
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const f = path.join(__dirname, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : req.url.split('?')[0]);
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' }); res.end(d);
  });
});

/* 픽스처의 '오늘' 은 컨테이너의 UTC 가 아니라 **브라우저가 돌 시간대(Asia/Seoul)** 의
   날짜여야 한다. 두 날짜는 매일 15:00 UTC 부터 자정까지 하루 어긋나고, 그 사이에 돌리면
   shift(0) 이 '어제', shift(1) 이 '오늘' 이 되어 오늘 뷰 관련 단언이 통째로 무너진다.
   (실제로 겪었다 — 아침에 통과하던 정렬 테스트가 저녁에 3건 깨졌다.) */
const seoulNow = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
const today = seoulNow();
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shift = n => { const d = new Date(today); d.setDate(d.getDate() + n); return ymd(d) + 'T00:00:00.000Z'; };

const LISTS = [{ id: 'L1', title: '업무' }, { id: 'L2', title: '프로젝트' }, { id: 'L3', title: '개인' }];
const TASKS = {
  L1: [
    { id: 't1', title: '분기 예산안 검토', notes: '검토 의견 3건 잔여\n\n⟦p1 @긴급 ⏰09:30 ⏳45⟧', due: shift(0), status: 'needsAction', position: '001' },
    { id: 't2', title: '주간 스탠드업 회의', notes: '⟦p3 @팀 ↻wd ⏰09:00⟧', due: shift(0), status: 'needsAction', position: '002' },
    { id: 't3', title: '고객 피드백 정리', notes: '⟦p2 @기획⟧', due: shift(-2), status: 'needsAction', position: '003' },
    { id: 't4', title: '채용 공고 초안', notes: '⟦p2 ↻m1⟧', due: shift(5), status: 'needsAction', position: '004' },
    { id: 't5', title: '보안 점검 대응 자료', notes: '', due: shift(1), status: 'needsAction', position: '005' },
    { id: 't6', title: '지난주 회고 문서화', notes: '⟦p4⟧', due: shift(-1), status: 'completed', completed: shift(-1), position: '006' }
  ],
  L2: [
    { id: 't7', title: '배포 파이프라인 2차 점검', notes: '롤백 시간 5분 이내 목표\n\n⟦p1 @검증 ⏰14:00 ↻w1:1⟧', due: shift(0), status: 'needsAction', position: '001' },
    { id: 't8', title: '로드맵 TO-BE 초안', notes: '⟦p2 @조직⟧', due: shift(3), status: 'needsAction', position: '002' },
    { id: 't9', title: '품질 점검 결과 취합', notes: '⟦p3 @품질⟧', due: shift(9), status: 'needsAction', position: '003' }
  ],
  L3: [
    { id: 't10', title: '치과 예약', notes: '⟦p3 ⏰18:30⟧', due: shift(2), status: 'needsAction', position: '001' },
    { id: 't11', title: '주말 등산 코스 확인', notes: '⟦p4 @취미⟧', status: 'needsAction', position: '002' }
  ]
};

(async () => {
  await new Promise(r => server.listen(4173, r));
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
  const errors = [];

  async function makePage(opts) {
    const ctx = await browser.newContext({ ...opts, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
    /* 어떤 주소가 막혔는지 남긴다 — 'ERR_TUNNEL_CONNECTION_FAILED' 만으로는 스텁이 빠진 것인지
       환경이 막은 것인지 구분할 수 없다. 실제로 그걸 몰라 한참 헤맸다. */
    page.on('requestfailed', r => {
      /* 컨텍스트를 닫는 순간 날아가던 요청은 ERR_ABORTED 로 떨어진다 — 앱의 결함이 아니라
         테스트 종료 방식의 부산물이다. 이걸 오류로 세면 통과한 판이 종료 코드 1을 낸다. */
      const e = (r.failure() || {}).errorText || '';
      if (e.includes('ERR_ABORTED')) return;
      errors.push('REQFAIL: ' + r.url() + ' — ' + e);
    });
    // Google Identity Services 스텁
    await page.addInitScript(() => {
      window.google = { accounts: { oauth2: { initTokenClient: cfg => ({
        callback: cfg.callback,
        requestAccessToken() { setTimeout(() => this.callback({ access_token: 'fake', expires_in: 3600 }), 10); }
      }) } } };
      localStorage.setItem('saydo.clientId', 'test.apps.googleusercontent.com');
    });
    await page.route('https://tasks.googleapis.com/**', route => {
      const u = new URL(route.request().url());
      if (u.pathname.endsWith('/users/@me/lists')) return route.fulfill({ json: { items: LISTS } });
      const m = u.pathname.match(/\/lists\/([^/]+)\/tasks$/);
      if (m && route.request().method() === 'GET') return route.fulfill({ json: { items: TASKS[m[1]] || [] } });
      if (route.request().method() === 'POST') {
        const b = JSON.parse(route.request().postData() || '{}');
        return route.fulfill({ json: { ...b, id: 'new_' + Math.random().toString(36).slice(2, 7), position: '999' } });
      }
      if (route.request().method() === 'PATCH' || route.request().method() === 'PUT') {
        const b = JSON.parse(route.request().postData() || '{}');
        const id = u.pathname.split('/').pop();
        return route.fulfill({ json: { id, ...b } });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    await page.route('https://accounts.google.com/**', r => r.fulfill({ body: '', contentType: 'text/javascript' }));
    await page.route('https://www.googleapis.com/oauth2/v3/userinfo', r => r.fulfill({ json: { email: 'you@example.com' } }));
    return page;
  }

  let bad = 0;
  const assert = (n, c, extra) => { console.log(`  ${c ? "✓" : "✗"} ${n}${c || extra === undefined ? "" : " — " + extra}`); if (!c) bad++; };

  /* ── 데스크톱 ── */
  const page = await makePage({ viewport: { width: 1320, height: 900 } });
  await page.goto('http://localhost:4173/index.html');
  await page.waitForTimeout(400);
  console.log('\n[데스크톱]');
  console.log(`  ✓ 최초 실행 시 연결 화면 노출 (팝업 차단 회피용 사용자 제스처 요구)`);
  await page.locator('#authBtn').click();          // 최초 1회 연결
  await page.waitForTimeout(900);
  assert('인증 화면 통과', !(await page.locator('#auth').evaluate(e => e.classList.contains('on'))));
  assert('사이드바에 목록 3개', (await page.locator('[data-view^="list:"]').count()) === 3);
  const rows = await page.locator('.task').count();
  assert(`오늘 뷰에 태스크 렌더 (${rows}건)`, rows >= 3);
  assert('지연됨 섹션 존재', (await page.locator('.sec-h .t.overdue').count()) === 1);
  assert('P1 체크박스 색상 적용', (await page.locator('.check.p1').count()) >= 1);
  assert('반복 칩 렌더', (await page.locator('.t-meta .chip', { hasText: '평일마다' }).count()) >= 1);
  assert('라벨 칩 렌더', (await page.locator('.lbl').count()) >= 2);
  await page.screenshot({ path: 'shot-01-today.png' });

  // 컴포저 파싱
  await page.keyboard.press('q');
  await page.waitForTimeout(250);
  await page.locator('#cmpInput').fill('내일 오후 3시 사료 원가 리뷰 p1 @원가 매주 월 ');
  await page.waitForTimeout(200);
  const tags = await page.locator('.ptag').allTextContents();
  console.log('    파싱 태그:', tags.join(' | '));
  assert('컴포저 파싱 태그 4개 이상', tags.length >= 4);
  assert('제목 미리보기 정제', (await page.locator('#cmpHint').textContent()).trim() === '사료 원가 리뷰');
  await page.screenshot({ path: 'shot-02-composer.png' });
  await page.locator('#cmpSave').click();
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  assert('추가 후 태스크 수 증가', (await page.locator('.task').count()) >= rows);

  // 예정 뷰
  await page.locator('[data-view="upcoming"]').click();
  await page.waitForTimeout(350);
  assert('예정 뷰 날짜별 그룹', (await page.locator('.sec-h').count()) >= 2);
  await page.screenshot({ path: 'shot-03-upcoming.png' });

  // 상세 패널
  await page.locator('[data-view="all"]').click();
  await page.waitForTimeout(300);
  await page.locator('.task .t-body').first().click();
  await page.waitForTimeout(450);
  assert('상세 패널 열림', await page.locator('#detail').evaluate(e => e.classList.contains('on')));
  assert('상세 패널 행 7개(상위 항목 포함)', (await page.locator('.dt-row').count()) === 7);
  await page.screenshot({ path: 'shot-04-detail.png' });
  // 우선순위 변경 → 재렌더 후에도 패널 동작 유지되는지 (once:true 버그 회귀 테스트)
  await page.locator('.dt-row [data-p="1"]').click();
  await page.waitForTimeout(400);
  await page.locator('.dt-row [data-p="3"]').click();
  await page.waitForTimeout(400);
  const p3sel = await page.locator('.dt-row [data-p="3"]').getAttribute('style');
  assert('연속 클릭 후에도 상세 패널 반응 (핸들러 유지)', /font-weight:600/.test(p3sel || ''));
  await page.locator('#dtClose').click();

  // 완료 토글
  await page.locator('[data-view="today"]').click();
  await page.waitForTimeout(300);
  const before = await page.locator('.task').count();
  await page.locator('.check').first().click();
  await page.waitForTimeout(700);
  assert('완료 토스트 표시', await page.locator('#toast').evaluate(e => e.classList.contains('on')));
  assert('완료 후 목록에서 제거', (await page.locator('.task').count()) < before);

  // 검색
  await page.locator('[data-view="search"]').click();
  await page.waitForTimeout(250);
  await page.locator('#searchInput').fill('파이프라인');
  await page.waitForTimeout(400);
  /* `>= 1` 은 사실상 아무것도 검증하지 않는다 — 검색이 통째로 망가져 전건을 돌려줘도 통과한다.
     픽스처에서 유일하게 걸리는 낱말을 골라 **정확히 그 한 건**이 나오는지 본다. */
  const hits = await page.locator('.task .t-title').allTextContents();
  assert('검색은 일치하는 것만 돌려준다',
    hits.length === 1 && hits[0].includes('배포 파이프라인'), JSON.stringify(hits));

  // 다크 모드
  const dark = await makePage({ viewport: { width: 1320, height: 900 }, colorScheme: 'dark' });
  await dark.goto('http://localhost:4173/index.html');
  await dark.waitForTimeout(400); await dark.locator('#authBtn').click(); await dark.waitForTimeout(900);
  await dark.screenshot({ path: 'shot-05-dark.png' });
  console.log('\n[다크 모드] 스크린샷 저장');

  /* ── 아이폰 ── */
  const m = await makePage({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await m.goto('http://localhost:4173/index.html');
  await m.waitForTimeout(400); await m.locator('#authBtn').click(); await m.waitForTimeout(900);
  console.log('\n[아이폰 393×852]');
  assert('모바일에서 사이드바 숨김', await m.locator('#sidebar').evaluate(e => e.getBoundingClientRect().left < 0));
  assert('햄버거 버튼 노출', await m.locator('#menuBtn').isVisible());
  const noHScroll = await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  assert('가로 스크롤 없음', noHScroll);
  await m.screenshot({ path: 'shot-06-iphone.png' });
  await m.locator('#menuBtn').click();
  await m.waitForTimeout(450);
  await m.screenshot({ path: 'shot-07-iphone-menu.png' });

  /* ── 클라이언트 ID 해석 순서 ──
     기기를 추가할 때마다 72자를 아이폰 키보드로 입력하지 않도록 기본값을 둔다.
     우선순위: ?cid= > 이 기기 저장값 > 기본값 */
  console.log('\n[클라이언트 ID]');
  async function cidPage(url, seed) {
    const ctx = await browser.newContext({ locale: 'ko-KR' });
    const pg = await ctx.newPage();
    await pg.addInitScript(s => {
      window.google = { accounts: { oauth2: { initTokenClient: c => ({ callback: c.callback, requestAccessToken() {} }) } } };
      try { if (s) localStorage.setItem('saydo.clientId', s); else localStorage.removeItem('saydo.clientId'); } catch (e) {}
    }, seed || '');
    await pg.route('https://tasks.googleapis.com/**', r => r.fulfill({ json: { items: [] } }));
    await pg.route('https://accounts.google.com/**', r => r.fulfill({ body: '', contentType: 'text/javascript' }));
    await pg.goto('http://localhost:4173/index.html' + url);
    await pg.waitForTimeout(350);
    return pg;
  }

  const cA = await cidPage('', null);
  assert('저장값이 없으면 기본 클라이언트 ID 를 쓴다',
    await cA.evaluate(() => S.clientId === DEFAULT_CLIENT_ID && /^\d+-\w+\.apps\.googleusercontent\.com$/.test(S.clientId)));
  assert('기본값이 있으면 입력란을 감춘다',
    await cA.evaluate(() => document.getElementById('cidField').classList.contains('hide')));
  assert('그래도 바꿀 길은 남긴다', await cA.locator('#cidToggle').isVisible());
  await cA.locator('#cidToggle').click();
  assert('변경 링크를 누르면 입력란이 열린다',
    await cA.evaluate(() => !document.getElementById('cidField').classList.contains('hide')));

  /* 클라이언트 ID 고정 — "어느 프로젝트의 것이 아니어야 한다" 는 금지 목록보다,
     "정확히 이것이어야 한다" 가 낫다. 목록에 없는 값이 섞여 들어와도 잡히고,
     금지할 값을 공개 저장소에 적어 둘 필요도 없다. */
  const appSrc = require('fs').readFileSync(__dirname + '/app.js', 'utf8');
  const EXPECT = '345139066407-ogtlu760k9o4dfb3iuiqpcl27e5rfi9p.apps.googleusercontent.com';
  const found = (appSrc.match(/const DEFAULT_CLIENT_ID = '([^']+)'/) || [])[1];
  assert('DEFAULT_CLIENT_ID 가 의도한 값 그대로다', found === EXPECT, String(found));

  const cB = await cidPage('', 'saved.apps.googleusercontent.com');
  assert('이 기기에 저장된 값이 기본값보다 우선',
    await cB.evaluate(() => S.clientId === 'saved.apps.googleusercontent.com'));

  const cC = await cidPage('?cid=fromurl.apps.googleusercontent.com', 'saved.apps.googleusercontent.com');
  assert('?cid= 가 저장값보다 우선',
    await cC.evaluate(() => S.clientId === 'fromurl.apps.googleusercontent.com'));
  assert('?cid= 는 이 기기에 저장된다 (다음부터 주소 없이 열어도 유지)',
    await cC.evaluate(() => localStorage.getItem('saydo.clientId') === 'fromurl.apps.googleusercontent.com'));

  /* ── 새로고침해도 다시 로그인하지 않는가 ──
     토큰이 메모리에만 있으면 새로고침마다 무음 재발급을 시도하는데, Safari 의 ITP 가
     그 경로를 자주 막아 로그인 화면이 매번 떴다. 저장된 토큰이 살아 있으면
     인증 자체를 건너뛰어야 한다. */
  console.log('\n[새로고침 후 재로그인 안 함]');

  async function authPage(seed) {
    const ctx = await browser.newContext({ locale: 'ko-KR' });
    const pg = await ctx.newPage();
    pg.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
    let asked = 0;
    await pg.exposeFunction('__tokenAsked', () => { asked++; });
    await pg.addInitScript(s => {
      window.google = { accounts: { oauth2: { initTokenClient: cfg => ({
        callback: cfg.callback, error_callback: cfg.error_callback,
        requestAccessToken() {
          window.__tokenAsked();
          setTimeout(() => this.callback({ access_token: 'fresh', expires_in: 3600 }), 10);
        }
      }) } } };
      try {
        localStorage.setItem('saydo.clientId', 'test.apps.googleusercontent.com');
        localStorage.setItem('saydo.lists', JSON.stringify([{ id: 'GL_a', title: '프로젝트' }]));
        if (s) localStorage.setItem('saydo.token', s); else localStorage.removeItem('saydo.token');
      } catch (e) {}
    }, seed);
    await pg.route('https://tasks.googleapis.com/**', r => {
      const u = new URL(r.request().url());
      if (u.pathname.endsWith('/users/@me/lists')) return r.fulfill({ json: { items: LISTS } });
      /* 첫 목록에는 항목을 하나 둔다 — "인증을 건너뛰고도 실제로 부팅했는가" 를
         화면에 보이는 것으로 확인하기 위해서다. 비워 두면 단언이 의미를 잃는다. */
      if (/\/lists\/[^/]+\/tasks$/.test(u.pathname) && r.request().method() === 'GET') {
        return r.fulfill({ json: { items: [
          { id: 'gid_r1', title: '새로고침 확인용', notes: '', status: 'needsAction', position: '001' }
        ] } });
      }
      return r.fulfill({ json: { items: [] } });
    });
    await pg.route('https://accounts.google.com/**', r => r.fulfill({ body: '', contentType: 'text/javascript' }));
    await pg.goto('http://localhost:4173/index.html');
    await pg.waitForTimeout(600);
    return { pg, asked: () => asked };
  }

  {
    const live = JSON.stringify({ t: 'saved-token', e: Date.now() + 30 * 60 * 1000 });
    const { pg, asked } = await authPage(live);
    assert('살아 있는 토큰이 있으면 인증 화면을 띄우지 않는다',
      !(await pg.locator('#auth').evaluate(e => e.classList.contains('on'))));
    assert('토큰을 새로 요청하지도 않는다', asked() === 0, String(asked()));
    assert('저장된 토큰을 그대로 쓴다', (await pg.evaluate(() => S.token)) === 'saved-token');
    /* 화면에 보이느냐가 아니라 "부팅해서 실제로 가져왔느냐" 를 본다.
       기본 뷰가 '오늘' 이라 기한 없는 항목은 안 보이는 것이 정상 — 그걸 실패로
       읽으면 앱이 아니라 테스트를 고치게 된다. */
    assert('인증을 건너뛰고도 실제로 부팅해 태스크를 가져온다',
      (await pg.evaluate(() => allTasks().length)) >= 1);
  }

  {
    const expired = JSON.stringify({ t: 'old-token', e: Date.now() - 1000 });
    const { pg, asked } = await authPage(expired);
    assert('만료된 토큰은 쓰지 않는다', (await pg.evaluate(() => S.token)) !== 'old-token');
    assert('만료면 재발급을 시도한다', asked() >= 1, String(asked()));
  }

  {
    const { pg } = await authPage(null);
    assert('토큰이 없으면 종전대로 재발급을 시도한다',
      (await pg.evaluate(() => S.token)) === 'fresh');
    assert('새로 받은 토큰을 저장한다',
      await pg.evaluate(() => {
        const j = JSON.parse(localStorage.getItem('saydo.token') || 'null');
        return !!j && j.t === 'fresh' && j.e > Date.now();
      }));
  }

  {
    /* 401 이면 죽은 토큰을 붙들고 있지 않는다 */
    const live = JSON.stringify({ t: 'dead', e: Date.now() + 30 * 60 * 1000 });
    const { pg } = await authPage(live);
    await pg.route('https://tasks.googleapis.com/**', r => r.fulfill({ status: 401, body: '{}' }));
    /* 사용자가 직접 새로고침한 상황이므로 force. 무인자 fullSync() 는 SYNC_MIN_GAP 으로
       걸러진다 — 그것이 의도한 동작이다(쿼터 절약). 죽은 토큰을 오래 붙들고 있게 되지는
       않는다. 아래에서 확인하듯 사용자가 무엇이든 조작하면 즉시 드러난다. */
    await pg.evaluate(() => fullSync(true).catch(() => {}));
    await pg.waitForTimeout(500);
    assert('401 을 받으면 저장된 토큰을 지운다',
      await pg.evaluate(() => !JSON.parse(localStorage.getItem('saydo.token') || 'null')));
  }

  {
    /* 스로틀이 인증 문제 발견을 늦추지 않는지 — 뮤테이션 경로(flush)는 스로틀 밖이다 */
    const live = JSON.stringify({ t: 'dead', e: Date.now() + 30 * 60 * 1000 });
    const { pg } = await authPage(live);
    await pg.route('https://tasks.googleapis.com/**', r => r.fulfill({ status: 401, body: '{}' }));
    await pg.evaluate(() => { S.lastSync = Date.now(); });     // 방금 동기화한 상태로 만든다
    await pg.evaluate(() => createTask({ title: '스로틀 중 조작' }));
    /* 고정 대기(waitForTimeout)로 쓰면 큐 처리와 경합해 간헐적으로 깨진다 — 실제로 3회 중
       2회 실패했다. 시간이 아니라 **조건**을 기다린다. */
    const cleared = await pg.waitForFunction(
      () => { try { return !JSON.parse(localStorage.getItem('saydo.token') || 'null'); } catch (e) { return true; } },
      null, { timeout: 5000 }).then(() => true).catch(() => false);
    assert('동기화 스로틀 중에도 사용자 조작은 401 을 즉시 드러낸다', cleared);
  }

  {
    /* 무음 재발급이 막혀도(Safari ITP) 캐시된 화면을 통째로 가리지 않는다 */
    const ctx = await browser.newContext({ locale: 'ko-KR' });
    const pg = await ctx.newPage();
    await pg.addInitScript(() => {
      window.google = { accounts: { oauth2: { initTokenClient: cfg => ({
        callback: cfg.callback, error_callback: cfg.error_callback,
        requestAccessToken() { setTimeout(() => cfg.error_callback({ type: 'popup_failed_to_open' }), 10); }
      }) } } };
      try {
        localStorage.setItem('saydo.clientId', 'test.apps.googleusercontent.com');
        localStorage.setItem('saydo.lists', JSON.stringify([{ id: 'GL_a', title: '프로젝트' }]));
        localStorage.removeItem('saydo.token');
      } catch (e) {}
    });
    await pg.route('https://tasks.googleapis.com/**', r => r.fulfill({ json: { items: [] } }));
    await pg.route('https://accounts.google.com/**', r => r.fulfill({ body: '', contentType: 'text/javascript' }));
    await pg.goto('http://localhost:4173/index.html');
    await pg.waitForTimeout(700);
    assert('무음 재발급 실패 시 인증 화면으로 덮지 않는다',
      !(await pg.locator('#auth').evaluate(e => e.classList.contains('on'))));
    assert('대신 다시 연결 안내를 띄운다',
      /연결이 만료/.test(await pg.locator('#toastMsg').innerText()),
      await pg.locator('#toastMsg').innerText());
  }

  /* ── 세션 만료 후 재로그인은 한 번뿐이어야 한다 ──────────────────────────
     예전에는 토큰 획득 경로가 셋(부팅 / 토스트의 '다시 연결' / api() 의 ensureToken)이고
     서로를 몰랐다. 그래서 (a) 배경 동기화가 무음 재시도를 또 날리고 그게 실패하면
     인증 패널이 앱을 덮었고, (b) 대화형 요청에 prompt:'consent' 를 줘서 이미 승인한
     사용자에게도 계정 선택 + 권한 동의 두 화면을 매번 보여 줬다. 합쳐서 "로그인 두 번".

     여기서는 requestAccessToken 호출을 전부 세어 **사용자에게 보이는 창이 정확히 1회**
     인지 본다. 무음 호출과 대화형 호출을 prompt 값으로 구분한다. */
  console.log('\n[세션 만료 후 재연결]');
  {
    const ctx = await browser.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
    const pg = await ctx.newPage();
    pg.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
    await pg.addInitScript(() => {
      window.__auth = [];
      window.google = { accounts: { oauth2: { initTokenClient: cfg => ({
        callback: cfg.callback, error_callback: cfg.error_callback,
        requestAccessToken(o) {
          const prompt = (o && o.prompt) !== undefined ? o.prompt : '(지정안함)';
          window.__auth.push(prompt === '' ? 'silent' : prompt);
          // 대화형은 사람이 팝업을 처리하는 시간이 걸린다 — 그 사이에 배경 동기화가 끼어든다
          if (prompt !== '') setTimeout(() => this.callback({ access_token: 'fresh', expires_in: 3600 }), 600);
          else setTimeout(() => this.error_callback({ type: 'popup_failed_to_open' }), 20);
        }
      }) } } };
      try {
        localStorage.setItem('saydo.clientId', 'test.apps.googleusercontent.com');
        localStorage.setItem('saydo.lists', JSON.stringify([{ id: 'L1', title: '프로젝트' }]));
        localStorage.setItem('saydo.tasks', JSON.stringify({ L1: [{ id: 't1', title: '캐시된 할 일', notes: '', status: 'needsAction', position: '001' }] }));
        localStorage.setItem('saydo.token', JSON.stringify({ t: 'old', e: Date.now() - 1000 }));   // 만료
      } catch (e) {}
    });
    await pg.route('https://tasks.googleapis.com/**', r => {
      const u = new URL(r.request().url());
      if (u.pathname.endsWith('/users/@me/lists')) return r.fulfill({ json: { items: [{ id: 'L1', title: '프로젝트' }] } });
      return r.fulfill({ json: { items: [] } });
    });
    await pg.route('https://accounts.google.com/**', r => r.fulfill({ body: '', contentType: 'text/javascript' }));
    await pg.goto('http://localhost:4173/index.html');
    await pg.waitForTimeout(600);

    assert('만료 직후에는 인증 패널이 앱을 덮지 않는다',
      !(await pg.locator('#auth').evaluate(e => e.classList.contains('on'))));
    assert('대신 다시 연결 토스트를 띄운다', /연결이 만료/.test(await pg.locator('#toastMsg').innerText()));

    // 토스트를 무시하고 앱을 계속 쓰는 경우 — 배경 동기화가 인증 창을 또 띄우면 안 된다
    await pg.evaluate(() => { fullSync(); document.dispatchEvent(new Event('visibilitychange')); });
    await pg.waitForTimeout(500);
    assert('배경 동기화는 인증 패널로 앱을 덮지 않는다',
      !(await pg.locator('#auth').evaluate(e => e.classList.contains('on'))));
    assert('무음 실패 직후에는 재시도를 쿨다운한다',
      (await pg.evaluate(() => window.__auth.filter(a => a === 'silent').length)) === 1,
      JSON.stringify(await pg.evaluate(() => window.__auth)));

    // 사용자가 다시 연결을 누르고, 그 사이 배경 동기화가 두 번 끼어든다
    await pg.locator('#toastAct').click();
    await pg.waitForTimeout(120);
    await pg.evaluate(() => { fullSync(); document.dispatchEvent(new Event('visibilitychange')); });
    await pg.waitForTimeout(1200);

    const calls = await pg.evaluate(() => window.__auth);
    const shown = calls.filter(c => c !== 'silent');
    assert('사용자에게 보이는 인증 창은 정확히 한 번', shown.length === 1, JSON.stringify(calls));
    assert("이미 승인한 사용자에게 prompt:'consent' 를 강제하지 않는다",
      !calls.includes('consent'), JSON.stringify(calls));
    assert('재연결 후 인증 패널은 닫혀 있다',
      !(await pg.locator('#auth').evaluate(e => e.classList.contains('on'))));
    assert('새 토큰이 저장된다',
      (await pg.evaluate(() => (JSON.parse(localStorage.getItem('saydo.token') || 'null') || {}).t)) === 'fresh');
    await ctx.close();
  }

  /* ── 정렬 ──────────────────────────────────────────────────────────────
     기준 하나가 모든 뷰에 적용되는지, 날짜 그룹이 살아남는지, 순서 드래그가
     등록일순에서만 열리는지를 본다.

     여기서는 "정렬이 켜졌는가" 가 아니라 **정확한 순서**를 못박는다. 처음에 썼던
     "맨 위가 P1인가" 류의 느슨한 단언은 정렬을 통째로 꺼도 그대로 통과했다 —
     기본 순서가 우연히 조건을 만족했기 때문이다. 세 기준이 서로 다른 순서를 내는
     자료로 잡고, 세 순서를 전부 적어 둔다.

     앞선 테스트들이 태스크를 추가해 놓았으므로 오염되지 않은 새 페이지에서 돌린다. */
  console.log('\n[정렬]');
  {
    const sp = await makePage({ viewport: { width: 1320, height: 900 } });
    await sp.goto('http://localhost:4173/index.html');
    await sp.locator('#authBtn').click();
    await sp.waitForTimeout(900);

    const short = t => t.replace(/\s.*$/, '');                 // 첫 단어로 줄여 비교를 읽기 쉽게
    const titles = async sel => (await sp.locator(sel).allTextContents()).map(short);
    const groups = () => sp.locator('#wrap .sec-h .t').allTextContents();
    const pick = async k => {
      await sp.locator('#sortBtn').click();
      await sp.locator(`#sortMenu [data-sort="${k}"]`).click();
      await sp.waitForTimeout(250);
    };
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    await sp.locator('#sortBtn').click();
    await sp.waitForTimeout(150);
    assert('정렬 메뉴에 기준 3개', (await sp.locator('#sortMenu [data-sort]').count()) === 3);
    assert('완료 표시 토글도 같은 메뉴에', (await sp.locator('#sortMenu [data-done]').count()) === 1);
    assert('기본값은 등록일순', await sp.locator('#sortMenu [data-sort="manual"]').evaluate(e => e.classList.contains('on')));
    await sp.locator('#wrap').click({ position: { x: 5, y: 5 } });
    await sp.waitForTimeout(150);

    /* ① 목록 뷰 — 세 기준이 각각 다른 순서를 낸다.
       L1 자료: 분기(p1,오늘 09:30) 주간(p3,오늘 09:00) 고객(p2,-2일) 채용(p2,+5일) 보안(무등급,+1일) */
    await sp.locator('[data-view="list:L1"]').click();
    await sp.waitForTimeout(250);
    const ROW = '#wrap .task .t-title';
    const mOrder = await titles(ROW);
    assert('등록일순 = 목록에 들어 있는 차례 그대로',
      eq(mOrder, ['분기', '주간', '고객', '채용', '보안']), JSON.stringify(mOrder));

    await pick('due');
    const dOrder = await titles(ROW);
    assert('마감일순 = 지난 것부터, 같은 날은 시각순',
      eq(dOrder, ['고객', '주간', '분기', '보안', '채용']), JSON.stringify(dOrder));

    await pick('priority');
    const pOrder = await titles(ROW);
    assert('중요도순 = P1부터, 같은 등급은 마감일순',
      eq(pOrder, ['분기', '고객', '채용', '주간', '보안']), JSON.stringify(pOrder));

    assert('세 기준이 서로 다른 순서를 낸다 (자료가 판별력을 갖는지 확인)',
      !eq(mOrder, dOrder) && !eq(dOrder, pOrder) && !eq(mOrder, pOrder));

    /* ② 오늘 뷰 — 지연됨/오늘 구획은 유지하고 구획 안에서만 재정렬한다 */
    await sp.locator('[data-view="today"]').click();
    await sp.waitForTimeout(250);
    const TODAY_ROWS = '#wrap .sec:last-child .task .t-title';
    await pick('manual');
    const gm = await groups(), tm = await titles(TODAY_ROWS);
    await pick('priority');
    const gp = await groups(), tp = await titles(TODAY_ROWS);
    await pick('due');
    const gd = await groups(), td = await titles(TODAY_ROWS);

    assert('날짜 구획은 어떤 기준에서도 그대로다',
      eq(gm, gp) && eq(gp, gd) && gm.includes('지연됨') && gm.includes('오늘'), JSON.stringify(gm));
    assert('오늘 구획 · 등록일순은 목록 차례 → 목록 안 순서',
      eq(tm, ['분기', '주간', '배포']), JSON.stringify(tm));
    assert('오늘 구획 · 중요도순은 P1 두 건이 먼저(같은 등급은 시각순)',
      eq(tp, ['분기', '배포', '주간']), JSON.stringify(tp));
    assert('오늘 구획 · 마감일순은 같은 날이라 시각순',
      eq(td, ['주간', '분기', '배포']), JSON.stringify(td));

    /* ③ 기한 없는 항목은 마감일순에서 언제나 맨 뒤 */
    await sp.locator('[data-view="list:L3"]').click();
    await sp.waitForTimeout(250);
    const l3 = await titles(ROW);
    assert('기한 없는 항목은 마감일순에서 맨 뒤', l3[l3.length - 1] === '주말', JSON.stringify(l3));

    /* ④ 저장·드래그 개폐 */
    assert('선택한 기준을 저장한다', (await sp.evaluate(() => localStorage.getItem('saydo.sortBy'))) === 'due');
    assert('마감일순 목록 뷰에서는 순서 드래그가 꺼진다',
      !(await sp.locator('#wrap').evaluate(e => e.classList.contains('dnd-on'))));
    await pick('manual');
    assert('등록일순으로 돌리면 순서 드래그가 다시 켜진다',
      await sp.locator('#wrap').evaluate(e => e.classList.contains('dnd-on')));
    assert('기본값으로 돌아오면 버튼 표시가 사라진다',
      !(await sp.locator('#sortBtn').evaluate(e => e.classList.contains('tuned'))));

    /* ⑤ 보드 — 컬럼 안에서 정렬되고, 정렬 중에도 컬럼 간 드래그는 살아 있다 */
    await sp.locator('[data-view="board"]').click();
    await sp.waitForTimeout(300);
    const COL1 = '.col:first-child .card .card-t';
    const bm = await titles(COL1);
    await pick('due');
    const bd = await titles(COL1);
    assert('보드 컬럼 안에도 정렬이 적용된다 (등록일순과 다른 순서가 나온다)',
      bd.length >= 3 && !eq(bm, bd), JSON.stringify(bm) + ' → ' + JSON.stringify(bd));
    assert('보드 첫 컬럼 · 마감일순 순서', eq(bd, ['고객', '주간', '분기', '보안', '채용']), JSON.stringify(bd));
    assert('보드에서는 정렬 중에도 드래그가 살아 있다 (컬럼 이동은 속성 변경이므로)',
      await sp.locator('#wrap').evaluate(e => e.classList.contains('dnd-on')));
    await sp.screenshot({ path: 'shot-23-sort-board.png' });

    /* ⑥ 새로고침 후에도 유지 */
    await sp.reload();
    await sp.waitForTimeout(800);
    assert('새로고침 후에도 기준이 유지된다', (await sp.evaluate(() => S.sortBy)) === 'due');
  }

  /* ── 동기화 예산 ───────────────────────────────────────────────────────────
     Tasks API 는 **프로젝트당** 하루 5만 쿼리다. 즉 동기화 호출 건수가 그대로
     "몇 명까지 이 앱을 쓸 수 있는가" 가 된다. 기능 테스트가 아니라 **용량 테스트**다.

     그래서 여기서는 동작이 아니라 **호출 건수를 센다.** 누군가 나중에 편의를 위해
     동기화를 자주 돌리면 수용 인원이 조용히 1/6 로 줄어드는데, 화면으로는 전혀 드러나지
     않는다. 이 테스트가 그 변경을 잡는다. */
  console.log('\n[동기화 예산]');
  {
    const ctx = await browser.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
    const pg = await ctx.newPage();
    let calls = 0, listCalls = 0;
    await pg.addInitScript(() => {
      window.google = { accounts: { oauth2: { initTokenClient: cfg => ({
        callback: cfg.callback,
        requestAccessToken() { setTimeout(() => this.callback({ access_token: 'fake', expires_in: 3600 }), 10); }
      }) } } };
      try { localStorage.setItem('saydo.clientId', 'test.apps.googleusercontent.com'); } catch (e) {}
    });
    await pg.route('https://tasks.googleapis.com/**', r => {
      const u = new URL(r.request().url());
      calls++;
      if (u.pathname.endsWith('/users/@me/lists')) { listCalls++; return r.fulfill({ json: { items: LISTS } }); }
      const m = u.pathname.match(/\/lists\/([^/]+)\/tasks$/);
      if (m) return r.fulfill({ json: { items: TASKS[m[1]] || [] } });
      return r.fulfill({ status: 204, body: '' });
    });
    await pg.route('https://accounts.google.com/**', r => r.fulfill({ body: '', contentType: 'text/javascript' }));
    await pg.route('https://www.googleapis.com/oauth2/v3/userinfo', r => r.fulfill({ json: { email: 'test@example.com' } }));
    await pg.goto('http://localhost:4173/index.html');
    await pg.locator('#authBtn').click();
    await pg.waitForTimeout(900);

    /* 부팅은 완료분도 한 번 읽는다(캐시가 없으므로) — 목록당 2콜.
       이후 주기 동기화는 DONE_TTL 덕에 목록당 1콜로 떨어진다. */
    const boot = calls;
    assert(`부팅 1회 = 목록 1 + 목록당 2 (미완료+완료) (${boot}콜)`, boot === 1 + LISTS.length * 2, String(boot));

    // 탭을 열 번 오갔다 — 예전에는 그때마다 전량 조회였다
    for (let i = 0; i < 10; i++) {
      await pg.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await pg.waitForTimeout(60);
    }
    await pg.waitForTimeout(400);
    assert('탭을 열 번 오가도 추가 호출이 없다 (SYNC_MIN_GAP)', calls === boot, `${calls - boot}콜 추가됨`);

    // 간격이 지난 뒤의 첫 동기화 — 목록은 TTL 안이므로 다시 읽지 않는다
    await pg.evaluate(() => { S.lastSync = Date.now() - 31 * 60 * 1000; });
    const beforeListCalls = listCalls;
    await pg.evaluate(() => fullSync());
    await pg.waitForTimeout(600);
    const perSyncMeasured = calls - boot;              // ← 실측값. 아래 환산은 이것으로 한다
    assert(`주기 동기화는 목록·완료분을 건너뛰고 미완료만 (${perSyncMeasured}콜)`,
      perSyncMeasured === LISTS.length, String(perSyncMeasured));
    assert('목록은 TTL 안이면 다시 읽지 않는다', listCalls === beforeListCalls);

    // 사용자가 직접 새로고침하면 목록도 완료분도 다시 읽는다
    const beforeForce = calls;
    await pg.evaluate(() => fullSync(true));
    await pg.waitForTimeout(600);
    assert('강제 동기화는 목록·완료분까지 다시 읽는다',
      calls - beforeForce === 1 + LISTS.length * 2, String(calls - beforeForce));

    /* 하루치 환산 — 이 수치가 곧 수용 인원이다.
       **상수가 아니라 위에서 실제로 센 호출 수로 계산한다.** 상수로 계산하면 동기화를
       아무리 헤프게 바꿔도 이 단언이 통과해 버린다(실제로 그렇게 썼다가 고쳤다). */
    const perDay = boot + perSyncMeasured * 16;         // 부팅 1회 + 8시간/30분 = 16회
    const seats = Math.floor(50000 / perDay);
    console.log(`    하루 8시간 사용 환산: ${perDay}콜/일 → 5만 쿼터로 약 ${seats.toLocaleString()}명`);
    assert(`수용 인원이 500명 이상이다 (현재 약 ${seats.toLocaleString()}명)`, seats >= 500, String(seats));
    await ctx.close();
  }

  /* ── 완료 항목 90일 제한 (A-2) ─────────────────────────────────────────────
     몇 년 쓰면 미완료 20건을 보려고 완료 수천 건을 매번 내려받는다. 여기서 검증하는 것은
     **두 호출의 분리**다 — 미완료 조회에 completedMin 이 섞이면 완료일 없는 태스크가
     전부 탈락해 "할 일이 하나도 없다" 는 화면이 나온다. 그래서 파라미터까지 본다. */
  console.log('\n[완료 항목 90일 제한]');
  {
    const ctx = await browser.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
    const pg = await ctx.newPage();
    const ago = n => { const d = new Date(seoulNow()); d.setDate(d.getDate() - n); return d.toISOString(); };
    const FRESH = { id: 'd1', title: '지난주 완료한 감사 보고', notes: '⟦p3⟧', status: 'completed', completed: ago(10), position: '010' };
    const STALE = { id: 'd2', title: '작년에 완료한 예산안', notes: '⟦p3⟧', status: 'completed', completed: ago(200), position: '011' };
    const OPEN = [
      { id: 'o1', title: '살아 있는 일 하나', notes: '⟦p1⟧', status: 'needsAction', position: '001' },
      { id: 'o2', title: '살아 있는 일 둘', notes: '⟦p2⟧', status: 'needsAction', position: '002' }
    ];
    const openQ = [], doneQ = [];
    await pg.addInitScript(() => {
      window.google = { accounts: { oauth2: { initTokenClient: cfg => ({
        callback: cfg.callback,
        requestAccessToken() { setTimeout(() => this.callback({ access_token: 'fake', expires_in: 3600 }), 10); }
      }) } } };
      try { localStorage.setItem('saydo.clientId', 'test.apps.googleusercontent.com'); } catch (e) {}
    });
    /* 스텁이 **진짜 API 처럼** 군다 — completedMin 을 실제로 적용한다. 스텁이 무조건 전부
       돌려주면 필터가 빠져 있어도 테스트가 통과해 버린다(정렬 테스트에서 겪은 그 함정). */
    await pg.route('https://tasks.googleapis.com/**', r => {
      const u = new URL(r.request().url());
      if (u.pathname.endsWith('/users/@me/lists')) return r.fulfill({ json: { items: [{ id: 'L1', title: '프로젝트' }] } });
      if (/\/lists\/L1\/tasks$/.test(u.pathname) && r.request().method() === 'GET') {
        const wantDone = u.searchParams.get('showCompleted') === 'true';
        const cm = u.searchParams.get('completedMin') || '';
        (wantDone ? doneQ : openQ).push({ showCompleted: u.searchParams.get('showCompleted'), completedMin: cm });
        /* 진짜 API 의 못된 성질을 그대로 흉내낸다 — completedMin 이 붙으면 완료일이 없는
           태스크(=미완료 전부)가 비교에서 탈락한다. 스텁이 이걸 봐주면, 파라미터를 잘못
           붙였을 때 "할 일이 하나도 없다" 는 실제 증상이 테스트에 나타나지 않는다. */
        if (!wantDone) return r.fulfill({ json: { items: cm ? [] : OPEN } });
        const items = [FRESH, STALE].filter(t => !cm || t.completed >= cm);
        return r.fulfill({ json: { items } });
      }
      return r.fulfill({ status: 204, body: '' });
    });
    await pg.route('https://accounts.google.com/**', r => r.fulfill({ body: '', contentType: 'text/javascript' }));
    await pg.route('https://www.googleapis.com/oauth2/v3/userinfo', r => r.fulfill({ json: { email: 'test@example.com' } }));
    await pg.goto('http://localhost:4173/index.html');
    await pg.locator('#authBtn').click();
    await pg.waitForTimeout(900);

    assert('미완료 조회는 showCompleted=false 로 나간다',
      openQ.length > 0 && openQ.every(q => q.showCompleted === 'false'), JSON.stringify(openQ));
    assert('미완료 조회에는 completedMin 을 절대 붙이지 않는다',
      openQ.every(q => !q.completedMin), JSON.stringify(openQ));
    assert('완료 조회는 completedMin 을 붙인다', doneQ.length === 1 && !!doneQ[0].completedMin, JSON.stringify(doneQ));
    const days = doneQ.length && doneQ[0].completedMin
      ? Math.round((Date.now() - Date.parse(doneQ[0].completedMin)) / 86400000) : -1;
    assert(`completedMin 이 90일 전이다 (측정 ${days}일)`, days === 90, String(days));

    assert('미완료는 그대로 보인다', (await pg.evaluate(() => S.tasks.L1.filter(t => t.status !== 'completed').length)) === 2);
    assert('90일 안의 완료 항목은 남는다', await pg.evaluate(() => S.tasks.L1.some(t => t.id === 'd1')));
    assert('90일 밖의 완료 항목은 받아오지 않는다', await pg.evaluate(() => !S.tasks.L1.some(t => t.id === 'd2')));

    await pg.locator('[data-view="done"]').click();
    await pg.waitForTimeout(300);
    assert('완료됨 뷰에 최근 완료 항목이 보인다',
      (await pg.locator('.task').allInnerTexts()).join(' ').includes('지난주 완료한 감사 보고'));
    assert('완료됨 뷰에 오래된 완료 항목은 없다',
      !(await pg.locator('.task').allInnerTexts()).join(' ').includes('작년에 완료한 예산안'));

    /* TTL — 주기 동기화가 완료분을 다시 읽지 않되, **읽지 않는다고 잃지도 않아야** 한다.
       캐시를 그냥 버리면 30분마다 완료됨 뷰가 비었다 채워졌다 한다. */
    const doneBefore = doneQ.length;
    await pg.evaluate(() => { S.lastSync = Date.now() - 31 * 60 * 1000; return fullSync(); });
    await pg.waitForTimeout(700);
    assert('DONE_TTL 안에서는 완료 조회를 다시 하지 않는다', doneQ.length === doneBefore, `${doneQ.length - doneBefore}회 추가`);
    assert('그래도 캐시된 완료 항목은 남아 있다', await pg.evaluate(() => S.tasks.L1.some(t => t.id === 'd1')));

    await pg.evaluate(() => fullSync(true));
    await pg.waitForTimeout(700);
    assert('강제 동기화는 완료 조회를 다시 한다', doneQ.length === doneBefore + 1, String(doneQ.length - doneBefore));
    await ctx.close();
  }

  /* ── 상한 도달을 조용히 넘기지 않는다 (A-2) ─────────────────────────────────
     예전 코드는 `out.length < 1000` 으로 루프를 빠져나갔다. 잘린 화면과 온전한 화면이
     **구분되지 않았다.** D절의 "실패를 그럴듯한 기본값으로 대체" 패턴 그 자체다. */
  console.log('\n[상한 도달 표시]');
  {
    const ctx = await browser.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
    const pg = await ctx.newPage();
    let pages = 0;
    await pg.addInitScript(() => {
      window.google = { accounts: { oauth2: { initTokenClient: cfg => ({
        callback: cfg.callback,
        requestAccessToken() { setTimeout(() => this.callback({ access_token: 'fake', expires_in: 3600 }), 10); }
      }) } } };
      try { localStorage.setItem('saydo.clientId', 'test.apps.googleusercontent.com'); } catch (e) {}
    });
    // 끝나지 않는 목록 — 페이지마다 100건에 nextPageToken 이 계속 따라온다
    await pg.route('https://tasks.googleapis.com/**', r => {
      const u = new URL(r.request().url());
      if (u.pathname.endsWith('/users/@me/lists')) return r.fulfill({ json: { items: [{ id: 'L1', title: '끝없는 목록' }] } });
      if (/\/lists\/L1\/tasks$/.test(u.pathname)) {
        if (u.searchParams.get('showCompleted') === 'true') return r.fulfill({ json: { items: [] } });
        const n = pages++;
        const items = Array.from({ length: 100 }, (_, i) => ({
          id: `x${n}_${i}`, title: `항목 ${n * 100 + i}`, notes: '', status: 'needsAction', position: String(n * 100 + i)
        }));
        return r.fulfill({ json: { items, nextPageToken: 'more' } });
      }
      return r.fulfill({ status: 204, body: '' });
    });
    await pg.route('https://accounts.google.com/**', r => r.fulfill({ body: '', contentType: 'text/javascript' }));
    await pg.route('https://www.googleapis.com/oauth2/v3/userinfo', r => r.fulfill({ json: { email: 'test@example.com' } }));
    await pg.goto('http://localhost:4173/index.html');
    await pg.locator('#authBtn').click();
    await pg.waitForFunction(() => window.S && S.booted && !S.syncing, null, { timeout: 15000 }).catch(() => {});
    await pg.waitForTimeout(500);

    assert('상한에서 멈춘다 (무한 루프가 아니다)', pages >= 10 && pages <= 12, `${pages}페이지`);
    assert('상한 도달을 상태에 기록한다', await pg.evaluate(() => !!(S.trunc && S.trunc.L1)));
    const banner = await pg.locator('.banner').count();
    assert('화면에 지속 배너로 알린다', banner === 1, `${banner}개`);
    const txt = banner ? await pg.locator('.banner').innerText() : '';
    assert('어느 목록이 잘렸는지 이름을 말해 준다', txt.includes('끝없는 목록'), txt);
    assert('무엇을 하면 되는지 말해 준다', /정리/.test(txt), txt);
    // "은(는)" 은 기계가 쓴 티가 난다 — 받침을 보고 고른다
    assert('조사를 제대로 붙인다', txt.includes('끝없는 목록은') && !txt.includes('(는)'), txt);
    await ctx.close();
  }

  /* ── 목록 하나가 실패해도 초록불이면 안 된다 ────────────────────────────────
     예전에는 목록별 실패를 `.catch(() => 캐시)` 로 삼키고 setSync('ok') 를 찍었다.
     목록 하나가 몇 시간째 낡아 있어도 화면은 정상이라고 말했다. */
  console.log('\n[목록 단위 실패]');
  {
    const ctx = await browser.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
    const pg = await ctx.newPage();
    let failL2 = false;
    await pg.addInitScript(() => {
      window.google = { accounts: { oauth2: { initTokenClient: cfg => ({
        callback: cfg.callback,
        requestAccessToken() { setTimeout(() => this.callback({ access_token: 'fake', expires_in: 3600 }), 10); }
      }) } } };
      try { localStorage.setItem('saydo.clientId', 'test.apps.googleusercontent.com'); } catch (e) {}
    });
    await pg.route('https://tasks.googleapis.com/**', r => {
      const u = new URL(r.request().url());
      if (u.pathname.endsWith('/users/@me/lists')) return r.fulfill({ json: { items: LISTS } });
      const m = u.pathname.match(/\/lists\/([^/]+)\/tasks$/);
      if (m) {
        if (failL2 && m[1] === 'L2') return r.fulfill({ status: 500, body: 'boom' });
        return r.fulfill({ json: { items: TASKS[m[1]] || [] } });
      }
      return r.fulfill({ status: 204, body: '' });
    });
    await pg.route('https://accounts.google.com/**', r => r.fulfill({ body: '', contentType: 'text/javascript' }));
    await pg.route('https://www.googleapis.com/oauth2/v3/userinfo', r => r.fulfill({ json: { email: 'test@example.com' } }));
    await pg.goto('http://localhost:4173/index.html');
    await pg.locator('#authBtn').click();
    await pg.waitForTimeout(900);
    const l2Before = await pg.evaluate(() => (S.tasks.L2 || []).length);
    const syncBefore = await pg.evaluate(() => S.lastSync);

    await pg.evaluate(() => { S.lastSync = Date.now() - 31 * 60 * 1000; });
    failL2 = true;
    await pg.evaluate(() => fullSync());
    await pg.waitForTimeout(900);

    assert('실패한 목록을 이름으로 기록한다',
      await pg.evaluate(() => S.failed.includes('프로젝트')), JSON.stringify(await pg.evaluate(() => S.failed)));
    assert('동기화 표시가 초록으로 남지 않는다',
      await pg.evaluate(() => $('syncDot').classList.contains('err')));
    assert('실패했으면 lastSync 를 찍지 않는다 — 재시도를 막으면 안 된다',
      (await pg.evaluate(() => S.lastSync)) < syncBefore);
    assert('실패한 목록의 이전 내용은 지우지 않는다',
      (await pg.evaluate(() => (S.tasks.L2 || []).length)) === l2Before);
    assert('성공한 목록은 정상 반영된다',
      (await pg.evaluate(() => (S.tasks.L1 || []).length)) === TASKS.L1.length);
    await ctx.close();
  }

  /* ── 연결 계정 표시 ────────────────────────────────────────────────────────
     구글 계정을 여러 개 쓰면 "동기화가 안 된다" 고 느끼는 상황이 실제로는 **다른 계정을
     보고 있는** 것이다. 앱이 말해 주지 않으면 사용자가 확인할 방법이 없다. */
  console.log('\n[연결 계정]');
  {
    const pg = await makePage({ viewport: { width: 1320, height: 900 } });
    await pg.route('https://www.googleapis.com/oauth2/v3/userinfo',
      r => r.fulfill({ json: { email: 'you@example.com' } }));
    await pg.goto('http://localhost:4173/index.html');
    await pg.locator('#authBtn').click();
    await pg.waitForTimeout(1000);

    assert('사이드바에 연결된 구글 계정을 보여 준다',
      (await pg.locator('#sbAcctEmail').innerText()) === 'you@example.com',
      await pg.locator('#sbAcct').innerText().catch(() => '(없음)'));
    assert('계정 표시가 실제로 화면에 보인다', await pg.locator('#sbAcct').isVisible());
    assert('계정을 기억해 다음 실행에서 바로 보여 준다',
      (await pg.evaluate(() => localStorage.getItem('saydo.account'))) === 'you@example.com');

    /* 전환은 이전 계정의 캐시를 반드시 비워야 한다 — 안 그러면 남의 할 일이 섞여 보인다.
       스텁이 토큰을 곧바로 돌려주면 다시 채워지므로(그게 정상 동작이다), 여기서는
       **응답하지 않는 클라이언트**로 바꿔 비워진 상태를 관찰한다. */
    await pg.evaluate(() => {
      window.__prompt = null;
      S.client = { requestAccessToken(o) { window.__prompt = (o && o.prompt) || ''; } };
    });
    await pg.locator('#sbAcctSwitch').click();
    await pg.waitForTimeout(300);
    assert("계정 선택 화면을 강제한다 (prompt: 'select_account')",
      (await pg.evaluate(() => window.__prompt)) === 'select_account',
      String(await pg.evaluate(() => window.__prompt)));
    assert('전환하면 이전 계정의 태스크 캐시를 비운다',
      await pg.evaluate(() => Object.keys(S.tasks).length === 0 && S.lists.length === 0));
    assert('전환하면 저장된 토큰도 버린다',
      await pg.evaluate(() => !JSON.parse(localStorage.getItem('saydo.token') || 'null')));
    assert('전환하면 계정 표시도 지운다', await pg.evaluate(() => !S.account));
    await pg.context().close();
  }

  /* ── 동기화 실패와 편집 보존 ───────────────────────────────────────────────
     예전 판은 실패한 연산을 **종류 구분 없이 큐에서 버렸다.** 낙관적 업데이트 때문에
     화면에는 그대로 남아 저장된 것처럼 보이고, 다음 fullSync 가 서버 데이터로 덮으면
     편집이 사라졌다. 토스트 문구가 "새로고침해 주세요" 였는데 그 새로고침이 지우는
     동작이었다. 실측했던 그 시나리오를 그대로 회귀 테스트로 박아 둔다. */
  console.log('\n[동기화 실패와 편집 보존]');
  {
    const ctx = await browser.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
    const pg = await ctx.newPage();
    pg.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
    let failPatch = true, patchTries = 0;
    const SERVER = { id: 't1', title: '원본 제목', notes: '', status: 'needsAction', position: '001' };
    await pg.addInitScript(() => {
      window.google = { accounts: { oauth2: { initTokenClient: cfg => ({
        callback: cfg.callback,
        requestAccessToken() { setTimeout(() => this.callback({ access_token: 'fake', expires_in: 3600 }), 10); }
      }) } } };
      try { localStorage.setItem('saydo.clientId', 'test.apps.googleusercontent.com'); } catch (e) {}
    });
    await pg.route('https://tasks.googleapis.com/**', r => {
      const u = new URL(r.request().url()), m = r.request().method();
      if (u.pathname.endsWith('/users/@me/lists')) return r.fulfill({ json: { items: [{ id: 'L1', title: '프로젝트' }] } });
      if (/\/lists\/L1\/tasks$/.test(u.pathname) && m === 'GET') return r.fulfill({ json: { items: [SERVER] } });
      if (m === 'PATCH') {
        patchTries++;
        if (failPatch) return r.abort('failed');        // 네트워크 장애 흉내 (status 없음)
        const b = JSON.parse(r.request().postData() || '{}');
        Object.assign(SERVER, b);
        return r.fulfill({ json: SERVER });
      }
      return r.fulfill({ status: 204, body: '' });
    });
    await pg.route('https://accounts.google.com/**', r => r.fulfill({ body: '', contentType: 'text/javascript' }));
    await pg.route('https://www.googleapis.com/oauth2/v3/userinfo', r => r.fulfill({ json: { email: 'test@example.com' } }));
    await pg.goto('http://localhost:4173/index.html');
    await pg.locator('#authBtn').click();
    await pg.waitForTimeout(900);

    await pg.evaluate(() => { const t = allTasks()[0]; patchTask(t, { title: '중요한 수정본' }); });
    await pg.waitForTimeout(900);

    assert('전송 실패한 연산을 큐에서 버리지 않는다',
      (await pg.evaluate(() => S.queue.length)) >= 1, `queue=${await pg.evaluate(() => S.queue.length)}`);
    assert('재시도 횟수를 센다', (await pg.evaluate(() => (S.queue[0] || {}).tries)) >= 1);

    /* 핵심 — 이 상태에서 동기화가 돌아도 편집이 살아남아야 한다 */
    await pg.evaluate(() => fullSync(true));
    await pg.waitForTimeout(900);
    assert('미전송 편집이 동기화로 덮이지 않는다',
      (await pg.evaluate(() => allTasks()[0].title)) === '중요한 수정본',
      await pg.evaluate(() => allTasks()[0].title));

    /* 연결이 돌아오면 스스로 다시 보내고 서버에 반영된다 */
    failPatch = false;
    await pg.evaluate(() => flush());
    const sent = await pg.waitForFunction(() => S.queue.length === 0, null, { timeout: 8000 })
      .then(() => true).catch(() => false);
    assert('연결이 돌아오면 큐를 스스로 비운다', sent, `queue=${await pg.evaluate(() => S.queue.length)}`);
    assert('서버에도 실제로 반영된다', SERVER.title === '중요한 수정본', SERVER.title);
    assert('한 번 이상 재시도했다 (첫 시도만 하고 포기하지 않는다)', patchTries >= 2, String(patchTries));
    await ctx.close();
  }

  {
    /* 재시도해도 소용없는 실패(4xx)는 버리되, 무엇을 버렸는지 말한다 */
    const ctx = await browser.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
    const pg = await ctx.newPage();
    await pg.addInitScript(() => {
      window.google = { accounts: { oauth2: { initTokenClient: cfg => ({
        callback: cfg.callback,
        requestAccessToken() { setTimeout(() => this.callback({ access_token: 'fake', expires_in: 3600 }), 10); }
      }) } } };
      try { localStorage.setItem('saydo.clientId', 'test.apps.googleusercontent.com'); } catch (e) {}
    });
    await pg.route('https://tasks.googleapis.com/**', r => {
      const u = new URL(r.request().url()), m = r.request().method();
      if (u.pathname.endsWith('/users/@me/lists')) return r.fulfill({ json: { items: [{ id: 'L1', title: '프로젝트' }] } });
      if (/\/lists\/L1\/tasks$/.test(u.pathname) && m === 'GET')
        return r.fulfill({ json: { items: [{ id: 't1', title: '원본 제목', notes: '', status: 'needsAction', position: '001' }] } });
      if (m === 'PATCH') return r.fulfill({ status: 400, body: '{"error":"bad"}' });
      return r.fulfill({ status: 204, body: '' });
    });
    await pg.route('https://accounts.google.com/**', r => r.fulfill({ body: '', contentType: 'text/javascript' }));
    await pg.route('https://www.googleapis.com/oauth2/v3/userinfo', r => r.fulfill({ json: { email: 'test@example.com' } }));
    await pg.goto('http://localhost:4173/index.html');
    await pg.locator('#authBtn').click();
    await pg.waitForTimeout(900);

    await pg.evaluate(() => { const t = allTasks()[0]; patchTask(t, { title: '거부될 수정' }); });
    await pg.waitForTimeout(1200);
    assert('4xx 는 재시도하지 않고 버린다', (await pg.evaluate(() => S.queue.length)) === 0);
    const msg = await pg.locator('#toastMsg').innerText();
    assert('무엇을 저장하지 못했는지 알려 준다 (조용히 버리지 않는다)',
      /저장하지 못했습니다/.test(msg) && /수정/.test(msg), msg);
    assert('예전의 해로운 안내("새로고침해 주세요")를 쓰지 않는다', !/새로고침/.test(msg), msg);
    await ctx.close();
  }

  /* ── 목록 관리 ─────────────────────────────────────────────────────────────
     목록 삭제는 **되돌릴 수 없다.** Google Tasks 는 목록을 지우면 안의 태스크까지
     지우고 휴지통이 없다. 그래서 여기서 검증하는 것은 "지워지는가" 보다
     **"실수로 지워지지 않는가"** 다. */
  console.log('\n[목록 관리]');
  {
    const pg = await makePage({ viewport: { width: 1320, height: 900 } });
    let deleted = [], renamed = [];
    await pg.route('https://tasks.googleapis.com/**', r => {
      const u = new URL(r.request().url()), m = r.request().method();
      if (u.pathname.endsWith('/users/@me/lists')) return r.fulfill({ json: { items: LISTS } });
      const ml = u.pathname.match(/\/users\/@me\/lists\/([^/]+)$/);
      if (ml && m === 'DELETE') { deleted.push(ml[1]); return r.fulfill({ status: 204, body: '' }); }
      if (ml && m === 'PATCH') { renamed.push(JSON.parse(r.request().postData() || '{}').title); return r.fulfill({ json: {} }); }
      const mt = u.pathname.match(/\/lists\/([^/]+)\/tasks$/);
      if (mt && m === 'GET') return r.fulfill({ json: { items: TASKS[mt[1]] || [] } });
      return r.fulfill({ status: 204, body: '' });
    });
    await pg.goto('http://localhost:4173/index.html');
    await pg.locator('#authBtn').click();
    await pg.waitForTimeout(900);

    assert('목록 행마다 관리 버튼이 있다', (await pg.locator('[data-listmenu]').count()) === LISTS.length);
    await pg.locator('[data-listmenu="L1"]').dispatchEvent('click');
    await pg.waitForTimeout(200);
    assert('메뉴에 이름 변경과 삭제가 있다',
      (await pg.locator('#listMenu [data-act="rename"]').count()) === 1 &&
      (await pg.locator('#listMenu [data-act="del"]').count()) === 1);
    assert('삭제 항목이 지워질 태스크 건수를 미리 보여 준다',
      /태스크 \d+건/.test(await pg.locator('#listMenu [data-act="del"]').innerText()),
      await pg.locator('#listMenu [data-act="del"]').innerText());

    /* ① 이름을 틀리게 입력하면 지우지 않는다 — 가장 중요한 방어선 */
    await pg.evaluate(() => { window.prompt = () => '엉뚱한 이름'; });
    await pg.locator('#listMenu [data-act="del"]').click();
    await pg.waitForTimeout(500);
    assert('확인 이름이 다르면 삭제하지 않는다', deleted.length === 0, JSON.stringify(deleted));
    assert('목록이 그대로 남아 있다', (await pg.evaluate(() => S.lists.length)) === LISTS.length);

    /* ② 취소(null)해도 지우지 않는다 */
    await pg.evaluate(() => { window.prompt = () => null; });
    await pg.locator('[data-listmenu="L1"]').dispatchEvent('click');
    await pg.waitForTimeout(150);
    await pg.locator('#listMenu [data-act="del"]').click();
    await pg.waitForTimeout(500);
    assert('취소하면 삭제하지 않는다', deleted.length === 0);

    /* ③ 이름을 정확히 입력하면 지운다 */
    await pg.evaluate(() => { window.prompt = () => '업무'; });
    await pg.locator('[data-listmenu="L1"]').dispatchEvent('click');
    await pg.waitForTimeout(150);
    await pg.locator('#listMenu [data-act="del"]').click();
    await pg.waitForTimeout(800);
    assert('이름을 정확히 입력하면 삭제한다', deleted.includes('L1'), JSON.stringify(deleted));
    assert('사이드바에서도 사라진다', (await pg.evaluate(() => S.lists.length)) === LISTS.length - 1);
    assert('지운 목록에 걸려 있던 미전송 연산도 정리한다',
      await pg.evaluate(() => !S.queue.some(o => o.listId === 'L1')));

    /* ④ 이름 변경은 확인을 묻지 않는다 (되돌릴 수 있으므로) */
    await pg.evaluate(() => { window.prompt = () => '프로젝트 (개편)'; });
    await pg.locator('[data-listmenu="L2"]').dispatchEvent('click');
    await pg.waitForTimeout(150);
    await pg.locator('#listMenu [data-act="rename"]').click();
    await pg.waitForTimeout(800);
    assert('이름 변경이 서버로 나간다', renamed.includes('프로젝트 (개편)'), JSON.stringify(renamed));
    assert('화면에도 새 이름이 보인다',
      (await pg.evaluate(() => S.lists.find(l => l.id === 'L2').title)) === '프로젝트 (개편)');

    /* ⑤ 마지막 하나는 지울 수 없다 — Tasks 는 목록 0개를 허용하지 않는다 */
    await pg.evaluate(() => { S.lists = [S.lists[0]]; render(); });
    await pg.waitForTimeout(200);
    await pg.locator('[data-listmenu]').first().dispatchEvent('click');
    await pg.waitForTimeout(150);
    assert('마지막 남은 목록은 삭제를 막는다',
      await pg.locator('#listMenu [data-act="del"]').isDisabled());
    await pg.context().close();
  }

  console.log('\n[콘솔 오류] ' + (errors.length ? '\n  ' + errors.join('\n  ') : '없음'));
  console.log(`\n실패 ${bad}건`);
  process.exitCode = (bad || errors.length) ? 1 : 0;
  await browser.close(); server.close();
})();
