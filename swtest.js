/* 서비스워커 계약 테스트.
 *
 * sw.js 는 두 번 사고를 냈다. 둘 다 "실패를 그럴듯한 것으로 덮은" 사고다.
 *
 *   1) 캐시에도 없고 네트워크도 죽으면 respondWith 가 undefined 를 받아 ERR_FAILED.
 *   2) Cloudflare Pages 가 /index.html → / 로 301 하는데, 그 리디렉션 이력이 붙은
 *      응답을 페이지 이동 요청에 돌려줘 Safari 가 거부
 *      ('Response served by service worker has redirections').
 *
 * 그래서 여기서는 **실서버의 못된 행동을 흉내낸 서버**로 돌린다 — 정규화 리디렉션과
 * 네트워크 두절을 스위치로 켜고 끈다. 로컬 정적 서버로만 테스트하면 둘 다 안 잡힌다.
 */
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
let down = false;            // 네트워크 두절 스위치
let canonical = true;        // Cloudflare Pages 식 /index.html → / 정규화 301

const server = http.createServer((q, r) => {
  if (down) { r.destroy(); return; }
  const p = q.url.split('?')[0];
  if (canonical && p === '/index.html') { r.writeHead(301, { Location: '/' }); return r.end(); }
  const f = path.join(__dirname, p === '/' ? 'index.html' : p);
  fs.readFile(f, (e, d) => {
    if (e) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' }); r.end(d);
  });
});

const PORT = 4207, ORIGIN = `http://localhost:${PORT}`;

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
  let bad = 0;
  const assert = (n, c, extra) => { console.log(`  ${c ? '✓' : '✗'} ${n}${c || !extra ? '' : ' — ' + extra}`); if (!c) bad++; };

  /** 서비스워커가 붙은 새 컨텍스트를 만든다 */
  async function withSW() {
    const ctx = await browser.newContext({ locale: 'ko-KR' });
    const pg = await ctx.newPage();
    await pg.goto(ORIGIN + '/');
    await pg.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 10000 }).catch(() => {});
    await pg.waitForTimeout(1200);
    return { ctx, pg };
  }

  console.log('\n[서비스워커]');

  /* ① 홈 화면 바로가기 경로 — start_url 이 301 을 타도 열려야 한다 */
  {
    down = false; canonical = true;
    const { ctx, pg } = await withSW();
    assert('서비스워커가 등록된다', await pg.evaluate(() => !!navigator.serviceWorker.controller));
    let err = null;
    try { await pg.goto(ORIGIN + '/index.html', { timeout: 8000 }); }
    catch (e) { err = e.message.split('\n')[0]; }
    assert('정규화 301 을 거치는 주소로 들어가도 앱이 열린다 (Safari 리디렉션 거부 회귀)',
      !err && (await pg.locator('#topbar').count()) > 0, err);

    /* 리디렉션 이력이 붙은 응답을 캐시에 남기면 다음부터 네트워크 없이도 계속 실패한다 */
    const dirty = await pg.evaluate(async () => {
      const c = await caches.open((await caches.keys()).find(k => k.startsWith('saydo-')));
      const rs = await Promise.all((await c.keys()).map(k => c.match(k)));
      return rs.filter(r => r && r.redirected).length;
    });
    assert('리디렉션 이력이 붙은 응답을 캐시에 넣지 않는다', dirty === 0, `${dirty}건 발견`);
    await ctx.close();
  }

  /* ② 캐시에 정확히 일치하는 항목이 없는 주소로 오프라인 진입 → 앱 셸 폴백 */
  {
    down = false; canonical = true;
    const { ctx, pg } = await withSW();
    down = true;
    let err = null;
    try { await pg.goto(ORIGIN + '/index.html?from=homescreen', { timeout: 8000 }); }
    catch (e) { err = e.message.split('\n')[0]; }
    assert('오프라인 + 캐시 불일치 주소 → 앱 셸로 연다 (ERR_FAILED 회귀)',
      !err && (await pg.locator('#topbar').count()) > 0, err);
    down = false;
    await ctx.close();
  }

  /* ③ 평범한 오프라인 재방문 */
  {
    down = false; canonical = true;
    const { ctx, pg } = await withSW();
    down = true;
    let err = null;
    try { await pg.goto(ORIGIN + '/', { timeout: 8000 }); }
    catch (e) { err = e.message.split('\n')[0]; }
    assert('오프라인에서도 캐시로 앱이 열린다', !err && (await pg.locator('#topbar').count()) > 0, err);
    down = false;
    await ctx.close();
  }

  /* ④ 캐시에 없고 네트워크도 죽은 '자원' 요청은 조용히 삼키지 말고 실패해야 한다 */
  {
    down = false; canonical = true;
    const { ctx, pg } = await withSW();
    down = true;
    const outcome = await pg.evaluate(() =>
      fetch('./없는파일-' + Date.now() + '.js').then(() => 'ok').catch(() => 'threw'));
    assert('없는 자원 + 오프라인은 진짜 오류로 드러낸다 (undefined 응답 금지)', outcome === 'threw', outcome);
    down = false;
    await ctx.close();
  }

  /* ⑤ manifest 의 start_url 이 리디렉션을 타지 않는 주소인지 */
  {
    const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.webmanifest'), 'utf8'));
    assert("manifest 의 start_url 이 './' 이다 (./index.html 은 301 을 탄다)",
      m.start_url === './', m.start_url);
  }

  console.log(`\n실패 ${bad}건`);
  process.exitCode = bad ? 1 : 0;
  await browser.close(); server.close();
})();
