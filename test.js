/* Saydo core 단위 테스트 — node test.js */
const C = require('./core.js');
let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`  ✗ ${name}\n      got  ${g}\n      want ${w}`); }
};
const T = C.todayY();
const D = n => C.addDays(T, n);

console.log('\n[1] 날짜 유틸');
eq('addDays +1', C.diffDays(D(1), T), 1);
eq('addMonths 1/31 +1 → 2월 말', C.addMonths('2026-01-31', 1), '2026-02-28');
eq('addMonths 연말 넘김', C.addMonths('2026-12-15', 1), '2027-01-15');
eq('dueToYmd 타임존 무변환', C.dueToYmd('2026-08-27T00:00:00.000Z'), '2026-08-27');
eq('ymdToDue', C.ymdToDue('2026-08-27'), '2026-08-27T00:00:00.000Z');

console.log('[2] 메타 인코딩 라운드트립');
const cases = [
  { body: '검증 점검 메모', meta: { p: 1, labels: ['검증', '긴급 건'], time: '14:30', rec: { type: 'week', interval: 1, days: [1] }, dur: 30 } },
  { body: '', meta: { p: 4, labels: [], time: null, rec: null, dur: null } },
  { body: '여러 줄\n메모입니다', meta: { p: 3, labels: [], time: null, rec: { type: 'weekday', interval: 1 }, dur: null } },
  { body: '설명', meta: { p: 2, labels: ['a'], time: '09:00', rec: { type: 'month', interval: 2 }, dur: 90 } },
];
for (const [i, c] of cases.entries()) {
  const enc = C.encodeNotes(c.body, c.meta);
  const dec = C.decodeNotes(enc);
  eq(`case${i} body`, dec.body, c.body);
  eq(`case${i} p`, dec.meta.p, c.meta.p);
  eq(`case${i} labels`, dec.meta.labels, c.meta.labels);
  eq(`case${i} time`, dec.meta.time, c.meta.time);
  eq(`case${i} rec`, dec.meta.rec, c.meta.rec);
  eq(`case${i} dur`, dec.meta.dur, c.meta.dur);
}
eq('메타 없는 순수 notes 보존', C.decodeNotes('그냥 메모').body, '그냥 메모');
eq('빈 메타는 블록 미생성', C.encodeNotes('x', { p: 4, labels: [] }), 'x');
eq('본문 없이 메타만', C.decodeNotes(C.encodeNotes('', { p: 1, labels: [] })).body, '');
// 사용자가 Google Tasks 앱에서 본문 뒤에 글을 덧붙인 경우 → 메타는 마지막 줄이 아니므로 본문으로 흡수(무손실)
eq('메타 뒤 사용자 추가분', C.decodeNotes('a\n\n⟦p1⟧\n나중에 적은 글').meta.p, 4);

console.log('[3] 반복 규칙');
eq('매일', C.nextDue(T, { type: 'day', interval: 1 }), D(1));
eq('3일마다', C.nextDue(T, { type: 'day', interval: 3 }), D(3));
eq('매월', C.nextDue('2026-01-31', { type: 'month', interval: 1 }), C.addMonths(T, 1));
eq('평일마다 → 주말 건너뜀', [0, 6].includes(C.fromYmd(C.nextDue(T, { type: 'weekday', interval: 1 })).getDay()), false);
eq('매주 월 → 월요일', C.fromYmd(C.nextDue(T, { type: 'week', interval: 1, days: [1] })).getDay(), 1);
eq('지연된 반복은 오늘 기준 재계산', C.diffDays(C.nextDue(D(-30), { type: 'day', interval: 1 }), T), 1);
eq('serRec/parseRec 라운드트립', C.parseRec(C.serRec({ type: 'week', interval: 2, days: [1, 3] })), { type: 'week', interval: 2, days: [1, 3] });
eq('recLabel 평일', C.recLabel({ type: 'weekday', interval: 1 }), '평일마다');

console.log('[4] 자연어 파서');
const L = [{ id: 'L1', title: '업무' }, { id: 'L2', title: '개인' }];
const p = s => C.parseInput(s, L);

let r = p('내일 오후 3시 배포 파이프라인 점검 p1 @검증 매주 월');
eq('제목 정제', r.title, '배포 파이프라인 점검');
eq('due 내일', r.due, D(1));
eq('시간 15:00', r.time, '15:00');
eq('우선순위', r.p, 1);
eq('라벨', r.labels, ['검증']);
eq('반복 매주 월', r.rec, { type: 'week', interval: 1, days: [1] });

r = p('오늘 14:30 임원회의');
eq('24h 시간', r.time, '14:30'); eq('오늘', r.due, T); eq('제목', r.title, '임원회의');

r = p('3일 후 보고서 초안 !2');
eq('N일 후', r.due, D(3)); eq('! 우선순위', r.p, 2); eq('제목', r.title, '보고서 초안');

r = p('8/30 정산 마감');
eq('M/D', r.due.slice(5), '08-30'); eq('제목', r.title, '정산 마감');

r = p('평일마다 스탠드업 오전 9시 30분 @팀 @데일리');
eq('평일 반복', r.rec.type, 'weekday');
eq('오전 9:30', r.time, '09:30');
eq('라벨 2개', r.labels, ['팀', '데일리']);
eq('시간만 있으면 오늘로', r.due, T);
eq('제목', r.title, '스탠드업');

r = p('#개인 치과 예약 다음주 화');
eq('#목록 매칭', r.listId, 'L2');
eq('다음주 화 요일', C.fromYmd(r.due).getDay(), 2);
eq('다음주는 7일 이상 뒤', C.diffDays(r.due, T) >= 2, true);
eq('제목', r.title, '치과 예약');

r = p('#없는목록 그냥 할일');
eq('매칭 실패 시 토큰 유지', r.listId, null);

r = p('월말 마감 정리 30분 소요');
eq('월말', C.fromYmd(r.due).getMonth(), new Date().getMonth());
eq('소요시간', r.dur, 30);

r = p('2시간 소요 워크숍 준비 매월 1일');
eq('시간 → 분 환산', r.dur, 120);
eq('매월 N일 반복', r.rec.type, 'month');
eq('매월 1일 → 날짜 1일', C.fromYmd(r.due).getDate(), 1);

r = p('그냥 평범한 할 일');
eq('평문은 그대로', r.title, '그냥 평범한 할 일');
eq('평문 due 없음', r.due, null);
eq('평문 기본 우선순위', r.p, 4);

r = p('이메일 주소 test@example.com 확인');
eq('단어 중간의 @ 는 라벨로 오인하지 않음', r.labels, []);
eq('이메일 주소 보존', r.title, '이메일 주소 test@example.com 확인');

r = p('p10 개 구매');
eq('p10 은 우선순위가 아님', r.p, 4);

console.log('[5] 표시 문자열');
eq('오늘', C.humanDate(T), '오늘');
eq('내일 + 시간', C.humanDate(D(1), '15:00'), '내일 15:00');
eq('지연 클래스', C.dueClass(D(-1)), 'due-over');
eq('오늘 클래스', C.dueClass(T), 'due-today');

console.log(`\n결과: ${pass} pass, ${fail} fail\n`);
process.exit(fail ? 1 : 0);
