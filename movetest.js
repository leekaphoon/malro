/* 보드 뷰 · 계층 · 목록 이동 · 드래그앤드롭 검증 */
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((rq, rs) => {
  const f = path.join(__dirname, rq.url === '/' ? 'index.html' : rq.url.split('?')[0]);
  fs.readFile(f, (e, d) => {
    if (e) { rs.writeHead(404); return rs.end(); }
    rs.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' }); rs.end(d);
  });
});

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/* 픽스처의 '오늘' 은 컨테이너의 UTC 가 아니라 **브라우저가 돌 시간대(Asia/Seoul)** 의
   날짜여야 한다. 두 날짜는 매일 15:00 UTC 부터 자정까지 하루 어긋나고, 그 사이에 돌리면
   shift(0) 이 '어제', shift(1) 이 '오늘' 이 되어 오늘 뷰 관련 단언이 통째로 무너진다.
   (실제로 겪었다 — 아침에 통과하던 정렬 테스트가 저녁에 3건 깨졌다.) */
const seoulNow = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
const sh = n => { const d = seoulNow(); d.setDate(d.getDate() + n); return ymd(d) + 'T00:00:00.000Z'; };
const LISTS = [{ id: 'L1', title: '업무' }, { id: 'L2', title: '프로젝트' }, { id: 'L3', title: '개인' }];
const mkTasks = () => ({
  L1: [
    { id: 'a1', title: '분기 예산안 검토', notes: '⟦p1 @긴급⟧', due: sh(0), status: 'needsAction', position: '001' },
    { id: 'a2', title: '이슈 트리아지', notes: '⟦p2⟧', due: sh(0), status: 'needsAction', position: '002' },
    { id: 'a3', title: '릴리즈 노트 작성', notes: '⟦p3⟧', due: sh(1), status: 'needsAction', position: '003' },
    { id: 'a4', title: '보안 점검 대응 자료', notes: '', due: sh(4), status: 'needsAction', position: '004' }
  ],
  L2: [
    { id: 'b1', title: '배포 파이프라인 2차 점검', notes: '⟦p1 @검증⟧', due: sh(0), status: 'needsAction', position: '001' },
    { id: 'b2', title: '조직개편 TO-BE 초안', notes: '⟦p2⟧', due: sh(3), status: 'needsAction', position: '002' }
  ],
  L3: [
    { id: 'c1', title: '치과 예약', notes: '⟦p3⟧', due: sh(2), status: 'needsAction', position: '001' }
  ]
});

(async () => {
  await new Promise(r => server.listen(4175, r));
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
  let bad = 0; const errs = [];
  const A = (n, c, extra) => { console.log(`  ${c ? '✓' : '✗'} ${n}${c ? '' : (extra ? '  → ' + extra : '')}`); if (!c) bad++; };

  const calls = [];                       // 서버로 나간 요청 기록
  async function boot(opts) {
    const TASKS = mkTasks();
    const ctx = await browser.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul', ...opts });
    const page = await ctx.newPage();
    page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });
    await page.addInitScript(() => {
      window.google = { accounts: { oauth2: { initTokenClient: cfg => ({
        callback: cfg.callback,
        requestAccessToken() { setTimeout(() => this.callback({ access_token: 'fake', expires_in: 3600 }), 10); }
      }) } } };
      try { localStorage.setItem('saydo.clientId', 'test.apps.googleusercontent.com'); } catch (e) {}
    });
    await page.route('https://tasks.googleapis.com/**', route => {
      const u = new URL(route.request().url()), method = route.request().method();
      calls.push({ method, path: u.pathname, q: Object.fromEntries(u.searchParams) });
      if (u.pathname.endsWith('/users/@me/lists')) return route.fulfill({ json: { items: LISTS } });
      const lm = u.pathname.match(/\/lists\/([^/]+)\/tasks$/);
      if (lm && method === 'GET') return route.fulfill({ json: { items: TASKS[lm[1]] || [] } });
      const mv = u.pathname.match(/\/lists\/([^/]+)\/tasks\/([^/]+)\/move$/);
      if (mv) {
        const [, list, tid] = mv;
        const src = TASKS[list] || [];
        const i = src.findIndex(t => t.id === tid);
        const t = i >= 0 ? src[i] : { id: tid, title: '?', status: 'needsAction' };
        if (i >= 0) src.splice(i, 1);
        const parent = u.searchParams.get('parent');
        const dest = u.searchParams.get('destinationTasklist') || list;
        const out = { ...t, parent: parent || undefined, position: '9' + calls.length };
        if (!parent) delete out.parent;
        (TASKS[dest] = TASKS[dest] || []).push(out);
        return route.fulfill({ json: out });
      }
      if (method === 'POST') {
        const b = JSON.parse(route.request().postData() || '{}');
        return route.fulfill({ json: { ...b, id: 'n' + calls.length, position: '900' } });
      }
      if (method === 'PATCH' || method === 'PUT') {
        // 실제 Google API 는 갱신된 Task 리소스 전체를 돌려준다. 모의 서버도 그렇게 동작해야
        // 부분 응답으로 로컬 필드가 유실되는 가짜 실패가 생기지 않는다.
        const b = JSON.parse(route.request().postData() || '{}');
        const id = u.pathname.split('/').pop();
        let found = null, host = null;
        for (const k of Object.keys(TASKS)) {
          const t = TASKS[k].find(x => x.id === id);
          if (t) { found = t; host = k; break; }
        }
        if (!found) return route.fulfill({ json: { id, ...b } });
        const merged = method === 'PUT' ? { ...b, id } : { ...found, ...b };
        if (merged.due === null) delete merged.due;
        TASKS[host][TASKS[host].findIndex(x => x.id === id)] = merged;
        return route.fulfill({ json: merged });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    await page.route('https://accounts.google.com/**', r => r.fulfill({ body: '', contentType: 'text/javascript' }));
    await page.goto('http://localhost:4175/index.html');
    await page.waitForTimeout(300);
    await page.locator('#authBtn').click();
    await page.waitForTimeout(800);
    return page;
  }

  const lastMove = () => [...calls].reverse().find(c => /\/move$/.test(c.path));
  /* 모바일에서는 사이드바가 화면 밖이므로 햄버거를 먼저 연다 */
  async function goView(page, sel) {
    const vw = page.viewportSize().width;
    if (vw <= 860) { await page.locator('#menuBtn').click(); await page.waitForTimeout(400); }
    await page.locator(sel).first().click();
    await page.waitForTimeout(450);
  }

  /* 마우스 드래그 (포인터 이벤트 경유) */
  async function dragMouse(page, fromSel, to, steps = 14, hold = 80) {
    const box = await page.locator(fromSel).first().boundingBox();
    const sx = box.x + Math.min(60, box.width / 2), sy = box.y + box.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(sx + (to.x - sx) * i / steps, sy + (to.y - sy) * i / steps);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(hold);        // 도착 지점에서의 체류 (보드 중첩은 200ms 이상 필요)
    await page.mouse.up();
    await page.waitForTimeout(450);
  }

  /* ── 1. 보드 뷰 ── */
  let page = await boot({ viewport: { width: 1400, height: 940 } });
  console.log('\n[보드 뷰]');
  await goView(page, '[data-view="board"]');
  A('목록별 컬럼 3개', (await page.locator('.col').count()) === 3);
  A('카드 렌더', (await page.locator('.card').count()) === 7, String(await page.locator('.card').count()));
  A('우선순위 스트라이프 적용', (await page.locator('.card.p1').count()) === 2);
  await page.screenshot({ path: 'shot-11-board.png' });

  await page.locator('#boardBy').click(); await page.waitForTimeout(400);
  A('우선순위별 컬럼 4개', (await page.locator('.col').count()) === 4);
  await page.screenshot({ path: 'shot-12-board-priority.png' });
  await page.locator('#boardBy').click(); await page.waitForTimeout(400);
  A('기한별 컬럼 6개', (await page.locator('.col').count()) === 6);
  await page.locator('#boardBy').click(); await page.waitForTimeout(400);
  A('한 바퀴 돌면 목록별로 복귀', (await page.locator('.col').count()) === 3);

  /* ── 1.5 고스트가 실제로 커서를 따라오는가 (rowIn 애니메이션이 transform 을 덮던 회귀) ── */
  console.log('\n[드래그 고스트 추적]');
  const track = await page.evaluate(async () => {
    const send = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, {
      pointerId: 21, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true,
      clientX: x, clientY: y, button: 0
    }));
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const card = document.querySelector('.col .card');
    const b = card.getBoundingClientRect();
    const grabX = b.x + 50, grabY = b.y + 18;
    send(card, 'pointerdown', grabX, grabY);
    send(window, 'pointermove', grabX + 10, grabY + 10);
    await sleep(60);
    const g = document.getElementById('dragGhost');
    if (!g) return { noGhost: true };
    const samples = [];
    for (const [dx, dy] of [[120, 60], [300, 200], [520, 90]]) {
      send(window, 'pointermove', grabX + dx, grabY + dy);
      await sleep(60);
      const r = g.getBoundingClientRect();
      samples.push({
        px: grabX + dx, py: grabY + dy,
        gx: Math.round(r.left), gy: Math.round(r.top),
        stuck: Math.round(r.left) === 0 && Math.round(r.top) === 0
      });
    }
    // 추적만 확인하는 테스트이므로 커밋하지 않고 취소한다 (뒤 단계의 상태를 건드리면 안 됨)
    send(window, 'pointercancel', grabX, grabY);
    await sleep(250);
    return { samples, cancelled: !document.getElementById('dragGhost') };
  });
  if (track.noGhost) { A('드래그 고스트 생성', false); }
  else {
    A('고스트가 좌상단(0,0)에 박히지 않음', track.samples.every(s => !s.stuck),
      JSON.stringify(track.samples));
    // 처음 누른 지점(50,18)이 그대로 손끝에 유지돼야 한다 — 회전 AABB 오차 8px 허용
    A('잡은 지점이 손끝에 유지됨',
      track.samples.every(s => Math.abs((s.px - s.gx) - 50) <= 8 && Math.abs((s.py - s.gy) - 18) <= 8),
      JSON.stringify(track.samples));
    A('세 지점 모두 서로 다른 좌표', new Set(track.samples.map(s => s.gx + ',' + s.gy)).size === 3);
    A('취소 시 고스트 정리', track.cancelled === true);
  }

  /* ── 2. 보드 카드를 다른 목록 컬럼으로 드래그 ── */
  console.log('\n[드래그: 목록 간 이동]');
  const col2 = await page.locator('.col').nth(1).boundingBox();
  const before = calls.length;
  // 카드가 없는 아래쪽 빈 영역에 놓아야 "목록 이동"이다 (카드 위에 머무르면 중첩)
  await dragMouse(page, '.col >> nth=0 >> .card >> nth=0', { x: col2.x + col2.width / 2, y: col2.y + col2.height - 24 });
  const mv = lastMove();
  A('move 호출 발생', !!mv && calls.length > before);
  A('destinationTasklist=L2 로 이동', !!mv && mv.q.destinationTasklist === 'L2', mv && JSON.stringify(mv.q));
  A('프로젝트 컬럼 카드 3장', (await page.locator('.col').nth(1).locator('.card').count()) === 3);
  await page.screenshot({ path: 'shot-13-board-after-move.png' });

  /* ── 3. 우선순위 컬럼으로 드래그 → 우선순위 변경 ── */
  console.log('\n[드래그: 우선순위 변경]');
  await page.locator('#boardBy').click(); await page.waitForTimeout(450);   // priority
  const p1col = await page.locator('.col').nth(0).boundingBox();
  const p3card = page.locator('.col').nth(2).locator('.card').first();
  const p3title = await p3card.locator('.card-t').innerText();
  await dragMouse(page, '.col >> nth=2 >> .card >> nth=0', { x: p1col.x + p1col.width / 2, y: p1col.y + 120 });
  const inP1 = await page.locator('.col').nth(0).locator('.card-t').allInnerTexts();
  A('P3 카드를 P1 컬럼으로 옮기면 우선순위가 바뀐다', inP1.includes(p3title), inP1.join(' | '));

  /* ── 3.5 보드에서 카드 위에 카드를 떨어뜨려 서브태스크로 ── */
  console.log('\n[보드: 카드 위에 놓아 서브태스크로]');
  await page.locator('#boardBy').click(); await page.waitForTimeout(400);   // due
  await page.locator('#boardBy').click(); await page.waitForTimeout(450);   // list 로 복귀
  const c0 = await page.locator('.col').nth(0).locator('.card').nth(0).boundingBox();
  const beforeCards = await page.locator('.col').nth(0).locator('.card').count();
  const targetTitle = await page.locator('.col').nth(0).locator('.card').nth(0).locator('.card-t').innerText();
  // 두 번째 카드를 첫 번째 카드 몸통 한가운데로
  await dragMouse(page, '.col >> nth=0 >> .card >> nth=1', { x: c0.x + c0.width / 2, y: c0.y + c0.height / 2 }, 14, 420);
  const mvN = lastMove();
  A('중첩 move 에 parent 포함', !!mvN && !!mvN.q.parent, mvN && JSON.stringify(mvN.q));
  A('카드가 보드에서 사라짐(서브태스크는 카드로 안 올라옴)',
    (await page.locator('.col').nth(0).locator('.card').count()) === beforeCards - 1);
  const badge = await page.locator('.col').nth(0).locator('.card').nth(0).innerText();
  A('부모 카드에 진척 배지 표시', /0\/1|1\/1/.test(badge), badge.replace(/\n/g, ' '));
  A('서브태스크가 카드 안에 보임', (await page.locator('.col .card .sub-row').count()) === 1);
  A('진척 바 렌더', (await page.locator('.sub-head .bar i').count()) === 1);
  await page.screenshot({ path: 'shot-16-board-nested.png' });

  /* ── 3.6 중첩 강조가 드래그 중 보이는지 ── */
  const nestUi = await page.evaluate(async () => {
    const send = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, {
      pointerId: 7, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0
    }));
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const cards = document.querySelectorAll('.col .card');
    if (cards.length < 2) return { skipped: true };
    const src = cards[1], tgt = cards[0];
    const sb = src.getBoundingClientRect(), tb = tgt.getBoundingClientRect();
    send(src, 'pointerdown', sb.x + 40, sb.y + 20);
    for (let i = 1; i <= 6; i++) {
      send(window, 'pointermove', sb.x + 40 + i * 4, sb.y + 20 + (tb.y + tb.height / 2 - sb.y - 20) * i / 6);
      await sleep(20);
    }
    await sleep(280);                       // 체류 조건(200ms) 충족
    const on = tgt.classList.contains('nest-on');
    const colHi = !!document.querySelector('.col.drop-on');
    send(window, 'pointerup', tb.x + 40, tb.y + tb.height / 2);
    await sleep(300);
    return { on, colHi };
  });
  A('중첩 대상 카드 강조', nestUi.skipped || nestUi.on === true);
  A('중첩 중에는 컬럼 강조 억제', nestUi.skipped || nestUi.colHi === false);

  /* ── 3.65 카드 안 서브태스크: 접기 / 완료 토글 / 밖으로 끌어 승격 ── */
  console.log('\n[보드: 카드 안 서브태스크]');
  await page.locator('.sub-head').first().click(); await page.waitForTimeout(300);
  A('접기 동작', await page.locator('.card-subs').first().evaluate(e => e.classList.contains('hide')));
  await page.locator('.sub-head').first().click(); await page.waitForTimeout(300);
  A('다시 펼치기', !(await page.locator('.card-subs').first().evaluate(e => e.classList.contains('hide'))));

  await page.locator('.sub-row .check').first().click(); await page.waitForTimeout(600);
  A('서브태스크 완료 토글', (await page.locator('.sub-row.done').count()) === 1);
  const ctTxt = await page.locator('.sub-head .ct').first().innerText();
  A('진척 배지가 완료 수를 반영', /^1\//.test(ctTxt), ctTxt);
  A('진척 바 폭 반영', /width:\s*100%|width:\s*50%/.test(
    await page.locator('.sub-head .bar i').first().getAttribute('style')));
  await page.locator('.sub-row .check').first().click(); await page.waitForTimeout(600);
  await page.screenshot({ path: 'shot-17-board-subs.png' });

  // 서브행을 컬럼 빈 영역으로 끌면 최상위로 승격
  const colA = await page.locator('.col').nth(0).boundingBox();
  const topsBefore = await page.locator('.col').nth(0).locator('.card').count();
  await dragMouse(page, '.sub-row', { x: colA.x + colA.width / 2, y: colA.y + colA.height - 26 }, 14, 120);
  A('서브행을 빈 영역으로 끌면 최상위 카드가 된다',
    (await page.locator('.col').nth(0).locator('.card').count()) === topsBefore + 1,
    `이전 ${topsBefore}`);
  const mvP = lastMove();
  A('승격 move 에는 parent 없음', !!mvP && !mvP.q.parent, mvP && JSON.stringify(mvP.q));

  /* ── 3.7 스쳐 지나가는 것만으로는 중첩되지 않아야 한다 ── */
  const passBy = await page.evaluate(async () => {
    const send = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, {
      pointerId: 9, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0
    }));
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const cards = document.querySelectorAll('.col .card');
    if (cards.length < 2) return { skipped: true };
    const src = cards[cards.length - 1], tgt = cards[0];
    const sb = src.getBoundingClientRect(), tb = tgt.getBoundingClientRect();
    send(src, 'pointerdown', sb.x + 40, sb.y + 20);
    let sawNest = false;
    for (let i = 1; i <= 10; i++) {                       // 카드 위를 빠르게 통과
      send(window, 'pointermove', tb.x + 40, tb.bottom + 40 - i * ((tb.height + 60) / 10));
      await sleep(14);
      if (document.querySelector('.card.nest-on')) sawNest = true;
    }
    send(window, 'pointerup', tb.x + 40, tb.top - 10);
    await sleep(300);
    return { sawNest };
  });
  A('빠르게 스쳐 지나가면 중첩 모드로 바뀌지 않음', passBy.skipped || passBy.sawNest === false);

  /* ── 4. 리스트 뷰 들여쓰기 드래그 ── */
  console.log('\n[드래그: 서브태스크로 내리기]');
  await page.reload(); await page.waitForTimeout(1000);
  await goView(page, '[data-view^="list:"]');
  const n0 = await page.locator('.task').count();
  A('목록 뷰 렌더', n0 >= 3, String(n0));
  A('드래그 그립 노출', (await page.locator('.wrap.dnd-on .grip').count()) >= 1);
  const row1 = await page.locator('.task').nth(0).boundingBox();
  const row2 = await page.locator('.task').nth(1).boundingBox();
  const b2 = calls.length;
  // 2번째 행을 1번째 행 바로 아래로 + 오른쪽 60px → 들여쓰기
  await dragMouse(page, '.task >> nth=1', { x: row2.x + 120, y: row1.y + row1.height - 4 });
  const mv2 = lastMove();
  A('move 호출에 parent 포함', !!mv2 && !!mv2.q.parent, mv2 && JSON.stringify(mv2.q));
  A('서브태스크로 렌더', (await page.locator('.task.sub').count()) >= 1);
  await page.screenshot({ path: 'shot-14-subtask.png' });

  /* ── 5. 상세 패널 계층 버튼 ── */
  console.log('\n[상세 패널 계층 버튼]');
  await page.locator('.task.sub .t-body').first().click();
  await page.waitForTimeout(450);
  const subsBefore = await page.locator('.task.sub').count();
  A('계층 행 존재', (await page.locator('.dt-row [data-h="out"]').count()) === 1);
  A('상위 항목 선택 드롭다운 존재', (await page.locator('#dtParent').count()) === 1);
  A('현재 상위가 선택되어 있음', !!(await page.locator('#dtParent').inputValue()));
  await page.locator('.dt-row [data-h="out"]').click();
  await page.waitForTimeout(500);
  const mv3 = lastMove();
  A('최상위로 올리면 parent 없이 move', !!mv3 && !mv3.q.parent, mv3 && JSON.stringify(mv3.q));
  A('서브태스크 표시 해제', (await page.locator('.task.sub').count()) < subsBefore, `이전 ${subsBefore}`);
  await page.locator('#dtClose').click(); await page.waitForTimeout(200);

  /* ── 6. 터치 롱프레스 드래그 (아이폰) ── */
  console.log('\n[터치: 롱프레스 드래그]');
  const mp = await boot({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await goView(mp, '[data-view="board"]');
  A('모바일 보드 컬럼 폭 스냅', (await mp.locator('.col').first().boundingBox()).width < 393);
  const touchRes = await mp.evaluate(async () => {
    const send = (el, type, x, y, extra = {}) => el.dispatchEvent(new PointerEvent(type, {
      pointerId: 1, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true,
      clientX: x, clientY: y, button: 0, ...extra
    }));
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const card = document.querySelector('.col .card');
    const b = card.getBoundingClientRect();
    send(card, 'pointerdown', b.x + 40, b.y + 20);
    await sleep(120);
    const early = !!document.getElementById('dragGhost');       // 롱프레스 전에는 시작되면 안 됨
    await sleep(240);
    const armed = !!document.getElementById('dragGhost');       // 롱프레스 후 시작
    for (let i = 1; i <= 8; i++) { send(window, 'pointermove', b.x + 40 + i * 30, b.y + 20 + i * 4); await sleep(16); }
    const line = !!document.getElementById('dropLine');
    send(window, 'pointerup', b.x + 280, b.y + 52);
    await sleep(400);
    return { early, armed, line, ghostGone: !document.getElementById('dragGhost') };
  });
  A('롱프레스 전에는 드래그가 시작되지 않는다', touchRes.early === false);
  A('롱프레스 260ms 후 드래그 시작', touchRes.armed === true);
  A('드롭 인디케이터 표시', touchRes.line === true);
  A('드롭 후 고스트 제거', touchRes.ghostGone === true);
  await mp.screenshot({ path: 'shot-15-board-iphone.png' });

  /* ── 7. 터치 스크롤은 드래그로 오인되지 않는다 ── */
  const scrollRes = await mp.evaluate(async () => {
    const send = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, {
      pointerId: 2, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0
    }));
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const card = document.querySelector('.col .card');
    const b = card.getBoundingClientRect();
    send(card, 'pointerdown', b.x + 40, b.y + 20);
    await sleep(60);
    for (let i = 1; i <= 5; i++) { send(window, 'pointermove', b.x + 40, b.y + 20 - i * 12); await sleep(12); }
    const started = !!document.getElementById('dragGhost');
    await sleep(320);
    const startedLate = !!document.getElementById('dragGhost');
    send(window, 'pointerup', b.x + 40, b.y - 60);
    await sleep(120);
    return { started, startedLate };
  });
  A('세로 스와이프는 드래그로 오인되지 않음', scrollRes.started === false && scrollRes.startedLate === false);

  console.log('\n[오류] ' + (errs.length ? '\n  ' + errs.join('\n  ') : '없음'));
  console.log(`\n실패 ${bad}건`);
  process.exitCode = (bad || errs.length) ? 1 : 0;
  await browser.close(); server.close();
})();
