/* Malro service worker — 앱 셸만 캐시한다. API 응답은 절대 캐시하지 않는다. */
const CACHE = 'malro-v1';
/* './index.html' 은 넣지 않는다 — Cloudflare Pages 가 그 주소를 './' 로 301 하기 때문에
   받아 두면 리디렉션 이력이 붙은 응답이 캐시에 들어간다. 아래 unredirect() 설명 참고. */
const SHELL = ['./', './core.js', './app.js', './dnd.js', './ai.js', './manifest.webmanifest',
  './icon-180.png', './icon-192.png', './icon-512.png'];

/* 리디렉션을 거친 응답은 **페이지 이동(navigate) 요청에 그대로 돌려줄 수 없다.**
   Fetch/Service Worker 스펙이 금지하고, Safari 는 이렇게 거부한다:

       Safari가 해당 페이지를 열 수 없습니다.
       오류: 'Response served by service worker has redirections'

   Cloudflare Pages 는 `/index.html` 을 `/` 로 301 한다. 홈 화면 바로가기가
   manifest 의 start_url(`./index.html`)로 들어오면 이 경로를 정확히 밟는다.
   게다가 그 응답을 캐시에 넣어 두면 다음부터는 네트워크 없이도 계속 실패한다.

   몸통만 꺼내 새 Response 로 감싸면 리디렉션 이력이 사라진다. 캐시에 넣기 전과
   돌려주기 전, 두 지점 모두에서 통과시킨다. */
async function unredirect(r) {
  if (!r || !r.redirected) return r;
  const body = await r.blob();
  return new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers });
}

self.addEventListener('install', e => {
  /* addAll 대신 직접 돌린다 — 각 응답을 unredirect() 에 통과시켜야 하고,
     파일 하나가 실패했다고 설치 전체가 무너지지 않게 하려는 목적도 있다. */
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(SHELL.map(async u => {
      try {
        const r = await unredirect(await fetch(u, { cache: 'reload' }));
        if (r.ok) await c.put(u, r);
      } catch (err) { /* 한 개쯤 없어도 앱은 뜬다 */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;          // googleapis / accounts.google.com 는 통과

  /* stale-while-revalidate.

     예전 판은 `return hit || net` 이었는데, **캐시에도 없고 네트워크도 실패하면**
     net 이 catch 에서 undefined(=hit) 를 돌려줘 respondWith 가 undefined 를 받았다.
     그러면 브라우저는 이유를 알 수 없는 `ERR_FAILED` 를 띄운다 — 새 버전을 배포한
     직후(캐시 이름이 바뀌어 옛 캐시가 지워진 순간)에 통신이 한 번 흔들리면 딱 이 상황이다.
     이제는 (1) 페이지 이동이면 캐시된 앱 셸을 대신 주고, (2) 그것도 없으면 진짜
     네트워크 오류를 그대로 드러낸다. 실패를 그럴듯한 것으로 덮지 않는다. */
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(e.request);
    if (hit) {
      e.waitUntil(fetch(e.request)
        .then(async r => { if (r.ok) return c.put(e.request, await unredirect(r)); })
        .catch(() => {}));
      return hit;
    }
    try {
      const r = await unredirect(await fetch(e.request));
      if (r.ok) c.put(e.request, r.clone());
      return r;
    } catch (err) {
      if (e.request.mode === 'navigate') {
        const shell = await c.match('./');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
