const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const MIME = { '.html':'text/html','.js':'text/javascript','.png':'image/png','.webmanifest':'application/manifest+json' };
const srv = http.createServer((rq,rs)=>{const f=path.join(__dirname, rq.url==='/'?'index.html':rq.url.split('?')[0]);
  fs.readFile(f,(e,d)=>{ if(e){rs.writeHead(404);return rs.end();} rs.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'text/plain'});rs.end(d);});});
(async()=>{
  await new Promise(r=>srv.listen(4174,r));
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium'}).catch(()=>chromium.launch());
  let bad=0, ext=[]; const A=(n,c)=>{console.log(`  ${c?'✓':'✗'} ${n}`); if(!c)bad++;};

  // 1) 배포 패키지의 ?demo=1
  let ctx = await b.newContext({viewport:{width:1320,height:900},locale:'ko-KR',timezoneId:'Asia/Seoul'});
  let p = await ctx.newPage(); const errs=[];
  p.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
  p.on('console',m=>{if(m.type()==='error')errs.push('CONSOLE: '+m.text());});
  p.on('request',r=>{const u=r.url(); if(!u.startsWith('http://localhost:4174'))ext.push(u);});
  await p.goto('http://localhost:4174/index.html?demo=1'); await p.waitForTimeout(1200);
  console.log('\n[패키지 ?demo=1]');
  A('인증 화면 안 뜸', !(await p.locator('#auth').evaluate(e=>e.classList.contains('on'))));
  A('DEMO 배지 표시', (await p.locator('text=DEMO').count())>=1);
  A('태스크 렌더', (await p.locator('.task').count())>=3);
  A('googleapis 호출 없음', ext.filter(u=>u.includes('googleapis')||u.includes('accounts.google')).length===0);

  // 2) 아티팩트용 단일 파일 (head 없이 body 콘텐츠만)
  console.log('\n[아티팩트 단일 파일]');

  ctx = await b.newContext({viewport:{width:1320,height:900},locale:'ko-KR',timezoneId:'Asia/Seoul'});
  p = await ctx.newPage();
  p.on('pageerror',e=>errs.push('DEMO PAGEERROR: '+e.message));
  p.on('console',m=>{if(m.type()==='error')errs.push('DEMO CONSOLE: '+m.text());});
  p.on('requestfailed',r=>console.log('    (요청 실패) '+r.url()));
  p.on('response',r=>{ if(r.status()>=400) console.log('    (4xx/5xx) '+r.status()+' '+r.url()); });
  await p.goto('http://localhost:4174/demo-wrapped.html');
  await p.waitForTimeout(1200);
  A('단일 파일에서 렌더', (await p.locator('.task').count())>=3);
  A('사이드바 목록 3개', (await p.locator('[data-view^="list:"]').count())===3);

  // 테마 3상태 검증
  const bg = () => p.evaluate(()=>getComputedStyle(document.body).backgroundColor);
  const light = await bg();
  await p.emulateMedia({colorScheme:'dark'}); await p.waitForTimeout(150);
  const sysDark = await bg();
  A('시스템 다크 → 배경 변경', sysDark !== light);
  await p.evaluate(()=>document.documentElement.setAttribute('data-theme','light'));
  await p.waitForTimeout(150);
  A('data-theme=light 가 OS 다크를 이김', (await bg()) === light);
  await p.emulateMedia({colorScheme:'light'});
  await p.evaluate(()=>document.documentElement.setAttribute('data-theme','dark'));
  await p.waitForTimeout(150);
  A('data-theme=dark 가 OS 라이트를 이김', (await bg()) === sysDark);
  await p.evaluate(()=>document.documentElement.removeAttribute('data-theme'));
  await p.waitForTimeout(150);
  A('스탬프 제거 시 시스템 설정 복귀', (await bg()) === light);

  // 토글 버튼이 실제로 동작하는지 (기존 버그 회귀)
  await p.locator('#themeBtn').click(); await p.waitForTimeout(250);
  A('테마 버튼 클릭 → 다크 적용', (await bg()) === sysDark);
  await p.screenshot({path:'shot-08-demo-dark.png'});
  await p.locator('#themeBtn').click(); await p.waitForTimeout(250);
  A('한 번 더 클릭 → 라이트', (await bg()) === light);

  // 상호작용
  await p.keyboard.press('q'); await p.waitForTimeout(300);
  await p.locator('#cmpInput').fill('다음주 화 오전 10시 임원 보고 준비 p1 @보고 ');
  await p.waitForTimeout(300);
  A('데모에서도 자연어 파싱', (await p.locator('.ptag').count())>=3);
  await p.locator('#cmpSave').click(); await p.waitForTimeout(400);
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  await p.locator('[data-view="upcoming"]').click(); await p.waitForTimeout(400);
  A('추가한 항목이 예정 뷰에 표시', (await p.locator('.task', {hasText:'임원 보고 준비'}).count())>=1);
  await p.locator('[data-view="today"]').click(); await p.waitForTimeout(300);
  const n0 = await p.locator('.task').count();
  await p.locator('.check').first().click(); await p.waitForTimeout(600);
  A('완료 토글 동작', (await p.locator('.task').count()) < n0);
  await p.screenshot({path:'shot-09-demo.png'});

  /* ── 스킨(야상) — 테마와 직교하는 축 ──
     스킨 블록은 data-theme 블록과 특정도가 같아서, CSS 에서 뒤에 오지 않으면
     조용히 무시된다. 그래서 속성이 아니라 "실제로 계산된 색"을 본다. */
  console.log('\n[스킨: 야상]');
  const px = () => p.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return { bg: cs.getPropertyValue('--bg').trim(), accent: cs.getPropertyValue('--accent').trim(),
             r: cs.getPropertyValue('--r').trim(), colW: cs.getPropertyValue('--col-w').trim() };
  });

  const t0 = await px();
  await p.evaluate(() => applySkin('nocturne'));
  const t1 = await px();
  A('야상을 켜면 바탕색이 실제로 바뀐다', t1.bg === '#15171b', JSON.stringify(t1));
  A('강조가 붉은색에서 호박빛으로', t1.accent === '#c9873c', t1.accent);
  A('모서리도 함께 커진다', t1.r === '13px', t1.r);
  A('data-skin 속성이 찍힌다',
    await p.evaluate(() => document.documentElement.getAttribute('data-skin') === 'nocturne'));

  await p.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  A('라이트 테마를 명시해도 야상은 어둡다', (await px()).bg === '#15171b');
  await p.evaluate(() => document.documentElement.removeAttribute('data-theme'));

  await p.evaluate(() => applySkin(''));
  const t2 = await px();
  A('끄면 원래 팔레트로 돌아온다', t2.bg === t0.bg && t2.accent === t0.accent, JSON.stringify({t0,t2}));
  A('속성도 제거된다', await p.evaluate(() => !document.documentElement.hasAttribute('data-skin')));

  console.log('\n[보드 컬럼 1.3배 · 하단 바]');
  A('컬럼 폭 토큰이 306 → 398px', t0.colW === '398px', t0.colW);
  await p.evaluate(() => { S.view = 'board'; render(); });
  await p.waitForTimeout(300);
  const colW = await p.evaluate(() => {
    const c = document.querySelector('.col');
    return c ? Math.round(c.getBoundingClientRect().width) : 0;
  });
  A('실제 렌더 폭도 398px', colW === 398, String(colW));
  A('보드에서는 하단 추가 바가 숨는다',
    await p.evaluate(() => document.getElementById('addBar').classList.contains('hide')));
  await p.evaluate(() => { S.view = 'today'; render(); });
  await p.waitForTimeout(250);
  A('목록 뷰로 돌아오면 추가 바가 다시 보인다',
    await p.evaluate(() => !document.getElementById('addBar').classList.contains('hide')));

  const mob = await b.newContext({viewport:{width:393,height:852},deviceScaleFactor:3,isMobile:true,hasTouch:true,locale:'ko-KR',timezoneId:'Asia/Seoul'});
  const mp = await mob.newPage();
  await mp.goto('http://localhost:4174/demo-wrapped.html');
  await mp.waitForTimeout(1000);
  A('아이폰 폭에서 가로 스크롤 없음', await mp.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
  await mp.screenshot({path:'shot-10-demo-iphone.png'});

  console.log('\n[오류] '+(errs.length? '\n  '+errs.join('\n  '):'없음'));
  console.log(`\n실패 ${bad}건`);
  process.exitCode = (bad||errs.length)?1:0;
  await b.close(); srv.close();
})();
