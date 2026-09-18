/* ==========================================================================
   Saydo — Google Tasks 를 저장소로 쓰는 Todoist 스타일 개인 태스크 매니저
   --------------------------------------------------------------------------
   설계 요약
   · Google Tasks 는 "제목 / 메모 / 날짜 / 완료여부 / 부모" 만 저장 가능.
   · 우선순위·라벨·시간·반복·소요시간은 notes 마지막 줄의 메타 블록에 인코딩한다.
       본문...
       ⟦p1 @검증 ⏰14:30 ↻w1:1 ⏳30⟧
     → 서버 없이도 맥북/아이폰/아이패드 간 자동 동기화된다.
   · 앱은 로컬 캐시(localStorage)로 즉시 렌더 → 낙관적 업데이트 → API 반영.
   ========================================================================== */
'use strict';

/* ─────────────────────────── 0. 상수 & 아이콘 ─────────────────────────── */
/* 'email' 은 AI 프록시가 호출자를 식별하는 데 쓴다.
   이게 없으면 tokeninfo 가 이메일을 돌려주지 않아 프록시가 401 로 거부한다. */
const SCOPE = 'https://www.googleapis.com/auth/tasks email';
const API = 'https://tasks.googleapis.com/tasks/v1';
const LS = {
  cid: 'saydo.clientId', lists: 'saydo.lists', tasks: 'saydo.tasks',
  view: 'saydo.view', theme: 'saydo.theme', skin: 'saydo.skin', defaultList: 'saydo.defaultList',
  queue: 'saydo.queue', showDone: 'saydo.showDone', boardBy: 'saydo.boardBy', collapsed: 'saydo.collapsed',
  token: 'saydo.token', sortBy: 'saydo.sortBy', account: 'saydo.account'
};

/* 정렬 기준 — 앱 전체에 하나로 적용된다(뷰별로 따로 두지 않는다).
   manual   : 등록·수동 이동 순서. Google Tasks 의 position 이 그대로 반영된 순서다.
   due      : 마감일 이른 것부터. 기한 없는 항목은 언제나 맨 뒤.
   priority : P1 부터. 우선순위 없음(4)은 맨 뒤.
   방향 전환은 두지 않는다 — 세 기준 모두 "급한 것이 위" 라는 한 방향만 의미가 있다. */
const SORT_KEYS = ['manual', 'due', 'priority'];
const SORT_LABEL = { manual: '등록일순', due: '마감일순', priority: '중요도순' };

/* localStorage 는 프라이빗 모드·사이트 데이터 차단·썸네일 캡처 등에서 접근 자체가
   예외를 던진다. 저장 실패가 앱을 죽이면 안 되므로 전부 감싼다. */
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 무시 */ } }
};

const I = {
  today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/></svg>',
  upcoming: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18"/><circle cx="8.5" cy="14" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="14" r="1.1" fill="currentColor" stroke="none"/><circle cx="15.5" cy="14" r="1.1" fill="currentColor" stroke="none"/></svg>',
  inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13.5h4l1.6 2.6h6.8L17 13.5h4"/><path d="M4.6 5.2 3 13.5v3.8A2.7 2.7 0 0 0 5.7 20h12.6a2.7 2.7 0 0 0 2.7-2.7v-3.8l-1.6-8.3A2.2 2.2 0 0 0 17.2 3.5H6.8a2.2 2.2 0 0 0-2.2 1.7Z"/></svg>',
  all: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5h16M4 12h16M4 17.5h16"/></svg>',
  done: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.6"/><path d="m8.4 12.2 2.5 2.5 4.7-5"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 4.5h11a2 2 0 0 1 2 2v13.5l-3-2-2.5 2-2.5-2-2.5 2-2.5-2V6.5a2 2 0 0 1 2-2Z"/><path d="M9 9h6M9 13h4"/></svg>',
  tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M11.6 3.5H5.4A1.9 1.9 0 0 0 3.5 5.4v6.2c0 .5.2 1 .6 1.4l7.4 7.4a1.9 1.9 0 0 0 2.7 0l6.2-6.2a1.9 1.9 0 0 0 0-2.7L13 4.1a1.9 1.9 0 0 0-1.4-.6Z"/><circle cx="7.8" cy="7.8" r="1.3" fill="currentColor" stroke="none"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  sync: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11.5A8 8 0 0 0 6.2 6.2L4 8.4"/><path d="M4 4.5v4h4"/><path d="M4 12.5a8 8 0 0 0 13.8 5.3L20 15.6"/><path d="M20 19.5v-4h-4"/></svg>',
  theme: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.3A8.6 8.6 0 0 1 9.7 3.5a8.6 8.6 0 1 0 10.8 10.8Z"/></svg>',
  skin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18Z" fill="currentColor" stroke="none"/></svg>',
  sort: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 6.5h15M6.5 12h11M9.5 17.5h5"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.6"/><path d="M12 7.4V12l3 1.8"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3.6" y="5" width="16.8" height="15" rx="2.4"/><path d="M3.6 9.6h16.8M8 3v4M16 3v4"/></svg>',
  repeat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5A4.5 4.5 0 0 1 8.5 5H18"/><path d="m15.5 2.5 3 2.5-3 2.5"/><path d="M20 14.5A4.5 4.5 0 0 1 15.5 19H6"/><path d="m8.5 21.5-3-2.5 3-2.5"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4.5M5 4.5h11l-1.6 3.4L16 11.3H5"/></svg>',
  hourglass: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h10M7 21h10M8 3v3.5c0 2 4 3.6 4 5.5s-4 3.5-4 5.5V21M16 3v3.5c0 2-4 3.6-4 5.5s4 3.5 4 5.5V21"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 5.5H5.5A2 2 0 0 0 3.5 7.5v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-7"/><path d="M17 3.5a2.1 2.1 0 0 1 3 3L12 14.5l-4 1 1-4Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5h16M9.5 6.5V4.8A1.3 1.3 0 0 1 10.8 3.5h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7M6.5 6.5 7.4 19a1.7 1.7 0 0 0 1.7 1.5h5.8a1.7 1.7 0 0 0 1.7-1.5l.9-12.5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 5.5v13M5.5 12h13"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/></svg>',
  empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.3 2.4 2.4 4.6-5"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m7 9.5 5 5 5-5"/></svg>',
  board: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="5.5" height="15" rx="1.6"/><rect x="10.2" y="4.5" width="5.5" height="10" rx="1.6"/><rect x="17.4" y="4.5" width="3.6" height="13" rx="1.6"/></svg>',
  indent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M11 6.5h9M11 12h9M11 17.5h9"/><path d="m3.5 9 3 3-3 3"/></svg>',
  outdent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M11 6.5h9M11 12h9M11 17.5h9"/><path d="m6.5 9-3 3 3 3"/></svg>',
  grip: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.2 13.7 8 18.5 9.7 13.7 11.4 12 16.2 10.3 11.4 5.5 9.7 10.3 8Z"/><path d="M18.6 15.2l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7Z"/></svg>',
  cog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.1"/><path d="M19.4 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4H21a1.6 1.6 0 0 0-1.5 1Z"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 11.8 20 4.5l-7.3 15.5-1.9-6.3Z"/><path d="m10.8 13.7 9.2-9.2"/></svg>',
  check2: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8.5v4.2M12 16.3v.2"/><path d="M10.3 4.2 2.9 17.4A1.9 1.9 0 0 0 4.6 20.3h14.8a1.9 1.9 0 0 0 1.7-2.9L13.7 4.2a1.9 1.9 0 0 0-3.4 0Z"/></svg>'
};

/* ─────────────────────────── 3.5 데모 모드 ───────────────────────────
   ?demo=1 로 열거나 window.SAYDO_DEMO = true 이면 Google 연결 없이
   가짜 데이터로 UI 전체를 체험할 수 있다. 서버 호출을 일절 하지 않고
   변경 사항도 저장하지 않는다(새로고침하면 초기 상태로 복귀). */
const DEMO = /[?&]demo/.test(location.search) || window.SAYDO_DEMO === true;
function demoSeed() {
  const d = n => { const x = new Date(); x.setDate(x.getDate() + n); return ymd(x) + 'T00:00:00.000Z'; };
  const lists = [{ id: 'L1', title: '업무' }, { id: 'L2', title: '프로젝트' }, { id: 'L3', title: '개인' }];
  const tasks = {
    L1: [
      { id: 'd1', title: '분기 예산안 검토', notes: '검토 의견 3건 확인 후 승인 여부 결정\n\n⟦p1 @긴급 ⏰09:30 ⏳45⟧', due: d(0), status: 'needsAction', position: '001' },
      { id: 'd2', title: '주간 데일리 스탠드업', notes: '⟦p3 @팀 ↻wd ⏰09:00⟧', due: d(0), status: 'needsAction', position: '002' },
      { id: 'd3', title: '고객 피드백 정리', notes: '⟦p2 @기획⟧', due: d(-2), status: 'needsAction', position: '003' },
      { id: 'd4', title: '채용 공고 초안', notes: '팀별 라이선스 재집계 필요\n\n⟦p2 ↻m1⟧', due: d(4), status: 'needsAction', position: '004' },
      { id: 'd5', title: '보안 점검 대응 자료', notes: '', due: d(1), status: 'needsAction', position: '005' },
      { id: 'd5a', title: '접근통제 정책 문서 갱신', notes: '⟦p3⟧', parent: 'd5', due: d(1), status: 'needsAction', position: '006' },
      { id: 'd5b', title: '로그 보존기간 근거 정리', notes: '', parent: 'd5', status: 'needsAction', position: '007' },
      { id: 'd6', title: 'AI 거버넌스 가이드 초안 회람', notes: '⟦p3 @거버넌스⟧', due: d(7), status: 'needsAction', position: '006' },
      { id: 'd7', title: '지난주 회고 문서화', notes: '⟦p4⟧', due: d(-1), status: 'completed', completed: d(-1), position: '007' }
    ],
    L2: [
      { id: 'd8', title: '배포 파이프라인 2차 점검', notes: '롤백 시간 5분 이내 목표\n\n⟦p1 @검증 ⏰14:00 ↻w1:1 ⏳90⟧', due: d(0), status: 'needsAction', position: '001' },
      { id: 'd9', title: '로드맵 TO-BE 초안', notes: '⟦p2 @조직⟧', due: d(3), status: 'needsAction', position: '002' },
      { id: 'd10', title: '품질 점검 결과 취합', notes: '⟦p3 @품질⟧', due: d(9), status: 'needsAction', position: '003' },
      { id: 'd11', title: '외주 용역 중간보고', notes: '⟦p2 @보고⟧', due: d(14), status: 'needsAction', position: '004' }
    ],
    L3: [
      { id: 'd12', title: '치과 예약', notes: '⟦p3 ⏰18:30⟧', due: d(2), status: 'needsAction', position: '001' },
      { id: 'd13', title: '주말 등산 코스 확인', notes: '⟦p4 @취미⟧', status: 'needsAction', position: '002' }
    ]
  };
  return { lists, tasks };
}

/* 액세스 토큰을 새로고침 너머로 살려 둔다.
 *
 *  왜 필요한가
 *    토큰이 메모리에만 있으면 새로고침·앱 재실행 때마다 사라진다. 그때마다 무음
 *    재발급을 시도하는데, Safari 의 ITP 가 그 경로(숨은 프레임)를 자주 막는다.
 *    그러면 새로고침할 때마다 로그인 화면이 뜬다 — 실제로 그렇게 겪었다.
 *
 *  대가
 *    베어러 토큰이 저장소에 남는다. 유효기간은 1시간이고 스코프는 tasks+email 뿐이며,
 *    앱은 외부 스크립트를 하나도 싣지 않아 XSS 표면이 사실상 없다. 개인 기기에서
 *    쓰는 도구로서는 "매번 로그인" 보다 이쪽이 낫다고 판단했다.
 *    401 을 받으면 즉시 지운다 — 죽은 토큰을 붙들고 있지 않는다. */
const tokenStore = {
  save(tok, exp) { store.set(LS.token, JSON.stringify({ t: tok, e: exp })); },
  load() {
    try {
      const j = JSON.parse(store.get(LS.token) || 'null');
      return (j && j.t && typeof j.e === 'number' && Date.now() < j.e) ? j : null;
    } catch (e) { return null; }
  },
  clear() { store.set(LS.token, ''); }
};

/* ─────────────────────────── 4. 상태 ─────────────────────────── */

/* 기본 OAuth 클라이언트 ID.
 *
 *   OAuth 클라이언트 ID 는 비밀값이 아니다. 브라우저 앱에서는 어차피 네트워크 요청에
 *   그대로 노출되며, Google 도 공개를 전제로 설계했다 (그래서 클라이언트 시크릿이 없다).
 *   실제 방어선은 "승인된 JavaScript 원본" 이다 — 등록되지 않은 오리진에서는 이 ID 로
 *   토큰을 발급받을 수 없다. 남이 이 값을 알아도 자기 사이트에 붙여 쓸 수 없고,
 *   설령 이 앱을 열더라도 보이는 것은 자기 Google 계정의 자기 태스크뿐이다.
 *
 *   그래서 기본값으로 박아 둔다. 기기를 추가할 때마다 아이폰 키보드로 72자를
 *   입력하는 것이 실제 위험보다 훨씬 큰 비용이다.
 *
 *   우선순위: ?cid= 쿼리 > 이 기기에 저장된 값 > 아래 기본값
 *   다른 클라이언트로 바꾸려면 설정에서 입력하면 저장값이 우선한다. */
/* Saydo 전용 — **개인 Google 계정**의 Cloud 프로젝트(345139066407)에서 발급한 값이다.
   Tasq(개인용)의 것(프로젝트 933877346643)은 회사 Workspace 계정에 묶여 있어 가져오지
   않는다. 공개 배포판이 거기에 의존하면 소유권이 흐려진다 — `uitest.js` 가 그 값이 다시
   섞여 들어오지 않는지 감시한다. */
const DEFAULT_CLIENT_ID = '345139066407-ogtlu760k9o4dfb3iuiqpcl27e5rfi9p.apps.googleusercontent.com';

function initialClientId() {
  let q = '';
  try { q = (new URLSearchParams(location.search).get('cid') || '').trim(); } catch (e) { }
  if (q) { store.set(LS.cid, q); return q; }
  return store.get(LS.cid) || DEFAULT_CLIENT_ID;
}

const S = {
  token: null, tokenExp: 0, client: null, clientId: initialClientId(),
  lists: JSON.parse(store.get(LS.lists) || '[]'),
  tasks: JSON.parse(store.get(LS.tasks) || '{}'),     // listId -> [task]
  queue: JSON.parse(store.get(LS.queue) || '[]'),
  view: store.get(LS.view) || 'today',
  showDone: store.get(LS.showDone) === '1',
  boardBy: store.get(LS.boardBy) || 'list',
  sortBy: SORT_KEYS.includes(store.get(LS.sortBy)) ? store.get(LS.sortBy) : 'manual',
  collapsed: new Set(JSON.parse(store.get(LS.collapsed) || '[]')),
  search: '', detailKey: null, syncing: false, booted: false,
  silentTry: false, lastSilentFail: 0,
  lastSync: 0, listsAt: 0, doneAt: 0,
  trunc: {},          // listId -> true  (1000건 상한에 닿아 일부만 받아온 목록)
  failed: [],         // 이번 동기화에서 받아오지 못한 목록 제목
  account: store.get('saydo.account') || ''
};
const save = () => {
  if (DEMO) return;                                  // 데모 모드는 저장하지 않는다
  store.set(LS.lists, JSON.stringify(S.lists));
  store.set(LS.tasks, JSON.stringify(S.tasks));
  store.set(LS.queue, JSON.stringify(S.queue));
};
const $ = id => document.getElementById(id);
const esc = s => (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 모든 태스크를 뷰 모델로 평탄화 */
function allTasks() {
  const out = [];
  S.lists.forEach((l, li) => {
    const arr = S.tasks[l.id] || [];
    arr.forEach((t, idx) => {
      if (t.deleted) return;
      const { body, meta } = decodeNotes(t.notes);
      out.push({
        id: t.id, listId: l.id, listTitle: l.title, listIdx: li, title: t.title || '', body, ...meta,
        due: dueToYmd(t.due), done: t.status === 'completed', parent: t.parent || null,
        order: idx, position: t.position || '', completed: t.completed || null, _raw: t
      });
    });
  });
  return out;
}
const rawOf = (listId, id) => (S.tasks[listId] || []).find(x => x.id === id) || null;
const kidsOf = (listId, id) => (S.tasks[listId] || []).filter(x => x.parent === id);
const taskByKey = k => { const [l, i] = String(k).split('/'); return allTasks().find(t => t.listId === l && t.id === i) || null; };
const labelsOf = ts => { const m = new Map(); for (const t of ts) if (!t.done) for (const l of t.labels) m.set(l, (m.get(l) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); };

/* ─────────────────────────── 5. 인증 ─────────────────────────── */
/* Google Identity Services 는 실제로 인증이 필요할 때만 불러온다.
   데모 모드나 오프라인에서는 외부 요청을 아예 만들지 않는다. */
function loadGIS(cb) {
  if (window.google && window.google.accounts && window.google.accounts.oauth2) return cb();
  if (document.getElementById('gis')) return setTimeout(() => loadGIS(cb), 200);
  const el = document.createElement('script');
  el.id = 'gis'; el.src = 'https://accounts.google.com/gsi/client'; el.async = true;
  el.onload = cb;
  el.onerror = () => showAuth('Google 인증 스크립트를 불러오지 못했습니다. 네트워크를 확인해 주세요.');
  document.head.appendChild(el);
}
function initAuth() {
  if (DEMO) {
    const seed = demoSeed(); S.lists = seed.lists; S.tasks = seed.tasks;
    S.booted = true; setSync('ok'); render();
    document.querySelector('.brand').insertAdjacentHTML('afterend',
      '<span style="font-size:10.5px;font-weight:700;letter-spacing:.06em;padding:2px 6px;border-radius:5px;' +
      'background:var(--accent-soft);color:var(--accent)">DEMO</span>');
    setTimeout(() => toast('데모 모드 — 변경 사항은 저장되지 않습니다'), 700);
    return;
  }
  if (!S.clientId) { showAuth('클라이언트 ID를 입력하세요.', true); return; }
  if (!window.google || !window.google.accounts || !window.google.accounts.oauth2) { loadGIS(initAuth); return; }
  S.client = google.accounts.oauth2.initTokenClient({
    client_id: S.clientId, scope: SCOPE,
    callback: r => {
      if (r.error) { authSettle(null); showAuth('인증 실패: ' + r.error); return; }
      S.token = r.access_token; S.tokenExp = Date.now() + (r.expires_in - 60) * 1000;
      tokenStore.save(S.token, S.tokenExp);
      S.lastSilentFail = 0;
      $('auth').classList.remove('on');
      authSettle(S.token);
      if (!S.booted) { S.booted = true; boot(); } else { fullSync(true); loadAccount(); }
    },
    error_callback: e => {
      const wasSilent = S.silentTry;
      S.silentTry = false;
      if (wasSilent) S.lastSilentFail = Date.now();
      authSettle(null);
      /* 무음 재발급이 막힌 것뿐이라면 앱을 통째로 가리지 않는다. 캐시된 태스크는
         계속 보여 주고, 쓰기가 필요한 순간에만 다시 묻는다. Safari 에서 흔하다.
         화면을 덮는 인증 패널은 **사용자가 직접 연결을 누른 뒤 실패했을 때만** 띄운다 —
         배경 동기화가 덮어 버리면 사용자는 로그인을 두 번 하게 된다. */
      if (wasSilent && S.lists.length) {
        setSync('err');
        toast('연결이 만료됐습니다', '다시 연결', () => requestToken(false));
        return;
      }
      showAuth('인증 창이 닫혔거나 차단되었습니다. (' + (e.type || '') + ')');
    }
  });

  /* 살아 있는 토큰이 있으면 인증 화면을 아예 건너뛴다 — 새로고침의 대부분이 여기서 끝난다. */
  const cached = tokenStore.load();
  if (cached) {
    S.token = cached.t; S.tokenExp = cached.e;
    $('auth').classList.remove('on');
    S.booted = true; boot();
    return;
  }
  if (S.lists.length) { S.booted = true; render(); requestToken(true); }
  else showAuth();
}
/* ── 토큰 획득은 반드시 이 한 곳을 지난다 ─────────────────────────────────
   예전에는 세 군데(부팅, 토스트의 '다시 연결', api() 의 ensureToken)가 각자
   requestAccessToken 을 불렀다. 그래서 사용자가 연결 창을 띄운 사이에 배경 동기화가
   또 하나를 띄우고, 그쪽이 실패하면 인증 패널이 앱을 덮어 **로그인을 두 번** 하게 됐다.
   진행 중인 요청이 있으면 새로 띄우지 않고 그 결과를 함께 기다린다. */
let authInFlight = null;
function authSettle(tok) {
  const f = authInFlight; authInFlight = null;
  if (f && f.resolve) f.resolve(tok);
}
const SILENT_COOLDOWN = 60 * 1000;   // 무음 재시도 최소 간격

function acquireToken(interactive) {
  if (S.token && Date.now() < S.tokenExp) return Promise.resolve(S.token);
  if (authInFlight) return authInFlight.p;                 // 이미 떠 있다 — 같이 기다린다
  if (!S.client) { initAuth(); return Promise.resolve(S.token); }
  /* 방금 무음으로 실패했으면 잠시 쉰다. 탭 전환(visibilitychange)마다 다시 시도하면
     구글에 의미 없는 요청만 쌓이고, 실패 처리가 겹쳐 화면이 튄다. */
  if (!interactive && S.lastSilentFail && Date.now() - S.lastSilentFail < SILENT_COOLDOWN) {
    return Promise.resolve(null);
  }
  let resolve;
  const p = new Promise(r => { resolve = r; });
  authInFlight = { p, resolve };
  S.silentTry = !interactive;
  try {
    /* prompt:'consent' 는 이미 승인한 사용자에게도 **권한 동의 화면을 매번 다시** 띄운다.
       (계정 선택 + 동의 = 두 화면) 범위를 새로 요구하는 것이 아니므로 지정하지 않는다. */
    S.client.requestAccessToken(interactive ? {} : { prompt: '' });
  } catch (e) { authSettle(null); showAuth('토큰 요청 실패'); }
  setTimeout(() => { if (authInFlight && authInFlight.p === p) authSettle(S.token); }, 20000);
  return p;
}
function requestToken(silent) {
  if (!S.client) return initAuth();
  acquireToken(!silent);
}
/** api() 가 부른다 — 배경 호출이므로 절대 화면을 덮지 않는다 */
const ensureToken = () => acquireToken(false);
function showAuth(err, needCid) {
  $('auth').classList.add('on');
  $('cidField').classList.toggle('hide', !(needCid || !S.clientId));
  $('cidInput').value = S.clientId;
  const e = $('authErr'); e.classList.toggle('hide', !err); e.textContent = err || '';
}

/* ─────────────────────────── 6. API ─────────────────────────── */
async function api(path, opt = {}) {
  const tk = await ensureToken();
  if (!tk) throw new Error('no-token');
  const r = await fetch(API + path, {
    ...opt,
    headers: { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json', ...(opt.headers || {}) }
  });
  if (r.status === 401) { S.token = null; S.tokenExp = 0; tokenStore.clear(); throw new Error('unauthorized'); }
  if (!r.ok) {
    /* 상태 코드를 문자열에 섞어 두면 나중에 문자열을 뒤져야 한다. 재시도 여부를 정확히
       가르려면 숫자가 필요하므로 에러에 붙여 준다. 네트워크 실패는 fetch 가 그냥 던지고
       status 가 없으므로, 호출부에서 `status ?? 0` 을 "네트워크 오류" 로 읽는다. */
    const err = new Error(`${r.status} ${await r.text()}`);
    err.status = r.status;
    throw err;
  }
  return r.status === 204 ? null : r.json();
}
const apiLists = () => api('/users/@me/lists?maxResults=100');

/* ── 완료 항목은 90일까지만 ─────────────────────────────────────────────
   예전에는 목록마다 `showCompleted=true` 로 **완료분까지 전부** 받아 왔다. 몇 년 쓰면
   미완료 20건을 보려고 완료 3000건을 매번 내려받고, 파싱하고, localStorage 에 넣는다.
   그리고 1000건에서 루프가 끊기는데 **아무도 그 사실을 모른다.**

   그래서 호출을 둘로 나눈다.
     · 미완료 — `showCompleted=false`. 매 동기화. 이쪽이 항상 정확해야 한다.
     · 완료   — `completedMin=<90일 전>`. DONE_TTL 간격으로만.

   **왜 한 번에 안 하는가.** `completedMin` 을 `showCompleted=true` 와 같이 주면
   완료일이 없는 태스크(= 미완료 전부)가 비교에서 탈락해 함께 걸러진다. 한 호출로
   합치면 "할 일이 하나도 없다" 는 화면이 나온다. 두 호출로 나누면 이 의미론이
   어느 쪽이든 결과가 같다 — 미완료 호출은 완료 필터를 아예 쓰지 않으므로.

   대가는 호출 수인데, 완료분은 거의 변하지 않으므로 TTL 로 눌러 둔다. 30분 동기화
   기준 12회에 1회만 두 번째 호출이 붙는다(+8%). 대신 평상시 페이로드가 크게 준다.

   알려진 절충 — 다른 클라이언트(구글 태스크 앱·시리)에서 완료한 항목은 미완료 목록에서
   즉시 사라지지만 '완료됨' 뷰에는 최대 DONE_TTL 뒤에 나타난다. R(강제 동기화)로 바로 당긴다. */
const DONE_KEEP_DAYS = 90;
const DONE_TTL = 6 * 60 * 60 * 1000;
const PAGE_CAP = 1000;
const doneSince = () => new Date(Date.now() - DONE_KEEP_DAYS * 86400000).toISOString();
/** 창(窓) 안의 완료 항목인가. completed 가 없으면 버리지 않는다 — 판단 근거가 없으면 남긴다. */
const doneInWindow = (t, since) => !t.completed || String(t.completed) >= since;

/* 상한에 닿았다는 사실을 **호출부로 돌려준다.** 예전에는 `out.length < 1000` 으로
   조용히 빠져나가서, 목록이 잘린 화면과 멀쩡한 화면이 구분되지 않았다. */
async function apiTasks(listId, opt = {}) {
  let out = [], pageToken = '', truncated = false;
  do {
    const q = `/lists/${listId}/tasks?maxResults=100&showHidden=true&showDeleted=false`
      + `&showCompleted=${opt.completed ? 'true' : 'false'}`
      + (opt.completedMin ? '&completedMin=' + encodeURIComponent(opt.completedMin) : '')
      + (pageToken ? '&pageToken=' + pageToken : '');
    const r = await api(q);
    out = out.concat(r.items || []);
    pageToken = r.nextPageToken || '';
    if (pageToken && out.length >= PAGE_CAP) { truncated = true; break; }
  } while (pageToken);
  return { items: out, truncated };
}

/* ─────────────────────────── 7. 뮤테이션 큐 ─────────────────────────── */
/* 재시도 정책 — 일시적 실패(네트워크·5xx·429)는 큐에 남기고 지수 백오프로 다시 보낸다.
   무한히 붙들고 있지는 않는다: MAX_TRIES 를 넘기면 포기하되 무엇을 버렸는지 알린다. */
const QUEUE_MAX_TRIES = 6;
const QUEUE_BACKOFF_BASE = 2000;    // 2초에서 시작해 2배씩
const QUEUE_BACKOFF_MAX = 60000;    // 최대 1분 간격
let flushTimer = 0;

function enqueue(op) { if (DEMO) return; S.queue.push(op); save(); flush(); }
let flushing = false;
async function flush() {
  if (flushing || !S.queue.length) return;
  flushing = true; setSync('busy');
  while (S.queue.length) {
    const op = S.queue[0];
    try {
      if (op.k === 'patch') {
        let r;
        if ('due' in op.body && op.body.due === null) {
          // Tasks API 는 PATCH 로 due 를 지우지 못한다 → 전체 PUT 으로 필드를 생략해 초기화
          const cur = await api(`/lists/${op.listId}/tasks/${op.id}`);
          const next = { ...cur, ...op.body };
          delete next.due; delete next.etag; delete next.selfLink; delete next.kind;
          r = await api(`/lists/${op.listId}/tasks/${op.id}`, { method: 'PUT', body: JSON.stringify(next) });
        } else {
          r = await api(`/lists/${op.listId}/tasks/${op.id}`, { method: 'PATCH', body: JSON.stringify(op.body) });
        }
        replaceLocal(op.listId, r);
      } else if (op.k === 'insert') {
        const q = op.parent ? `?parent=${op.parent}` : '';
        const r = await api(`/lists/${op.listId}/tasks${q}`, { method: 'POST', body: JSON.stringify(op.body) });
        // 임시 id → 실제 id 교체
        const arr = S.tasks[op.listId] || [];
        const i = arr.findIndex(t => t.id === op.tmpId);
        if (i >= 0) arr[i] = r; else arr.push(r);
        if (S.detailKey === op.listId + '/' + op.tmpId) S.detailKey = op.listId + '/' + r.id;
        // 큐에 남은 후속 연산(move 등)이 임시 ID 를 참조하고 있으면 실제 ID 로 바꿔 준다
        for (const o of S.queue) {
          if (o.id === op.tmpId) o.id = r.id;
          if (o.parent === op.tmpId) o.parent = r.id;
          if (o.previous === op.tmpId) o.previous = r.id;
          if (o.body && o.body.parent === op.tmpId) o.body.parent = r.id;
        }
      } else if (op.k === 'move') {
        const q = [];
        if (op.parent) q.push('parent=' + encodeURIComponent(op.parent));
        if (op.previous) q.push('previous=' + encodeURIComponent(op.previous));
        if (op.destinationTasklist) q.push('destinationTasklist=' + encodeURIComponent(op.destinationTasklist));
        const r = await api(`/lists/${op.listId}/tasks/${op.id}/move` + (q.length ? '?' + q.join('&') : ''),
          { method: 'POST' });
        const finalList = op.destinationTasklist || op.listId;
        if (op.destinationTasklist) {
          const src = S.tasks[op.listId] || [];
          const si = src.findIndex(x => x.id === op.id);
          if (si >= 0) src.splice(si, 1);
        }
        replaceLocal(finalList, r);
      } else if (op.k === 'delete') {
        await api(`/lists/${op.listId}/tasks/${op.id}`, { method: 'DELETE' });
      } else if (op.k === 'renamelist') {
        await api(`/users/@me/lists/${op.listId}`, { method: 'PATCH', body: JSON.stringify({ title: op.title }) });
      } else if (op.k === 'dellist') {
        await api(`/users/@me/lists/${op.listId}`, { method: 'DELETE' });
      } else if (op.k === 'newlist') {
        const r = await api('/users/@me/lists', { method: 'POST', body: JSON.stringify({ title: op.title }) });
        const i = S.lists.findIndex(l => l.id === op.tmpId);
        if (i >= 0) { S.tasks[r.id] = S.tasks[op.tmpId] || []; delete S.tasks[op.tmpId]; S.lists[i] = r; }
      }
      S.queue.shift(); op.tries = 0; save();
    } catch (e) {
      if (String(e.message).includes('unauthorized')) { await ensureToken(); if (!S.token) break; continue; }

      /* 예전에는 실패를 **종류 구분 없이 큐에서 버렸다.** 낙관적 업데이트 때문에 화면에는
         그대로 남아 저장된 것처럼 보이고, 다음 fullSync 가 서버 데이터로 덮으면 편집이
         사라졌다. 토스트는 "새로고침해 주세요" 였는데 그 새로고침이 바로 지우는 동작이었다.

         이제 두 갈래로 나눈다.
           · 재시도해도 소용없는 것(4xx) → 버리되 **무엇을 못 저장했는지 말한다**
           · 일시적인 것(네트워크·5xx·429·408) → 큐에 남기고 지수 백오프로 다시 시도한다 */
      const st = e.status || 0;                     // fetch 자체가 실패하면 status 가 없다
      const retriable = st === 0 || st === 408 || st === 429 || st >= 500;
      op.tries = (op.tries || 0) + 1;

      if (retriable && op.tries < QUEUE_MAX_TRIES) {
        save(); setSync('err');
        const wait = Math.min(QUEUE_BACKOFF_MAX, QUEUE_BACKOFF_BASE * Math.pow(2, op.tries - 1));
        clearTimeout(flushTimer);
        flushTimer = setTimeout(() => flush(), wait);
        if (op.tries === 1) toast('연결이 불안정합니다 — 자동으로 다시 보냅니다');
        break;                                       // 큐 순서를 지켜야 하므로 여기서 멈춘다
      }

      /* 여기까지 오면 포기한다. 조용히 버리지 않는다 — 무엇이 사라졌는지 알려야
         사용자가 다시 입력할 수 있다. */
      console.warn('sync drop', op, e);
      S.queue.shift(); save(); setSync('err');
      toast(droppedMsg(op, retriable));
    }
  }
  flushing = false; setSync(S.queue.length ? 'err' : 'ok'); render();
}

/** 버린 연산을 사람 말로 설명한다. 제목을 찾을 수 있으면 제목까지 붙인다. */
function droppedMsg(op, retriable) {
  const title = (op.body && op.body.title)
    || (rawOf(op.listId, op.id) || {}).title
    || (op.title || '');
  const what = { insert: '추가', patch: '수정', move: '이동', delete: '삭제',
                 newlist: '목록 추가', renamelist: '목록 이름 변경', dellist: '목록 삭제' }[op.k] || '변경';
  const why = retriable ? '여러 번 시도했지만' : '서버가 거부해';
  return `${why} 저장하지 못했습니다 — ${what}${title ? ` "${trimTitle(title)}"` : ''}`;
}
const trimTitle = t => (String(t).length > 18 ? String(t).slice(0, 18) + '…' : String(t));
/** 아직 서버로 나가지 않은 연산이 걸린 태스크 id 들 */
function pendingIds() {
  const s = new Set();
  for (const o of S.queue) { if (o.id) s.add(o.id); if (o.tmpId) s.add(o.tmpId); }
  return s;
}
function replaceLocal(listId, t) {
  const arr = S.tasks[listId] || (S.tasks[listId] = []);
  const i = arr.findIndex(x => x.id === t.id);
  if (i >= 0) arr[i] = t; else arr.push(t);
}

/* ─────────────────────────── 8. 동기화 ─────────────────────────── */
function setSync(st) {
  const d = $('syncDot'); d.className = st === 'busy' ? 'busy' : st === 'err' ? 'err' : '';
}
/* ── 동기화 예산 ───────────────────────────────────────────────────────────
   Tasks API 는 **프로젝트당 하루 5만 쿼리**다. 사용자별이 아니라 앱 전체 합계이므로,
   동기화 빈도가 그대로 "몇 명까지 쓸 수 있는가" 가 된다. 개인 도구일 때는 신경 쓸 일이
   아니었지만 공개판에서는 이것이 수용 인원을 결정한다.

   쿼터는 **호출 건수**를 센다. `updatedMin` 델타 조회는 전송량만 줄일 뿐 건수는 같으므로
   쿼터에는 도움이 되지 않는다. 줄일 수 있는 것은 **빈도와 호출당 건수** 둘뿐이다.

     하루 8시간 사용 기준 (목록 3개)
       이전: 5분 간격 + 탭 복귀마다 전량, 매번 목록까지 조회  →  약 400콜  →  약 125명
       현재: 30분 간격 + 복귀는 디바운스, 목록은 6시간마다    →  약  52콜  →  약 960명

   더 필요하면 Cloud Console 에서 쿼터 증량을 신청한다. */
const SYNC_EVERY = 30 * 60 * 1000;   // 주기 동기화 간격
const SYNC_MIN_GAP = 10 * 60 * 1000; // 탭 복귀 등으로 앞당길 수 있는 최소 간격
const LISTS_TTL = 6 * 60 * 60 * 1000; // 목록은 거의 안 바뀐다 — 이 간격으로만 다시 읽는다

/** 사용자가 직접 요청한 동기화(R 키·새로고침 버튼)는 force 로 간격을 무시한다. */
async function fullSync(force) {
  if (DEMO || S.syncing) return;
  if (!force && S.lastSync && Date.now() - S.lastSync < SYNC_MIN_GAP) return;
  S.syncing = true; setSync('busy');
  try {
    await flush();
    /* 목록 조회를 매번 하면 동기화 1회당 1콜이 통째로 늘어난다. 목록은 거의 바뀌지 않으므로
       TTL 을 두고, 캐시가 있으면 건너뛴다. 사용자가 강제 동기화하면 항상 다시 읽는다. */
    const listsStale = force || !S.lists.length || !S.listsAt || Date.now() - S.listsAt > LISTS_TTL;
    if (listsStale) {
      const ls = await apiLists();
      S.lists = (ls.items || []).map(l => ({ id: l.id, title: l.title }));
      S.listsAt = Date.now();
    }
    if (!store.get(LS.defaultList) && S.lists[0]) store.set(LS.defaultList, S.lists[0].id);

    /* 완료분은 TTL 간격으로만 다시 읽는다. 그 사이에는 캐시를 쓰되, 90일 창 밖으로
       나간 것은 여기서 떨궈 준다 — 그러지 않으면 캐시가 영원히 자란다. */
    const since = doneSince();
    const doneStale = force || !S.doneAt || Date.now() - S.doneAt > DONE_TTL;
    const trunc = {}, failed = [];
    const results = await Promise.all(S.lists.map(async l => {
      try {
        const open = await apiTasks(l.id, { completed: false });
        let doneItems;
        if (doneStale) {
          const d = await apiTasks(l.id, { completed: true, completedMin: since });
          doneItems = d.items;
          if (d.truncated) trunc[l.id] = true;
        } else {
          doneItems = (S.tasks[l.id] || []).filter(t => t.status === 'completed' && doneInWindow(t, since));
        }
        if (open.truncated) trunc[l.id] = true;
        /* 같은 id 가 양쪽에 있으면 미완료 쪽이 최신이다 — 다른 기기에서 완료를 되돌린 경우. */
        const seen = new Set(open.items.map(t => t.id));
        return open.items.concat(doneItems.filter(t => !seen.has(t.id)));
      } catch (e) {
        /* 이 목록만 이번 회차를 건너뛴다. 이전 화면을 그대로 둘 뿐, 빈 배열로 덮지 않는다.
           다만 **조용히 넘기지는 않는다** — 예전에는 여기서 캐시를 돌려주고 동기화 표시가
           초록으로 남아, 목록 하나가 몇 시간째 낡아 있어도 알 길이 없었다. */
        failed.push({ title: l.title, msg: String(e && e.message || e) });
        return S.tasks[l.id] || [];
      }
    }));
    /* 실패한 목록이 있으면 완료분을 다시 읽었다고 볼 수 없다 — TTL 을 갱신하지 않는다. */
    if (doneStale && !failed.length) S.doneAt = Date.now();
    S.trunc = trunc;
    S.failed = failed.map(f => f.title);

    /* 서버 데이터로 통째로 덮으면 **아직 전송되지 않은 편집이 사라진다.** 큐에 연산이
       걸린 태스크는 로컬 판이 최신이므로 그대로 둔다. 아직 서버에 존재조차 하지 않는
       것(신규 생성 대기, tmp_ id)도 붙여 준다 — 그러지 않으면 방금 만든 항목이
       화면에서 사라졌다가 전송이 끝나야 돌아온다. */
    const keep = pendingIds();
    S.lists.forEach((l, i) => {
      const server = results[i];
      if (!keep.size) { S.tasks[l.id] = server; return; }
      const local = S.tasks[l.id] || [];
      const seen = new Set(server.map(t => t.id));
      const merged = server.map(t => (keep.has(t.id) ? (local.find(x => x.id === t.id) || t) : t));
      for (const t of local) if (keep.has(t.id) && !seen.has(t.id)) merged.push(t);
      S.tasks[l.id] = merged;
    });
    for (const k of Object.keys(S.tasks)) if (!S.lists.find(l => l.id === k)) delete S.tasks[k];
    /* 목록이 하나라도 실패했으면 "이 시각까지 동기화됐다" 고 말할 수 없다. lastSync 를
       찍어 버리면 SYNC_MIN_GAP 동안 재시도조차 막힌다. */
    if (!failed.length) S.lastSync = Date.now();
    save();
    if (!failed.length) setSync('ok');
    else {
      setSync('err');
      /* 목록별 실패가 전부 인증 문제면 원인이 하나다 — 토큰. 그 말을 해 준다. */
      const auth = failed.every(f => /unauthorized|no-token/.test(f.msg));
      if (auth) toast('연결이 만료됐습니다', '다시 연결', () => requestToken(false));
      else toast(`${failed.length}개 목록을 받아오지 못했습니다 — 이전 내용을 보여 주는 중`);
    }
  } catch (e) {
    console.warn(e); setSync('err');
    /* 보여 줄 캐시가 있으면 인증 패널로 덮지 않는다 — 만료 안내는 토스트가 이미 한다.
       여기서 덮어 버리면 사용자가 연결 창을 띄운 사이에 화면이 바뀌어 로그인을 두 번 하게 된다. */
    const authProblem = String(e.message).includes('unauthorized') || String(e.message).includes('no-token');
    if (authProblem && !S.lists.length) showAuth('세션이 만료되었습니다. 다시 연결해 주세요.');
    else if (authProblem) toast('연결이 만료됐습니다', '다시 연결', () => requestToken(false));
  } finally { S.syncing = false; render(); }
}
/* ── 연결 계정 ────────────────────────────────────────────────────────────
   구글 계정을 여러 개 쓰는 사람은 "동기화가 안 된다" 고 느끼지만, 실제로는 **다른 계정의
   할 일을 보고 있는** 경우가 대부분이다. 앱이 어느 계정에 연결됐는지 말해 주지 않으면
   이걸 확인할 방법이 없다. email 범위를 이미 받고 있으므로 한 번만 물어보면 된다. */
async function loadAccount() {
  if (DEMO || !S.token) return;
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo',
      { headers: { Authorization: 'Bearer ' + S.token } });
    if (!r.ok) return;
    const j = await r.json();
    if (j && j.email) { S.account = j.email; store.set(LS.account, j.email); renderAccount(); }
  } catch (e) { /* 표시용일 뿐이므로 실패해도 앱은 그대로 간다 */ }
}
function renderAccount() {
  const box = $('sbAcct'); if (!box) return;
  box.classList.toggle('hide', !S.account);
  if (S.account) $('sbAcctEmail').textContent = S.account;
}

async function boot() { await fullSync(true); loadAccount(); }

/* ─────────────────────────── 9. 태스크 조작 ─────────────────────────── */
function defaultListId() {
  return store.get(LS.defaultList) || (S.lists[0] && S.lists[0].id) || null;
}
function createTask(p) {
  const listId = p.listId || defaultListId();
  if (!listId) { toast('먼저 목록을 만들어 주세요'); return; }
  const tmpId = 'tmp_' + Math.random().toString(36).slice(2, 10);
  const notes = encodeNotes(p.body || '', { p: p.p, labels: p.labels, time: p.time, rec: p.rec, dur: p.dur });
  const body = { title: p.title, notes, status: 'needsAction' };
  if (p.due) body.due = ymdToDue(p.due);
  (S.tasks[listId] = S.tasks[listId] || []).unshift({ ...body, id: tmpId, parent: p.parent || null, position: '' });
  enqueue({ k: 'insert', listId, tmpId, parent: p.parent || null, body });
  render();
}
/** id 로 태스크의 현재 위치를 찾는다. 목록 간 이동 직후처럼 t.listId 가 낡았을 수 있으므로
 *  먼저 지정 목록을 보고, 없으면 전체를 훑는다. */
function locate(t) {
  const direct = (S.tasks[t.listId] || []).findIndex(x => x.id === t.id);
  if (direct >= 0) return { listId: t.listId, i: direct };
  for (const l of S.lists) {
    const i = (S.tasks[l.id] || []).findIndex(x => x.id === t.id);
    if (i >= 0) return { listId: l.id, i };
  }
  return null;
}
function patchTask(t, patch) {
  const loc = locate(t);
  if (!loc) {                       // 조용히 실패하면 화면만 바뀐 채 서버에 반영되지 않는다
    toast('항목을 찾을 수 없습니다. 새로고침해 주세요');
    render(); return;
  }
  t = { ...t, listId: loc.listId };
  const arr = S.tasks[loc.listId], i = loc.i;
  Object.assign(arr[i], patch);
  if (String(t.id).startsWith('tmp_')) {                 // 아직 서버에 없으면 큐의 insert 본문을 갱신
    const op = S.queue.find(o => o.k === 'insert' && o.tmpId === t.id);
    if (op) { Object.assign(op.body, patch); save(); render(); return; }
  }
  enqueue({ k: 'patch', listId: t.listId, id: t.id, body: patch });
  render();
}
function reopen(t) {
  const loc = locate(t);
  if (loc) delete S.tasks[loc.listId][loc.i].completed;
  patchTask(t, { status: 'needsAction' });
}
function toggleDone(t) {
  if (t.done) { reopen(t); return; }
  if (t.rec) {                                            // 반복 → 다음 회차로 롤포워드
    const nd = nextDue(t.due, t.rec);
    patchTask(t, { due: ymdToDue(nd) });
    toast(`다음 일정: ${humanDate(nd, t.time)}`);
    return;
  }
  patchTask(t, { status: 'completed', completed: new Date().toISOString() });
  toast('완료', '실행 취소', () => reopen(t));
}
function deleteTask(t) {
  const loc = locate(t);
  if (!loc) { toast('항목을 찾을 수 없습니다'); render(); return; }
  t = { ...t, listId: loc.listId };
  const arr = S.tasks[loc.listId];
  const snapshot = arr[loc.i];
  arr.splice(loc.i, 1);
  if (!String(t.id).startsWith('tmp_')) enqueue({ k: 'delete', listId: t.listId, id: t.id });
  else { const qi = S.queue.findIndex(o => o.tmpId === t.id); if (qi >= 0) S.queue.splice(qi, 1); save(); }
  closeDetail(); render();
  toast('삭제됨', '실행 취소', () => {
    if (!snapshot) return;
    createTask({ title: snapshot.title, body: decodeNotes(snapshot.notes).body, ...decodeNotes(snapshot.notes).meta,
      due: dueToYmd(snapshot.due), listId: t.listId });
  });
}
function updateMeta(t, changes) {
  const meta = { p: t.p, labels: [...t.labels], time: t.time, rec: t.rec, dur: t.dur, ...changes };
  patchTask(t, { notes: encodeNotes(t.body, meta) });
}
function createList(title) {
  const tmpId = 'tmpl_' + Math.random().toString(36).slice(2, 8);
  S.lists.push({ id: tmpId, title }); S.tasks[tmpId] = [];
  enqueue({ k: 'newlist', tmpId, title });
  render();
}

/** 목록 이름 변경 — 되돌릴 수 있는 조작이라 확인을 묻지 않는다. */
function renameList(listId, title) {
  const l = S.lists.find(x => x.id === listId);
  if (!l || !title || title === l.title) return;
  l.title = title;
  if (String(listId).startsWith('tmpl_')) {
    /* 아직 서버에 없는 목록이다. 큐에 있는 생성 연산의 제목을 고치면 된다 —
       별도의 rename 을 보내면 없는 목록을 고치려다 404 가 난다. */
    const op = S.queue.find(o => o.k === 'newlist' && o.tmpId === listId);
    if (op) op.title = title;
    save(); render(); return;
  }
  enqueue({ k: 'renamelist', listId, title });
  render();
}

/* ── 목록 삭제 ────────────────────────────────────────────────────────────
   **되돌릴 수 없다.** Google Tasks API 는 목록을 지우면 그 안의 태스크까지 함께
   지우고, 휴지통이 없다. 그래서 되돌리기를 약속하지 않는다 — 캐시로 복원하는 흉내를
   낼 수는 있지만 id·position·상위 관계가 달라지고 중간에 실패하면 반쯤 복원된 상태가
   남는다. 못 지키는 약속을 UI 에 다는 것이 이 프로젝트에서 반복해 고쳐 온 실수다.

   대신 확인 단계가 무게를 진다.
     · 마지막 남은 목록은 막는다 (Tasks 는 목록이 0개인 상태를 허용하지 않는다)
     · 비어 있으면 한 번 확인
     · 태스크가 있으면 **개수를 보여 주고 목록 이름을 직접 입력**하게 한다 */
function deleteListFlow(listId) {
  const l = S.lists.find(x => x.id === listId);
  if (!l) return;
  if (S.lists.length <= 1) { toast('마지막 목록은 지울 수 없습니다'); return; }

  const n = (S.tasks[listId] || []).filter(t => !t.deleted).length;
  if (n === 0) {
    if (!confirm(`목록 "${l.title}" 을 지웁니다.\n되돌릴 수 없습니다.`)) return;
  } else {
    const typed = prompt(
      `목록 "${l.title}" 과 그 안의 태스크 ${n}건이 함께 삭제됩니다.\n` +
      `Google Tasks 에는 휴지통이 없어 되돌릴 수 없습니다.\n\n` +
      `정말 지우려면 목록 이름을 그대로 입력하세요:`);
    if (typed === null) return;
    if (typed.trim() !== l.title) { toast('이름이 달라 취소했습니다'); return; }
  }
  deleteList(listId);
}

function deleteList(listId) {
  const i = S.lists.findIndex(x => x.id === listId);
  if (i < 0) return;
  S.lists.splice(i, 1);
  delete S.tasks[listId];
  if (store.get(LS.defaultList) === listId) store.set(LS.defaultList, (S.lists[0] || {}).id || '');
  if (S.view === 'list:' + listId) S.view = 'today';
  /* 이 목록에 걸려 있던 미전송 연산은 보낼 곳이 없어졌다 — 같이 버린다.
     남겨 두면 404 를 맞고 "저장하지 못했습니다" 토스트만 쌓인다. */
  S.queue = S.queue.filter(o => o.listId !== listId && o.tmpId !== listId);
  if (String(listId).startsWith('tmpl_')) { save(); render(); return; }   // 서버에 없던 목록
  enqueue({ k: 'dellist', listId });
  render();
}

/* ─────────────────────────── 10. 렌더 ─────────────────────────── */
const VIEWS = {
  today: { t: '오늘', i: 'today' }, upcoming: { t: '예정', i: 'upcoming' },
  all: { t: '전체', i: 'all' }, done: { t: '완료됨', i: 'done' }, board: { t: '보드', i: 'board' }
};
const BOARD_BY = { list: '목록별', priority: '우선순위별', due: '기한별' };
function viewTitle() {
  if (S.view.startsWith('list:')) return (S.lists.find(l => l.id === S.view.slice(5)) || {}).title || '목록';
  if (S.view.startsWith('label:')) return '@' + S.view.slice(6);
  if (S.view === 'search') return '검색';
  if (S.view === 'board') return '보드 · ' + BOARD_BY[S.boardBy];
  return (VIEWS[S.view] || VIEWS.today).t;
}
function filterTasks(ts) {
  const T = todayY();
  if (S.view === 'search') {
    const q = S.search.trim().toLowerCase();
    if (!q) return [];
    return ts.filter(t => (t.title + ' ' + t.body + ' ' + t.labels.join(' ')).toLowerCase().includes(q));
  }
  if (S.view === 'done') return ts.filter(t => t.done).sort((a, b) => (b.completed || '').localeCompare(a.completed || ''));
  const open = ts.filter(t => !t.done || S.showDone);
  if (S.view === 'board') return open;
  if (S.view === 'today') return open.filter(t => t.due && diffDays(t.due, T) <= 0);
  if (S.view === 'upcoming') return open.filter(t => t.due && diffDays(t.due, T) >= 0 && diffDays(t.due, T) <= 60);
  if (S.view.startsWith('list:')) return open.filter(t => t.listId === S.view.slice(5));
  if (S.view.startsWith('label:')) return open.filter(t => t.labels.includes(S.view.slice(6)));
  return open;
}
/* ── 정렬 ──────────────────────────────────────────────────────────────
   기준 하나가 앱 전체(오늘·예정·전체·목록·라벨·검색·보드 컬럼 안)에 똑같이 적용된다.
   각 비교자는 1순위가 같을 때 나머지 두 축으로 차례로 갈라 준다. 마지막 갈림은 언제나
   수동 순서(order)라서, 무엇으로 정렬하든 결과가 흔들리지 않고 항상 같은 배열이 나온다.

   기한 없음은 '9999', 우선순위 없음은 p=4 라 자연히 맨 뒤로 간다 — 별도 분기가 필요 없다. */
/* 수동 순서(position)는 목록 안에서만 정의된다 — 목록이 다르면 비교할 기준이 없다.
   그래서 여러 목록이 섞이는 뷰(오늘·예정·라벨·검색)에서는 사이드바 목록 차례로 먼저
   묶고 그 안에서 수동 순서를 따른다. 목록 하나만 보는 뷰에서는 listIdx 가 같으므로
   결과가 예전과 똑같다. */
const byOrder = (a, b) => (a.listIdx - b.listIdx) || (a.order - b.order);
const byDue = (a, b) => ((a.due || '9999').localeCompare(b.due || '9999'))
  || ((a.time || '99').localeCompare(b.time || '99')) || (a.p - b.p) || byOrder(a, b);
const byPrio = (a, b) => (a.p - b.p) || ((a.due || '9999').localeCompare(b.due || '9999'))
  || ((a.time || '99').localeCompare(b.time || '99')) || byOrder(a, b);
const SORTER = { manual: byOrder, due: byDue, priority: byPrio };
/** 현재 선택된 비교자. 값이 깨져 있어도 등록일순으로 떨어지게 한다. */
const sorter = () => SORTER[S.sortBy] || byOrder;
const sortFor = ts => ts.sort(sorter());

/* 순서 드래그는 '등록일순' 일 때만 의미가 있다. 마감일·중요도로 정렬된 상태에서 순서를
   바꿔 봐야 다음 렌더에서 정렬이 다시 덮어쓰므로, 아예 받지 않는 편이 정직하다.
   보드는 예외 — 컬럼 간 이동은 순서가 아니라 목록·우선순위·기한을 바꾸는 조작이라 살려 둔다. */
const reorderOn = () => S.sortBy === 'manual';
/** 드래그를 시작할 수 있는 뷰인지 */
const dndEnabled = () => (S.view.startsWith('list:') && reorderOn()) || S.view === 'board';

function groupTasks(ts) {
  const T = todayY();
  if (S.view === 'today') {
    /* 지연됨·오늘 구분은 유지하고, 정렬은 각 구획 안에서만 일어난다. */
    const over = sortFor(ts.filter(t => diffDays(t.due, T) < 0));
    const now = sortFor(ts.filter(t => diffDays(t.due, T) === 0));
    return [over.length && { t: '지연됨', c: over.length, cls: 'overdue', ts: over }, { t: '오늘', c: now.length, ts: now }].filter(Boolean);
  }
  if (S.view === 'upcoming') {
    const m = new Map();
    /* 날짜 구획은 그대로 두고 구획 안만 정렬한다. 바깥 순서는 아래에서 날짜로 다시 잡는다. */
    for (const t of sortFor(ts)) { (m.get(t.due) || m.set(t.due, []).get(t.due)).push(t); }
    return [...m].sort((a, b) => a[0].localeCompare(b[0])).map(([d, arr]) => ({ t: humanDate(d), c: arr.length, ts: arr }));
  }
  if (S.view === 'all' || S.view === 'search' || S.view.startsWith('label:')) {
    const m = new Map();
    for (const t of sortFor(ts)) { (m.get(t.listTitle) || m.set(t.listTitle, []).get(t.listTitle)).push(t); }
    return [...m].map(([n, arr]) => ({ t: n, c: arr.length, ts: arr }));
  }
  return [{ t: null, c: ts.length, ts: sortFor(ts) }];
}

/* ─────────────────────────── 10.5 보드 뷰 ───────────────────────────
   컬럼 기준은 목록 / 우선순위 / 기한 중 선택한다. 카드를 다른 컬럼으로 끌면
   기준에 따라 목록 이동 · 우선순위 변경 · 기한 변경이 일어난다.
   보드에는 최상위 태스크만 카드로 올리고, 서브태스크는 개수 배지로 표시한다. */
function boardColumns(ts) {
  // 최상위 카드는 미완료만(설정에 따라 완료 포함), 서브태스크는 진척도를 보여야 하므로 완료도 함께 렌더한다
  const open = ts.filter(t => !t.done || S.showDone || t.parent);
  const tops = open.filter(t => !t.parent && (!t.done || S.showDone));
  if (S.boardBy === 'priority') {
    return [1, 2, 3, 4].map(p => ({
      id: String(p), kind: 'p', sw: `var(--p${p})`,
      title: ['', '긴급 P1', '높음 P2', '보통 P3', '우선순위 없음'][p],
      ts: sortFor(tops.filter(t => t.p === p))
    }));
  }
  if (S.boardBy === 'due') {
    const T = todayY();
    const B = [
      { id: 'over', title: '지연됨', sw: 'var(--p1)', f: t => t.due && diffDays(t.due, T) < 0 },
      { id: 'today', title: '오늘', sw: 'var(--ok)', f: t => t.due && diffDays(t.due, T) === 0 },
      { id: 'tmr', title: '내일', sw: 'var(--p2)', f: t => t.due && diffDays(t.due, T) === 1 },
      { id: 'week', title: '이번 주', sw: 'var(--p3)', f: t => t.due && diffDays(t.due, T) > 1 && diffDays(t.due, T) <= 7 },
      { id: 'later', title: '이후', sw: 'var(--p4)', f: t => t.due && diffDays(t.due, T) > 7 },
      { id: 'none', title: '기한 없음', sw: 'var(--faint)', f: t => !t.due }
    ];
    return B.map(b => ({ id: b.id, kind: 'due', title: b.title, sw: b.sw, ts: sortFor(tops.filter(b.f)) }));
  }
  return S.lists.map(l => ({
    id: l.id, kind: 'list', title: l.title, sw: 'var(--accent)',
    ts: sortFor(tops.filter(t => t.listId === l.id))
  }));
}
/** 카드 안에 들어가는 서브태스크 한 줄 */
function subRowHtml(k) {
  const chips = [];
  if (k.due) chips.push(`<span class="chip ${dueClass(k.due)}">${esc(humanDate(k.due, k.time))}</span>`);
  for (const l of k.labels) chips.push(`<span class="lbl">@${esc(l)}</span>`);
  return `<div class="sub-row ${k.done ? 'done' : ''}" data-k="${k.listId}/${k.id}">
    <button class="check sm p${k.p}" data-act="toggle">${I.check}</button>
    <span class="sub-t" data-act="open">${esc(k.title) || '제목 없음'}</span>
    ${chips.length ? `<span class="sub-m">${chips.join('')}</span>` : ''}
  </div>`;
}
function cardHtml(t, kids) {
  const m = [];
  if (t.due) m.push(`<span class="chip ${dueClass(t.due)}">${I.cal}${esc(humanDate(t.due, t.time))}</span>`);
  if (t.rec) m.push(`<span class="chip">${I.repeat}${esc(recLabel(t.rec))}</span>`);
  if (t.dur) m.push(`<span class="chip">${I.hourglass}${t.dur >= 60 ? (t.dur / 60).toFixed(t.dur % 60 ? 1 : 0) + '시간' : t.dur + '분'}</span>`);
  if (S.boardBy !== 'list' && S.lists.length > 1) m.push(`<span class="chip" style="opacity:.7">${esc(t.listTitle)}</span>`);
  for (const l of t.labels) m.push(`<span class="lbl">@${esc(l)}</span>`);

  const has = kids.list.length;
  const folded = S.collapsed.has(t.id);
  const pct = has ? Math.round(kids.done / has * 100) : 0;
  return `<div class="card p${t.p} ${t.done ? 'done' : ''} ${has ? 'has-subs' : ''}" data-k="${t.listId}/${t.id}">
    <div class="card-top">
      <button class="check p${t.p}" data-act="toggle">${I.check}</button>
      <div class="card-t" data-act="open">${esc(t.title) || '<span style="opacity:.45">제목 없음</span>'}</div>
    </div>
    ${m.length ? `<div class="card-m">${m.join('')}</div>` : ''}
    ${has ? `
    <button class="sub-head ${folded ? 'folded' : ''}" data-act="fold">
      <span class="cv">${I.chev}</span>
      <span class="bar"><i style="width:${pct}%"></i></span>
      <span class="ct">${kids.done}/${has}</span>
    </button>
    <div class="card-subs${folded ? ' hide' : ''}">${kids.list.map(subRowHtml).join('')}</div>` : ''}
  </div>`;
}
function renderBoard(ts) {
  const all = ts;
  const cols = boardColumns(ts);
  let h = '<div class="board" id="board">';
  for (const c of cols) {
    h += `<section class="col" data-col-id="${esc(c.id)}" data-col-kind="${c.kind}">
      <div class="col-h"><span class="sw" style="background:${c.sw}"></span><span>${esc(c.title)}</span><span class="c">${c.ts.length}</span></div>
      <div class="col-body" data-drop="1">`;
    for (const t of c.ts) {
      const kd = sortFor(all.filter(x => x.parent === t.id));   // 서브태스크도 같은 기준을 따른다
      h += cardHtml(t, { list: kd, done: kd.filter(x => x.done).length });
    }
    h += `</div>`;
    if (c.kind === 'list') h += `<button class="col-add" data-add="${esc(c.id)}">${I.plus} 작업 추가</button>`;
    h += `</section>`;
  }
  return h + '</div>';
}

/* ── 상한 도달 알림 ────────────────────────────────────────────────────
   토스트가 아니라 배너다. 토스트는 지나가지만 이건 **지속되는 상태**라서, 사라지고 나면
   사용자는 자기가 보는 화면이 완전한 줄 안다. 잘린 목록 이름을 직접 말해 준다 —
   "일부 항목" 같은 말로는 어디를 정리해야 할지 알 수 없다. */
/** 은/는 — 마지막 글자에 받침이 있으면 '은'. "은(는)" 은 기계가 쓴 티가 난다. */
function josa(s, withBatchim, without) {
  const c = String(s).trim().slice(-1).charCodeAt(0);
  if (!(c >= 0xac00 && c <= 0xd7a3)) return without;   // 한글이 아니면 받침을 알 수 없다
  return (c - 0xac00) % 28 ? withBatchim : without;
}
function truncNotice() {
  const ids = Object.keys(S.trunc || {}).filter(k => S.trunc[k]);
  if (!ids.length) return '';
  const names = ids.map(id => (S.lists.find(l => l.id === id) || {}).title || id);
  const joined = names.join(', ');
  return `<div class="banner">목록 <b>${esc(joined)}</b>${josa(joined, '은', '는')} 항목이 ${PAGE_CAP}개를 넘어
    <b>일부만 받아왔습니다.</b> 화면에 보이지 않는 항목이 있습니다 —
    구글 태스크에서 오래된 완료 항목을 정리하면 전부 보입니다.</div>`;
}

function render() {
  renderSidebar();
  const ts = allTasks();
  const sel = filterTasks(ts);
  $('tbTitle').textContent = viewTitle();
  $('tbSub').textContent = sel.length ? `${sel.filter(t => !t.done).length}개` : '';
  $('boardBy').classList.toggle('hide', S.view !== 'board');
  /* 기본값(등록일순)이 아니면 버튼에 표시를 남긴다 — 정렬이 켜진 줄 모르고
     "왜 이 순서지?" 하는 상황을 막는다. */
  $('sortBtn').classList.toggle('tuned', S.sortBy !== 'manual' || S.showDone);
  $('sortBtn').title = '정렬: ' + SORT_LABEL[S.sortBy];
  renderAccount();

  const w = $('wrap');
  w.className = 'wrap' + (S.view === 'board' ? ' board-wrap' : '');
  w.classList.toggle('dnd-on', dndEnabled());
  /* 보드에서는 하단 추가 바를 숨긴다 — 컬럼마다 추가 버튼이 있어 중복이고,
     컬럼을 세로로 키운 만큼 가려지는 면적이 아깝다. Q 단축키는 그대로 동작한다. */
  $('addBar').classList.toggle('hide', S.view === 'board');
  if (S.view === 'board') {
    w.innerHTML = `<div class="hero"><h1>보드</h1><p>${BOARD_BY[S.boardBy]} · 컬럼 안은 ${SORT_LABEL[S.sortBy]} · 카드를 끌어 옮기면 ${
      S.boardBy === 'list' ? '목록이' : S.boardBy === 'priority' ? '우선순위가' : '기한이'} 바뀝니다</p></div>`
      + renderBoard(ts);
    if (S.detailKey) renderDetail();
    return;
  }
  let h = truncNotice();
  h += `<div class="hero"><h1>${esc(viewTitle())}</h1>`;
  if (S.view === 'today') { const n = new Date(); h += `<p>${n.getMonth() + 1}월 ${n.getDate()}일 ${DOW[n.getDay()]}요일</p>`; }
  else if (S.view === 'search') h += `<p>제목·메모·라벨에서 검색합니다</p>`;
  h += `</div>`;
  if (S.view === 'search') {
    h += `<div style="padding:0 4px 12px"><input id="searchInput" placeholder="검색어" value="${esc(S.search)}"
      style="width:100%;padding:11px 14px;border:1px solid var(--border);border-radius:11px;background:var(--surface);font-size:15px"></div>`;
  }

  if (!sel.length) {
    h += `<div class="empty">${I.empty}<p>${S.view === 'search' && !S.search ? '무엇을 찾으시나요?' : '표시할 작업이 없습니다'}</p>
      <div class="sm">${S.view === 'today' ? '오늘은 여유가 있네요.' : ''}</div></div>`;
  } else {
    // 부모-자식 정렬
    for (const g of groupTasks(sel)) {
      h += `<section class="sec">`;
      if (g.t) h += `<div class="sec-h"><span class="t ${g.cls || ''}">${esc(g.t)}</span><span class="c">${g.c}</span></div>`;
      const byId = new Map(g.ts.map(t => [t.id, t]));
      const rendered = new Set();
      for (const t of g.ts) {
        if (t.parent && byId.has(t.parent)) continue;
        h += taskRow(t, false); rendered.add(t.id);
        for (const c of g.ts) if (c.parent === t.id) { h += taskRow(c, true); rendered.add(c.id); }
      }
      for (const t of g.ts) if (!rendered.has(t.id)) h += taskRow(t, !!t.parent);
      h += `</section>`;
    }
  }
  w.innerHTML = h;
  if (S.view === 'search') {
    const si = $('searchInput');
    si.addEventListener('input', e => { S.search = e.target.value; clearTimeout(si._t); si._t = setTimeout(render, 160); });
    if (document.activeElement !== si) si.focus();
  }
  if (S.detailKey) renderDetail();
}

function taskRow(t, isSub) {
  const key = t.listId + '/' + t.id;
  const meta = [];
  if (t.due) meta.push(`<span class="chip ${dueClass(t.due)}">${I.cal}${esc(humanDate(t.due, t.time))}</span>`);
  else if (t.time) meta.push(`<span class="chip">${I.clock}${t.time}</span>`);
  if (t.rec) meta.push(`<span class="chip">${I.repeat}${esc(recLabel(t.rec))}</span>`);
  if (t.dur) meta.push(`<span class="chip">${I.hourglass}${t.dur >= 60 ? (t.dur / 60).toFixed(t.dur % 60 ? 1 : 0) + '시간' : t.dur + '분'}</span>`);
  for (const l of t.labels) meta.push(`<span class="lbl">@${esc(l)}</span>`);
  if ((S.view === 'today' || S.view === 'upcoming') && S.lists.length > 1)
    meta.push(`<span class="chip" style="opacity:.75">${esc(t.listTitle)}</span>`);
  return `<div class="task ${t.done ? 'done' : ''} ${isSub ? 'sub' : ''}" data-k="${key}">
    <button class="check p${t.p}" data-act="toggle">${I.check}</button>
    <div class="t-body" data-act="open">
      <div class="t-title">${esc(t.title) || '<span style="opacity:.45">제목 없음</span>'}</div>
      ${t.body ? `<div class="t-notes">${esc(t.body)}</div>` : ''}
      ${meta.length ? `<div class="t-meta">${meta.join('')}</div>` : ''}
    </div>
    <div class="t-act">
      <span class="grip" title="끌어서 이동">${I.grip}</span>
      <button data-act="today" title="오늘로">${I.today}</button>
      <button data-act="open" title="편집">${I.edit}</button>
    </div>
  </div>`;
}

function renderSidebar() {
  const ts = allTasks();
  const T = todayY();
  const cnt = {
    today: ts.filter(t => !t.done && t.due && diffDays(t.due, T) <= 0).length,
    upcoming: ts.filter(t => !t.done && t.due && diffDays(t.due, T) > 0 && diffDays(t.due, T) <= 60).length,
    all: ts.filter(t => !t.done).length
  };
  const nav = (v, ico, label, c) => `<button class="nav ${S.view === v ? 'active' : ''}" data-view="${v}">
    <span class="ico">${ico}</span><span class="nm">${esc(label)}</span>${c ? `<span class="ct">${c}</span>` : ''}</button>`;
  let h = `<div class="sb-group">
    ${nav('today', I.today, '오늘', cnt.today)}
    ${nav('upcoming', I.upcoming, '예정', cnt.upcoming)}
    ${nav('all', I.all, '전체', cnt.all)}
    ${nav('board', I.board, '보드', 0)}
    <button class="nav ai-nav" data-ai="1"><span class="ico">${I.spark}</span><span class="nm">AI 어시스턴트</span><kbd>A</kbd></button>
    ${nav('search', I.search, '검색', 0)}
    ${nav('done', I.done, '완료됨', 0)}
  </div>`;
  h += `<div class="sb-group"><div class="sb-label">목록<span class="spacer"></span><button id="newListBtn">${I.plus}</button></div>`;
  for (const l of S.lists) {
    const c = ts.filter(t => !t.done && t.listId === l.id).length;
    /* 목록 행에 더보기 버튼을 얹는다. nav 버튼 안에 버튼을 중첩할 수 없으므로
       래퍼로 감싸고 절대 위치로 올린다. */
    h += `<div class="list-row">${nav('list:' + l.id, I.list, l.title, c)}
      <button class="row-more" data-listmenu="${esc(l.id)}" title="목록 관리">${I.more}</button></div>`;
  }
  h += `</div>`;
  const labs = labelsOf(ts);
  if (labs.length) {
    h += `<div class="sb-group"><div class="sb-label">라벨</div>`;
    for (const [l, c] of labs.slice(0, 24)) h += nav('label:' + l, I.tag, l, c);
    h += `</div>`;
  }
  $('sbScroll').innerHTML = h;
}

/* ─────────────────────────── 11. 상세 패널 ─────────────────────────── */
function openDetail(key) { S.detailKey = key; $('detail').classList.add('on'); renderDetail(); }
function closeDetail() { S.detailKey = null; $('detail').classList.remove('on'); }
function currentDetail() {
  if (!S.detailKey) return null;
  const [listId, id] = S.detailKey.split('/');
  return allTasks().find(t => t.listId === listId && t.id === id) || null;
}
function renderDetail() {
  const t = currentDetail();
  if (!t) { closeDetail(); return; }
  $('dtList').textContent = t.listTitle;
  const P = ['', '긴급 P1', '높음 P2', '보통 P3', '없음 P4'];
  $('dtBody').innerHTML = `
    <textarea class="dt-title" id="dtTitle" rows="1">${esc(t.title)}</textarea>
    <textarea class="dt-notes" id="dtNotes" rows="3" placeholder="설명 추가">${esc(t.body)}</textarea>
    <div class="dt-row"><span class="k">마감</span><span class="v">
      <button class="pill" data-d="today">오늘</button>
      <button class="pill" data-d="tmr">내일</button>
      <button class="pill" data-d="week">다음주</button>
      <input type="date" id="dtDate" class="pill" value="${t.due || ''}" style="font-size:12.5px">
      ${t.due ? `<button class="pill x danger" data-d="clear">해제 <b>×</b></button>` : ''}
    </span></div>
    <div class="dt-row"><span class="k">시간</span><span class="v">
      <input type="time" id="dtTime" class="pill" value="${t.time || ''}" style="font-size:12.5px">
      ${t.time ? `<button class="pill x danger" data-d="notime">해제 <b>×</b></button>` : ''}
    </span></div>
    <div class="dt-row"><span class="k">우선순위</span><span class="v">
      ${[1, 2, 3, 4].map(p => `<button class="pill" data-p="${p}" style="${t.p === p ? `border-color:var(--p${p});color:var(--p${p});font-weight:600` : ''}">
        <span style="color:var(--p${p})">${I.flag}</span>${P[p]}</button>`).join('')}
    </span></div>
    <div class="dt-row"><span class="k">반복</span><span class="v">
      ${['매일', '평일마다', '매주', '매월', '해제'].map(x => `<button class="pill" data-r="${x}"
        style="${recLabel(t.rec) === x ? 'border-color:var(--accent);color:var(--accent)' : ''}">${x}</button>`).join('')}
      ${t.rec ? `<span class="pill" style="background:var(--accent-soft);color:var(--accent);border-color:transparent">${I.repeat}${esc(recLabel(t.rec))}</span>` : ''}
    </span></div>
    <div class="dt-row"><span class="k">라벨</span><span class="v">
      ${t.labels.map(l => `<button class="pill x" data-lx="${esc(l)}">@${esc(l)} <b>×</b></button>`).join('')}
      <button class="pill" id="addLabel">${I.plus} 추가</button>
    </span></div>
    <div class="dt-row"><span class="k">상위 항목</span><span class="v">
      <select class="pill" id="dtParent" style="max-width:100%">
        <option value="">— 없음 (최상위) —</option>
        ${(S.tasks[t.listId] || []).filter(x => !x.parent && x.id !== t.id && !x.deleted)
          .map(x => `<option value="${esc(x.id)}"${t.parent === x.id ? ' selected' : ''}>${esc(x.title || '제목 없음')}</option>`).join('')}
      </select>
      <button class="pill" data-h="in">${I.indent} 바로 위 항목 아래로</button>
      <button class="pill" data-h="out"${t.parent ? '' : ' disabled style="opacity:.45"'}>${I.outdent} 최상위로</button>
    </span></div>
    <div class="dt-row"><span class="k">목록</span><span class="v">
      ${S.lists.map(l => `<button class="pill" data-move="${l.id}"
        style="${l.id === t.listId ? 'border-color:var(--accent);color:var(--accent)' : ''}">${esc(l.title)}</button>`).join('')}
    </span></div>`;
  const ta = $('dtTitle'), na = $('dtNotes');
  [ta, na].forEach(el => { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px';
    el.addEventListener('input', () => { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }); });
  ta.addEventListener('blur', () => { if (ta.value !== t.title) patchTask(t, { title: ta.value }); });
  na.addEventListener('blur', () => { if (na.value !== t.body) patchTask(t, { notes: encodeNotes(na.value, t) }); });
  $('dtDate').addEventListener('change', e => patchTask(t, { due: ymdToDue(e.target.value) }));
  $('dtParent').addEventListener('change', e => {
    const v = e.target.value;
    if (!v) outdentTask(t); else nestUnder(t, t.listId + '/' + v);
  });
  $('dtTime').addEventListener('change', e => updateMeta(t, { time: e.target.value || null }));
  $('addLabel').addEventListener('click', () => {
    const v = prompt('라벨 이름'); if (v && v.trim()) updateMeta(t, { labels: [...t.labels, v.trim()] });
  });
}
function onDetailClick(e) {
    const t = currentDetail(); if (!t) return;
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.d === 'today') patchTask(t, { due: ymdToDue(todayY()) });
    else if (b.dataset.d === 'tmr') patchTask(t, { due: ymdToDue(addDays(todayY(), 1)) });
    else if (b.dataset.d === 'week') patchTask(t, { due: ymdToDue(nextWeekday(1, true)) });
    else if (b.dataset.d === 'clear') patchTask(t, { due: null });
    else if (b.dataset.d === 'notime') updateMeta(t, { time: null });
    else if (b.dataset.p) updateMeta(t, { p: +b.dataset.p });
    else if (b.dataset.lx) updateMeta(t, { labels: t.labels.filter(x => x !== b.dataset.lx) });
    else if (b.dataset.r) {
      const map = { '매일': { type: 'day', interval: 1 }, '평일마다': { type: 'weekday', interval: 1 },
        '매주': { type: 'week', interval: 1, days: t.due ? [fromYmd(t.due).getDay()] : [] },
        '매월': { type: 'month', interval: 1 }, '해제': null };
      updateMeta(t, { rec: map[b.dataset.r] });
    } else if (b.dataset.move && b.dataset.move !== t.listId) moveToList(t, b.dataset.move);
    else if (b.dataset.h === 'in') indentTask(t);
    else if (b.dataset.h === 'out') outdentTask(t);
}
/* ─────────────────────────── 9.5 이동 엔진 ───────────────────────────
   Google Tasks 의 tasks.move 는 parent / previous / destinationTasklist 를 받는다.
   → 계층 변경, 순서 변경, 목록 간 이동이 모두 같은 호출로 처리되며 태스크 ID 가 보존된다.

   지켜야 할 규칙
   1) 중첩은 1단계까지만. 서브태스크를 부모로 지정하면 그 부모로 승격시킨다.
   2) 자식이 있는 태스크를 서브태스크로 내리면, 자식은 2단계가 되므로
      같은 부모의 형제로 함께 붙인다.
   3) previous 는 "같은 부모를 가진 직전 형제" 여야 한다. 드롭 위치에서 계산한 값을
      그대로 보내지 않고 대상 배열에서 정규화한다.                                   */

/** @param opt {{parentId?:string|null, previousId?:string|null, destList?:string}}
 *  undefined = 유지, null = 해제(최상위) 또는 맨 앞 */
function applyMove(t, opt) {
  const loc = locate(t);
  if (!loc) { toast('항목을 찾을 수 없습니다. 새로고침해 주세요'); render(); return; }
  const srcList = loc.listId;
  const destList = opt.destList || srcList;
  const src = S.tasks[srcList];
  const raw = src[loc.i];
  if (String(raw.id).startsWith('tmp_') && destList !== srcList) {
    toast('아직 동기화되지 않은 항목입니다. 잠시 후 다시 시도하세요'); return;
  }

  let parentId = opt.parentId === undefined ? (raw.parent || null) : opt.parentId;
  if (parentId === raw.id) parentId = null;
  if (parentId) {
    const p = rawOf(destList, parentId);
    if (!p) parentId = null;
    else if (p.parent) parentId = p.parent;              // 규칙 1
  }
  if (parentId === raw.id) parentId = null;

  const kids = kidsOf(srcList, raw.id);
  const kidParent = parentId ? parentId : raw.id;        // 규칙 2
  const previousId = opt.previousId;

  /* ── 낙관적 로컬 반영 ── */
  const moving = [raw, ...kids];
  const movingIds = new Set(moving.map(x => x.id));
  const srcRest = (S.tasks[srcList] || []).filter(x => !movingIds.has(x.id));
  S.tasks[srcList] = srcRest;
  const dest = destList === srcList
    ? srcRest
    : (S.tasks[destList] || []).filter(x => !movingIds.has(x.id));

  if (parentId) raw.parent = parentId; else delete raw.parent;
  for (const k of kids) k.parent = kidParent;

  let at;
  if (previousId === undefined) at = dest.length;
  else if (previousId === null) at = parentId ? dest.findIndex(x => x.id === parentId) + 1 : 0;
  else {
    const pi = dest.findIndex(x => x.id === previousId);
    at = pi < 0 ? dest.length : pi + 1;
    while (at < dest.length && dest[at].parent === previousId) at++;   // 그 태스크의 자식들 뒤로
  }
  dest.splice(at, 0, ...moving);
  S.tasks[destList] = dest;

  /* ── previous 정규화 (규칙 3) ── */
  const idx = dest.findIndex(x => x.id === raw.id);
  let prevSib = null;
  for (let j = idx - 1; j >= 0; j--) {
    const c = dest[j];
    if (parentId && c.id === parentId) break;            // 부모 바로 아래 첫 자리
    if ((c.parent || null) === (parentId || null)) { prevSib = c.id; break; }
  }

  save();
  enqueue({ k: 'move', listId: srcList, id: raw.id, parent: parentId || null, previous: prevSib,
            destinationTasklist: destList !== srcList ? destList : null });
  let prevKid = parentId ? raw.id : null;
  for (const k of kids) {
    enqueue({ k: 'move', listId: srcList, id: k.id, parent: kidParent, previous: prevKid,
              destinationTasklist: destList !== srcList ? destList : null });
    prevKid = k.id;
  }
  render();
}

/** 지정한 태스크의 서브태스크로 만든다. 다른 목록의 항목이면 그 목록으로 함께 옮긴다. */
function nestUnder(t, parentKey) {
  const parent = taskByKey(parentKey);
  if (!parent || parent.id === t.id) { render(); return; }
  if (parent.parent) { toast('서브태스크 아래에는 넣을 수 없습니다 (중첩 1단계)'); render(); return; }
  const kids = kidsOf(parent.listId, parent.id).filter(k => k.id !== t.id);
  applyMove(t, {
    parentId: parent.id,
    previousId: kids.length ? kids[kids.length - 1].id : null,
    destList: parent.listId !== t.listId ? parent.listId : undefined
  });
  toast(`"${parent.title}" 의 서브태스크가 되었습니다`, '실행 취소',
    () => applyMove(taskByKey(t.listId + '/' + t.id) || t, { parentId: null, previousId: parent.id }));
}

/** 상세 패널 버튼용 — 바로 위 같은 레벨 태스크의 서브태스크로 내린다 */
function indentTask(t) {
  const arr = S.tasks[t.listId] || [];
  const i = arr.findIndex(x => x.id === t.id);
  let target = null;
  for (let j = i - 1; j >= 0; j--) { if (!arr[j].parent) { target = arr[j]; break; } }
  if (!target || target.id === t.id) { toast('위에 상위로 삼을 항목이 없습니다'); return; }
  applyMove(t, { parentId: target.id, previousId: undefined });
  toast('서브태스크로 이동했습니다');
}
function outdentTask(t) {
  if (!t.parent) { toast('이미 최상위 항목입니다'); return; }
  applyMove(t, { parentId: null, previousId: t.parent });
  toast('최상위로 올렸습니다');
}
function moveToList(t, toList) {
  if (toList === t.listId) return;
  if (t.rec) { toast('반복 항목은 목록 간 이동이 제한됩니다'); }
  applyMove(t, { destList: toList, parentId: null, previousId: undefined });
  const l = S.lists.find(x => x.id === toList);
  toast(`${l ? l.title : '목록'}(으)로 이동했습니다`);
}

/* ─────────────────────────── 12. 컴포저 ─────────────────────────── */
let cmpList = null;
function openComposer(prefill, listId) {
  cmpList = listId || (S.view.startsWith('list:') ? S.view.slice(5) : defaultListId());
  $('cmpInput').value = prefill || '';
  $('cmpNotes').value = '';
  $('composer').classList.add('on');
  updateComposer();
  setTimeout(() => $('cmpInput').focus(), 30);
}
function closeComposer() { $('composer').classList.remove('on'); }
function updateComposer() {
  const raw = $('cmpInput').value;
  const p = parseInput(raw, S.lists);
  if (p.listId) cmpList = p.listId;
  const tags = [];
  if (p.due) tags.push(['a', I.cal, humanDate(p.due, p.time)]);
  else if (p.time) tags.push(['a', I.clock, p.time]);
  if (p.rec) tags.push(['a', I.repeat, recLabel(p.rec)]);
  if (p.p < 4) tags.push(['a', `<span style="color:var(--p${p.p})">${I.flag}</span>`, 'P' + p.p]);
  for (const l of p.labels) tags.push(['', I.tag, l]);
  if (p.dur) tags.push(['', I.hourglass, p.dur + '분']);
  $('cmpParse').innerHTML = tags.map(([c, i, t]) => `<span class="ptag ${c}">${i}${esc(t)}</span>`).join('');
  const l = S.lists.find(x => x.id === cmpList);
  $('listSel').innerHTML = `${I.list}<span>${esc(l ? l.title : '목록 선택')}</span>${I.chev}`;
  $('cmpSave').disabled = !p.title.trim();
  $('cmpHint').innerHTML = raw.trim() ? `<b style="font-weight:600">${esc(p.title || '…')}</b>`
    : `<code>내일</code> <code>다음주 월</code> <code>3일 후</code> <code>8/30</code> · <code>오후 3시</code> <code>14:30</code> · <code>p1</code> · <code>@라벨</code> <code>#목록</code> · <code>매일</code> <code>매주 월</code> <code>평일마다</code>`;
}
function submitComposer() {
  const p = parseInput($('cmpInput').value, S.lists);
  if (!p.title.trim()) return;
  createTask({ ...p, body: $('cmpNotes').value.trim(), listId: p.listId || cmpList });
  $('cmpInput').value = ''; $('cmpNotes').value = '';
  updateComposer(); $('cmpInput').focus();
  toast('추가됨');
}

/* ─────────────────────────── 13. 토스트 ─────────────────────────── */
let toastTimer;
function toast(msg, actLabel, act) {
  $('toastMsg').textContent = msg;
  const b = $('toastAct');
  b.classList.toggle('hide', !actLabel);
  if (actLabel) { b.textContent = actLabel; b.onclick = () => { act && act(); hideToast(); }; }
  $('toast').classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, actLabel ? 5200 : 2000);
}
const hideToast = () => $('toast').classList.remove('on');

/* ─────────────────────────── 14. 이벤트 ─────────────────────────── */
/** 정렬 기준 변경 — 앱 전체에 즉시 적용되고 다음 실행에도 유지된다. */
/** 목록 행의 더보기 메뉴 — 이름 변경 / 삭제 */
function openListMenu(anchor, listId) {
  const old = document.querySelector('.menu'); if (old) { old.remove(); return; }
  const l = S.lists.find(x => x.id === listId); if (!l) return;
  const n = (S.tasks[listId] || []).filter(t => !t.deleted).length;
  const last = S.lists.length <= 1;
  const m = document.createElement('div');
  m.className = 'menu up right'; m.id = 'listMenu';
  m.innerHTML =
    `<button data-act="rename">${I.pencil}이름 변경</button>` +
    `<div class="sepline"></div>` +
    `<button data-act="del" class="danger"${last ? ' disabled style="opacity:.45"' : ''}>${I.trash}` +
    `목록 삭제${n ? ` (태스크 ${n}건)` : ''}</button>`;
  m.onclick = ev => {
    const b = ev.target.closest('[data-act]'); if (!b) return;
    m.remove();
    if (b.dataset.act === 'rename') {
      const t = prompt('목록 이름', l.title);
      if (t !== null && t.trim()) renameList(listId, t.trim());
    } else if (!last) deleteListFlow(listId);
  };
  anchor.parentNode.appendChild(m);
  setTimeout(() => document.addEventListener('click', () => m.remove(), { once: true }), 0);
}

function setSort(k) {
  if (!SORT_KEYS.includes(k) || k === S.sortBy) return;
  S.sortBy = k; store.set(LS.sortBy, k);
  /* 순서 드래그가 방금 꺼졌다면 왜 안 되는지 알려 준다 — 말없이 안 되는 쪽이 더 나쁘다. */
  toast(SORT_LABEL[k] + (k === 'manual' ? '' : ' · 순서 드래그는 등록일순에서만'));
  render();
}
function setView(v) {
  S.view = v; store.set(LS.view, v);
  if (v === 'search') S.search = '';
  $('sidebar').classList.remove('on'); $('scrim').classList.remove('on');
  $('scroller').scrollTop = 0;
  render();
}
function wire() {
  $('menuBtn').innerHTML = I.menu; $('syncBtn').innerHTML = I.sync;
  $('themeBtn').innerHTML = I.theme; $('sortBtn').innerHTML = I.sort;
  $('skinBtn').innerHTML = I.skin;
  $('dtClose').innerHTML = I.close; $('dtDelete').innerHTML = I.trash;

  $('menuBtn').onclick = () => { $('sidebar').classList.add('on'); $('scrim').classList.add('on'); };
  $('scrim').onclick = () => { $('sidebar').classList.remove('on'); $('scrim').classList.remove('on'); };
  $('syncBtn').onclick = () => fullSync(true);      // 새로고침 버튼은 사용자의 명시적 요청
  /* 계정 전환 — prompt:'select_account' 로 계정 선택 화면을 강제한다.
     캐시된 토큰·태스크를 먼저 비우지 않으면 이전 계정의 데이터가 남아 섞인다. */
  $('sbAcctSwitch').onclick = () => {
    tokenStore.clear(); S.token = null; S.tokenExp = 0;
    S.tasks = {}; S.lists = []; S.account = ''; S.lastSync = 0; S.listsAt = 0;
    store.set(LS.account, ''); store.set(LS.defaultList, ''); save(); render();
    if (!S.client) return initAuth();
    S.silentTry = false;
    try { S.client.requestAccessToken({ prompt: 'select_account' }); }
    catch (e) { showAuth('계정 선택 창을 열지 못했습니다.'); }
  };
  $('themeBtn').onclick = () => {
    const cur = document.documentElement.getAttribute('data-theme') || '';
    const next = cur === '' ? 'dark' : cur === 'dark' ? 'light' : '';
    if (next) document.documentElement.setAttribute('data-theme', next);
    else document.documentElement.removeAttribute('data-theme');
    store.set(LS.theme, next);
    toast(next === 'dark' ? '다크 모드' : next === 'light' ? '라이트 모드' : '시스템 설정 따름');
  };
  /* 스킨은 테마와 별개 축이다. 야상은 어두운 팔레트로 설계돼 있어
     선택하면 테마 설정과 무관하게 어둡게 간다 — 그 점을 토스트로 알린다. */
  $('skinBtn').onclick = () => {
    const next = document.documentElement.getAttribute('data-skin') === 'nocturne' ? '' : 'nocturne';
    applySkin(next);
    store.set(LS.skin, next);
    toast(next ? '야상 — 테마 설정과 무관하게 어둡습니다' : '기본 모양');
  };
  $('boardBy').innerHTML = I.board;
  $('boardBy').onclick = () => {
    const order = ['list', 'priority', 'due'];
    S.boardBy = order[(order.indexOf(S.boardBy) + 1) % order.length];
    store.set(LS.boardBy, S.boardBy);
    toast('컬럼 기준: ' + BOARD_BY[S.boardBy]); render();
  };
  /* 정렬 기준 + 완료 표시를 한 메뉴에 모은다. 버튼 하나를 돌려 쓰는 방식은 값이 4개가
     되면서 몇 번을 눌러야 하는지 알 수 없어졌다 — 상태가 보이는 메뉴로 바꾼다. */
  $('sortBtn').onclick = e => {
    e.stopPropagation();
    const old = document.querySelector('.menu'); if (old) { old.remove(); return; }
    const m = document.createElement('div');
    m.className = 'menu up right'; m.id = 'sortMenu';
    m.innerHTML = '<div class="caption">정렬 기준</div>'
      + SORT_KEYS.map(k => `<button data-sort="${k}" class="${k === S.sortBy ? 'on' : ''}">`
          + `${k === S.sortBy ? I.check : '<span class="gap"></span>'}${SORT_LABEL[k]}</button>`).join('')
      + '<div class="sepline"></div>'
      + `<button data-done="1" class="${S.showDone ? 'on' : ''}">`
      + `${S.showDone ? I.check : '<span class="gap"></span>'}완료 항목 표시</button>`;
    m.onclick = ev => {
      const s = ev.target.closest('[data-sort]');
      if (s) setSort(s.dataset.sort);
      else if (ev.target.closest('[data-done]')) {
        S.showDone = !S.showDone; store.set(LS.showDone, S.showDone ? '1' : '0');
        toast(S.showDone ? '완료 항목 표시' : '완료 항목 숨김'); render();
      }
      m.remove();
    };
    $('sortBtn').parentNode.appendChild(m);
    setTimeout(() => document.addEventListener('click', () => m.remove(), { once: true }), 0);
  };

  $('sbScroll').addEventListener('click', e => {
    /* 더보기 버튼은 목록 행 **위에** 얹혀 있으므로 뷰 전환보다 먼저 가로챈다. */
    const more = e.target.closest('[data-listmenu]');
    if (more) { e.stopPropagation(); return openListMenu(more, more.dataset.listmenu); }
    const n = e.target.closest('[data-view]'); if (n) return setView(n.dataset.view);
    if (e.target.closest('#newListBtn')) { const t = prompt('새 목록 이름'); if (t && t.trim()) createList(t.trim()); }
  });

  $('wrap').addEventListener('click', e => {
    if (DND.moved) { DND.moved = false; return; }           // 드래그 직후의 클릭은 무시
    const add = e.target.closest('[data-add]');
    if (add) { openComposer('', add.dataset.add); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'fold') {
      const card = e.target.closest('.card');
      const id = card.dataset.k.split('/')[1];
      if (S.collapsed.has(id)) S.collapsed.delete(id); else S.collapsed.add(id);
      store.set(LS.collapsed, JSON.stringify([...S.collapsed]));
      card.querySelector('.card-subs').classList.toggle('hide');
      card.querySelector('.sub-head').classList.toggle('folded');
      return;
    }
    const row = e.target.closest('.sub-row, .task, .card'); if (!row) return;
    const t = taskByKey(row.dataset.k); if (!t) return;
    if (act === 'toggle') { row.classList.toggle('done'); toggleDone(t); }
    else if (act === 'today') patchTask(t, { due: ymdToDue(todayY()) });
    else if (act === 'open') openDetail(row.dataset.k);
    else if (row.classList.contains('card') || row.classList.contains('sub-row')) openDetail(row.dataset.k);
  });

  $('scroller').addEventListener('scroll', e => {
    $('topbar').classList.toggle('scrolled', e.target.scrollTop > 4);
  });

  $('addTrigger').onclick = () => openComposer();
  $('cmpCancel').onclick = closeComposer;
  $('cmpSave').onclick = submitComposer;
  $('cmpInput').addEventListener('input', e => {
    e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; updateComposer();
  });
  $('cmpNotes').addEventListener('input', e => { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; });
  $('composer').addEventListener('mousedown', e => { if (e.target.id === 'composer') closeComposer(); });
  $('listSel').onclick = e => {
    e.stopPropagation();
    const old = document.querySelector('.menu'); if (old) return old.remove();
    const m = document.createElement('div'); m.className = 'menu';
    m.innerHTML = S.lists.map(l => `<button data-l="${l.id}" class="${l.id === cmpList ? 'on' : ''}">${I.list}${esc(l.title)}</button>`).join('');
    m.onclick = ev => { const b = ev.target.closest('[data-l]'); if (b) { cmpList = b.dataset.l; updateComposer(); } m.remove(); };
    $('listSel').parentNode.appendChild(m);
    setTimeout(() => document.addEventListener('click', () => m.remove(), { once: true }), 0);
  };

  $('dtClose').onclick = closeDetail;
  $('dtDelete').onclick = () => { const t = currentDetail(); if (t) deleteTask(t); };
  $('dtBody').addEventListener('click', onDetailClick);

  $('authBtn').onclick = () => {
    const v = $('cidInput').value.trim();
    if (v && v !== S.clientId) { S.clientId = v; store.set(LS.cid, v); S.client = null; }
    if (!S.clientId) { showAuth('클라이언트 ID가 필요합니다.', true); return; }
    if (!S.client) initAuth(); else requestToken(false);
  };
  $('cidInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('authBtn').click(); });
  /* 기본 클라이언트 ID 가 있으면 입력란을 숨겨 두되, 바꿀 길은 남긴다. */
  $('cidToggle').onclick = () => {
    const f = $('cidField'), hidden = f.classList.contains('hide');
    f.classList.toggle('hide', !hidden);
    $('cidToggle').textContent = hidden ? '기본 클라이언트 ID 쓰기' : '클라이언트 ID 변경';
    if (hidden) $('cidInput').focus();
    else { $('cidInput').value = S.clientId = DEFAULT_CLIENT_ID; store.set(LS.cid, DEFAULT_CLIENT_ID); S.client = null; }
  };

  document.addEventListener('keydown', e => {
    const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName);
    if (e.key === 'Escape') {
      if ($('composer').classList.contains('on')) return closeComposer();
      if (S.detailKey) return closeDetail();
      document.activeElement?.blur();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && $('composer').classList.contains('on')) { e.preventDefault(); submitComposer(); return; }
    if (e.key === 'Enter' && !e.shiftKey && document.activeElement === $('cmpInput')) { e.preventDefault(); submitComposer(); return; }
    if (typing) return;
    if (e.key === 'q' || e.key === 'ㅂ') { e.preventDefault(); openComposer(); }
    if (e.key === '/') { e.preventDefault(); setView('search'); }
    if (e.key === 'r') fullSync(true);              // R 키도 마찬가지
    if (e.key === '1') setView('today');
    if (e.key === '2') setView('upcoming');
    if (e.key === '3') setView('all');
    if (e.key === '4') setView('board');
  });

  /* 탭으로 돌아올 때마다 전량 조회하면 창을 몇 번 옮기는 것만으로 쿼터가 녹는다.
     fullSync 안에서 SYNC_MIN_GAP 으로 걸러지므로 여기서는 그냥 부르기만 하면 된다. */
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.booted) fullSync(); });
  setInterval(() => { if (!document.hidden && S.booted) fullSync(); }, SYNC_EVERY);
  window.addEventListener('online', () => flush());
}

/* ─────────────────────────── 15. 시작 ─────────────────────────── */
/** 스킨 적용. 테마(data-theme)와 별개 축이라 서로 지우지 않는다. */
function applySkin(v) {
  const el = document.documentElement;
  if (v === 'nocturne') el.setAttribute('data-skin', 'nocturne');
  else el.removeAttribute('data-skin');
  /* iOS 상태바 색까지 맞춰야 홈 화면 앱에서 위쪽 띠가 튀지 않는다 */
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => {
    if (v === 'nocturne') { m.dataset.orig = m.dataset.orig || m.content; m.content = '#15171b'; }
    else if (m.dataset.orig) m.content = m.dataset.orig;
  });
}

const th = store.get(LS.theme); if (th && !DEMO) document.documentElement.setAttribute('data-theme', th);
const sk = store.get(LS.skin); if (sk && !DEMO) applySkin(sk);
wire();
render();
initAuth();
if (!DEMO && 'serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
