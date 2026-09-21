/* ==========================================================================
   Malro core — 순수 로직 (날짜 · 메타 인코딩 · 자연어 파서)
   브라우저에서는 전역 스크립트로, Node 에서는 require 로 테스트 가능.
   ========================================================================== */
'use strict';

const META_OPEN = '⟦', META_CLOSE = '⟧';
const META_RE = /\n?⟦([^⟧]*)⟧\s*$/;
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

/* ─────────────────────────── 1. 날짜 유틸 ─────────────────────────── */
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayY = () => ymd(new Date());
function fromYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(s, n) { const d = fromYmd(s); d.setDate(d.getDate() + n); return ymd(d); }
function addMonths(s, n) { const d = fromYmd(s); const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); return ymd(d); }
function diffDays(a, b) { return Math.round((fromYmd(a) - fromYmd(b)) / 864e5); }
function dueToYmd(due) { return due ? due.slice(0, 10) : null; }          // 타임존 변환 금지
function ymdToDue(s) { return s ? `${s}T00:00:00.000Z` : null; }

function humanDate(y, time) {
  if (!y) return '';
  const d = diffDays(y, todayY()), dt = fromYmd(y);
  let s;
  if (d === 0) s = '오늘';
  else if (d === 1) s = '내일';
  else if (d === -1) s = '어제';
  else if (d > 1 && d < 7) s = `${DOW[dt.getDay()]}요일`;
  else if (d < 0) s = `${dt.getMonth() + 1}월 ${dt.getDate()}일`;
  else s = `${dt.getMonth() + 1}월 ${dt.getDate()}일 (${DOW[dt.getDay()]})`;
  return time ? `${s} ${time}` : s;
}
function dueClass(y) {
  if (!y) return '';
  const d = diffDays(y, todayY());
  return d < 0 ? 'due-over' : d === 0 ? 'due-today' : d <= 2 ? 'due-soon' : '';
}

/* ─────────────────────────── 2. 메타 인코딩 ─────────────────────────── */
/** notes 문자열 → { body, meta } */
function decodeNotes(notes) {
  const meta = { p: 4, labels: [], time: null, rec: null, dur: null };
  if (!notes) return { body: '', meta };
  const m = notes.match(META_RE);
  if (!m) return { body: notes, meta };
  for (const tok of m[1].split(/\s+/).filter(Boolean)) {
    if (/^p[1-4]$/.test(tok)) meta.p = +tok[1];
    else if (tok[0] === '@') meta.labels.push(tok.slice(1).replace(/_/g, ' '));
    else if (tok[0] === '⏰') meta.time = tok.slice(1);
    else if (tok[0] === '↻') meta.rec = parseRec(tok.slice(1));
    else if (tok[0] === '⏳') meta.dur = +tok.slice(1) || null;
  }
  return { body: notes.slice(0, m.index).replace(/\s+$/, ''), meta };
}
/** { body, meta } → notes 문자열 */
function encodeNotes(body, meta) {
  const t = [];
  if (meta.p && meta.p < 4) t.push('p' + meta.p);
  for (const l of meta.labels || []) t.push('@' + l.replace(/\s+/g, '_'));
  if (meta.time) t.push('⏰' + meta.time);
  if (meta.rec) t.push('↻' + serRec(meta.rec));
  if (meta.dur) t.push('⏳' + meta.dur);
  const base = (body || '').replace(/\s+$/, '');
  if (!t.length) return base;
  return (base ? base + '\n\n' : '') + META_OPEN + t.join(' ') + META_CLOSE;
}
function serRec(r) {
  if (r.type === 'weekday') return 'wd';
  if (r.type === 'week') return `w${r.interval}:${(r.days || []).join('')}`;
  return `${r.type[0]}${r.interval}`;                        // d3 / m1 / y1
}
function parseRec(s) {
  if (s === 'wd') return { type: 'weekday', interval: 1 };
  let m = s.match(/^w(\d+):([0-6]*)$/);
  if (m) return { type: 'week', interval: +m[1], days: m[2].split('').map(Number) };
  m = s.match(/^([dwmy])(\d+)$/);
  if (!m) return null;
  const type = { d: 'day', w: 'week', m: 'month', y: 'year' }[m[1]];
  return type === 'week' ? { type, interval: +m[2], days: [] } : { type, interval: +m[2] };
}
function recLabel(r) {
  if (!r) return '';
  if (r.type === 'weekday') return '평일마다';
  if (r.type === 'week' && r.days && r.days.length)
    return (r.interval > 1 ? `${r.interval}주마다 ` : '매주 ') + r.days.map(d => DOW[d]).join('·');
  const unit = { day: '일', week: '주', month: '개월', year: '년' }[r.type];
  return r.interval > 1 ? `${r.interval}${unit}마다` : { day: '매일', week: '매주', month: '매월', year: '매년' }[r.type];
}
/** 반복 규칙에 따른 다음 마감일 */
function nextDue(y, r) {
  if (!r) return null;
  let cur = y || todayY();
  if (diffDays(cur, todayY()) < 0) cur = todayY();
  if (r.type === 'day') return addDays(cur, r.interval);
  if (r.type === 'month') return addMonths(cur, r.interval);
  if (r.type === 'year') return addMonths(cur, 12 * r.interval);
  if (r.type === 'weekday') { let n = addDays(cur, 1); while ([0, 6].includes(fromYmd(n).getDay())) n = addDays(n, 1); return n; }
  if (r.type === 'week') {
    const days = (r.days && r.days.length) ? [...r.days].sort() : [fromYmd(cur).getDay()];
    for (let i = 1; i <= 7; i++) { const c = addDays(cur, i); if (days.includes(fromYmd(c).getDay())) return c; }
    return addDays(cur, 7 * r.interval);
  }
  return null;
}

/* ─────────────────────────── 3. 자연어 파서 ─────────────────────────── */
const WD_MAP = { '일': 0, '월': 1, '화': 2, '수': 3, '목': 4, '금': 5, '토': 6 };

function parseInput(raw, lists) {
  const out = { title: raw, due: null, time: null, p: 4, labels: [], rec: null, dur: null, listId: null, hits: [] };
  let s = ' ' + raw + ' ';
  const eat = (re, fn) => {
    let m; if ((m = s.match(re))) { const keep = fn(m); if (keep !== false) s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length); return m; }
    return null;
  };

  // ── 반복 (날짜보다 먼저)
  eat(/(?:^|\s)평일마다|주중\s?매일(?=\s)/, () => { out.rec = { type: 'weekday', interval: 1 }; out.hits.push(['repeat', '평일마다']); });
  eat(/(?:^|\s)매주\s?([월화수목금토일])(?:요일)?(?=\s)/, m => {
    out.rec = { type: 'week', interval: 1, days: [WD_MAP[m[1]]] }; out.hits.push(['repeat', `매주 ${m[1]}`]);
  });
  eat(/(?:^|\s)(\d+)\s?주\s?마다(?=\s)/, m => { out.rec = { type: 'week', interval: +m[1], days: [] }; out.hits.push(['repeat', `${m[1]}주마다`]); });
  eat(/(?:^|\s)(\d+)\s?일\s?마다(?=\s)/, m => { out.rec = { type: 'day', interval: +m[1], days: [] }; out.hits.push(['repeat', `${m[1]}일마다`]); });
  eat(/(?:^|\s)(?:매일|daily)(?=\s)/, () => { out.rec = { type: 'day', interval: 1 }; out.hits.push(['repeat', '매일']); });
  eat(/(?:^|\s)격일(?=\s)/, () => { out.rec = { type: 'day', interval: 2 }; out.hits.push(['repeat', '격일']); });
  eat(/(?:^|\s)매월\s?(\d{1,2})일(?=\s)/, m => {
    out.rec = { type: 'month', interval: 1 }; out.hits.push(['repeat', `매월 ${m[1]}일`]);
    const d = new Date(); const day = +m[1];
    if (day < d.getDate()) d.setMonth(d.getMonth() + 1);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
    out.due = ymd(d);
  });
  eat(/(?:^|\s)(?:매월|monthly)(?=\s)/, () => { out.rec = { type: 'month', interval: 1 }; out.hits.push(['repeat', '매월']); });
  eat(/(?:^|\s)(?:매년|yearly)(?=\s)/, () => { out.rec = { type: 'year', interval: 1 }; out.hits.push(['repeat', '매년']); });
  eat(/(?:^|\s)(?:매주|weekly)(?=\s)/, () => { out.rec = { type: 'week', interval: 1, days: [] }; out.hits.push(['repeat', '매주']); });

  // ── 절대 날짜
  eat(/(?:^|\s)(\d{1,2})\s?월\s?(\d{1,2})\s?일(?=\s)/, m => {
    const now = new Date(); let y = now.getFullYear();
    const cand = `${y}-${pad(+m[1])}-${pad(+m[2])}`;
    out.due = diffDays(cand, todayY()) < -180 ? `${y + 1}-${pad(+m[1])}-${pad(+m[2])}` : cand;
  });
  if (!out.due) eat(/(?:^|\s)(\d{1,2})\/(\d{1,2})(?=\s)/, m => {
    const y = new Date().getFullYear(); out.due = `${y}-${pad(+m[1])}-${pad(+m[2])}`;
  });
  if (!out.due) eat(/(?:^|\s)(\d{4})-(\d{1,2})-(\d{1,2})(?=\s)/, m => { out.due = `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`; });

  // ── 상대 날짜
  if (!out.due) {
    eat(/(?:^|\s)(?:오늘|today)(?=\s)/, () => { out.due = todayY(); });
    if (!out.due) eat(/(?:^|\s)(?:내일|낼|tomorrow)(?=\s)/, () => { out.due = addDays(todayY(), 1); });
    if (!out.due) eat(/(?:^|\s)모레(?=\s)/, () => { out.due = addDays(todayY(), 2); });
    if (!out.due) eat(/(?:^|\s)글피(?=\s)/, () => { out.due = addDays(todayY(), 3); });
    if (!out.due) eat(/(?:^|\s)(\d+)\s?일\s?(?:후|뒤)(?=\s)/, m => { out.due = addDays(todayY(), +m[1]); });
    if (!out.due) eat(/(?:^|\s)(\d+)\s?주\s?(?:후|뒤)(?=\s)/, m => { out.due = addDays(todayY(), 7 * +m[1]); });
    if (!out.due) eat(/(?:^|\s)(다음주|담주|이번주|차주)\s?([월화수목금토일])(?:요일)?(?=\s)/, m => {
      out.due = nextWeekday(WD_MAP[m[2]], /다음주|담주|차주/.test(m[1]));
    });
    if (!out.due) eat(/(?:^|\s)(다음주|담주|차주)(?=\s)/, () => { out.due = nextWeekday(1, true); });
    if (!out.due) eat(/(?:^|\s)([월화수목금토일])요일(?=\s)/, m => { out.due = nextWeekday(WD_MAP[m[1]], false); });
    if (!out.due) eat(/(?:^|\s)월말(?=\s)/, () => {
      const d = new Date(); out.due = ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    });
  }

  // ── 시간
  eat(/(?:^|\s)(오전|오후|아침|저녁|밤)?\s?(\d{1,2})\s?시\s?(반|\d{1,2}\s?분)?(?=\s)/, m => {
    let h = +m[2];
    if (/오후|저녁|밤/.test(m[1] || '') && h < 12) h += 12;
    if (/아침|오전/.test(m[1] || '') && h === 12) h = 0;
    let mi = 0;
    if (m[3]) mi = m[3] === '반' ? 30 : parseInt(m[3], 10);
    out.time = `${pad(h)}:${pad(mi)}`;
  });
  if (!out.time) eat(/(?:^|\s)(오전|오후)?\s?(\d{1,2}):(\d{2})(?=\s)/, m => {
    let h = +m[2]; if (m[1] === '오후' && h < 12) h += 12;
    out.time = `${pad(h)}:${m[3]}`;
  });

  // ── 우선순위
  eat(/(?:^|\s)(?:p|P|!)([1-4])(?=\s)/, m => { out.p = +m[1]; });
  if (out.p === 4) eat(/(?:^|\s)(긴급|중요)(?=\s)/, m => { out.p = m[1] === '긴급' ? 1 : 2; });

  // ── 소요시간
  eat(/(?:^|\s)(\d+)\s?분\s?(?:소요|걸림)(?=\s)/, m => { out.dur = +m[1]; });
  eat(/(?:^|\s)(\d+(?:\.\d+)?)\s?시간\s?(?:소요|걸림)(?=\s)/, m => { out.dur = Math.round(+m[1] * 60); });

  // ── 라벨 @
  let lm; const labelRe = /(?:^|\s)@([^\s@#]+)/g; const found = [];
  while ((lm = labelRe.exec(s))) found.push(lm);
  for (let i = found.length - 1; i >= 0; i--) {
    out.labels.unshift(found[i][1]);
    s = s.slice(0, found[i].index) + ' ' + s.slice(found[i].index + found[i][0].length);
  }

  // ── 프로젝트 #
  eat(/(?:^|\s)#([^\s@#]+)/, m => {
    const q = m[1].toLowerCase();
    const hit = (lists || []).find(l => l.title.toLowerCase().replace(/\s/g, '').startsWith(q.replace(/_/g, '')));
    if (hit) { out.listId = hit.id; out.hits.push(['list', hit.title]); }
    else return false;
  });

  out.title = s.replace(/\s+/g, ' ').trim();
  if (out.time && !out.due) out.due = todayY();
  return out;
}
function nextWeekday(target, forceNextWeek) {
  const now = new Date(); const cur = now.getDay();
  let delta = (target - cur + 7) % 7;
  if (delta === 0) delta = 7;
  if (forceNextWeek) { const mondayDelta = (1 - cur + 7) % 7 || 7; delta = mondayDelta + ((target - 1 + 7) % 7); }
  return addDays(todayY(), delta);
}

/* Node 테스트용 export (브라우저에서는 무시된다) */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { pad, ymd, todayY, fromYmd, addDays, addMonths, diffDays, dueToYmd, ymdToDue,
    humanDate, dueClass, decodeNotes, encodeNotes, serRec, parseRec, recLabel, nextDue,
    parseInput, nextWeekday, DOW, META_OPEN, META_CLOSE, META_RE, WD_MAP };
}
