/* 데모 단일 파일 빌드 — index.html + 스크립트 4개를 한 파일로 합친다.
 *
 * 왜 스크립트로 만드는가
 *   이 번들은 손으로 만들어져 있었고, 앱을 고쳐도 따라오지 않았다. 그래서
 *   demotest 가 앱이 아니라 몇 주 전 스냅샷을 검증하는 상태가 됐다 —
 *   통과가 증거가 되지 못하는 테스트다. 매 검증 전에 이 스크립트로 다시 만든다.
 *
 * 만드는 것
 *   demo-wrapped.html  아티팩트용. head 없이 body 콘텐츠만 (아티팩트가 셸을 씌운다)
 *   saydo-demo.html     단독 실행용 완전한 문서
 *
 * 실행:  node build-demo.js
 */
'use strict';
const fs = require('fs');

const html = fs.readFileSync('index.html', 'utf8');
const SCRIPTS = ['core.js', 'app.js', 'dnd.js', 'ai.js'];

/* index.html 에서 <body> 안쪽만 꺼낸다 */
const bodyStart = html.indexOf('<body>');
const bodyEnd = html.lastIndexOf('</body>');
if (bodyStart < 0 || bodyEnd < 0) { console.error('✗ index.html 에서 <body> 를 찾지 못했습니다'); process.exit(1); }
let body = html.slice(bodyStart + '<body>'.length, bodyEnd);

/* <style> 블록은 head 에 있으므로 따로 꺼내 앞에 붙인다 */
const styleM = html.match(/<style>[\s\S]*?<\/style>/);
if (!styleM) { console.error('✗ <style> 블록을 찾지 못했습니다'); process.exit(1); }

/* 외부 스크립트 태그를 실제 내용으로 치환한다 */
let inlined = 0;
for (const f of SCRIPTS) {
  const tag = new RegExp(`<script src="\\./${f.replace('.', '\\.')}"></script>`);
  if (!tag.test(body)) { console.error(`✗ ${f} 의 script 태그를 찾지 못했습니다`); process.exit(1); }
  const src = fs.readFileSync(f, 'utf8');
  if (/<\/script>/i.test(src)) { console.error(`✗ ${f} 안에 </script> 문자열이 있어 인라인할 수 없습니다`); process.exit(1); }
  body = body.replace(tag, `<script>\n${src}\n</script>`);
  inlined++;
}

/* 데모 모드 강제. app.js 는 ?demo= 쿼리 또는 window.SAYDO_DEMO 를 본다.
   단일 파일은 쿼리가 없으니 플래그를 먼저 세워야 한다. */
const flag = '<script>window.SAYDO_DEMO = true;</script>\n';
const sw = '<script>if("serviceWorker" in navigator){/* 데모 번들은 SW 를 등록하지 않는다 */}</script>\n';

const inner = `<title>Saydo</title>\n${styleM[0]}\n${flag}${sw}${body}`;

fs.writeFileSync('demo-wrapped.html',
  '<!doctype html><html lang="ko"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
  + `</head><body>${inner}</body></html>`);

fs.writeFileSync('saydo-demo.html', inner);

const kb = n => (fs.statSync(n).size / 1024).toFixed(0) + 'KB';
console.log(`▸ 스크립트 ${inlined}개 인라인`);
console.log(`▸ demo-wrapped.html  ${kb('demo-wrapped.html')}`);
console.log(`▸ saydo-demo.html     ${kb('saydo-demo.html')}`);
