/* ==========================================================================
   Malro — 포인터 기반 드래그앤드롭
   --------------------------------------------------------------------------
   왜 HTML5 Drag and Drop 을 쓰지 않는가
     iOS/iPadOS Safari 는 dragstart/drop 이벤트를 발생시키지 않는다.
     맥·아이폰·아이패드에서 동일하게 동작해야 하므로 Pointer Events 로 직접 만든다.

   입력 장치별 시작 조건
     마우스/트랙패드 : 4px 이상 움직이면 즉시 드래그
     터치            : 260ms 롱프레스 후 드래그. 그 전에 10px 이상 움직이면
                       드래그를 포기하고 스크롤에 양보한다.

   드롭 판정
     리스트 뷰 : 세로 위치 → 순서, 가로 오프셋(±34px) → 들여쓰기/내어쓰기
     보드 뷰   : 컬럼 → 소속(목록/우선순위/기한), 세로 위치 → 순서
   ========================================================================== */
'use strict';

const DND = {
  armed: false, active: false, moved: false,
  timer: 0, raf: 0,
  sx: 0, sy: 0, x: 0, y: 0,
  src: null, key: null, pointerId: null, touch: false,
  ghost: null, line: null, drop: null, hotCol: null, hotCard: null,
  nestCand: null, nestSince: 0
};

const DND_TOUCH_HOLD = 260;     // 터치 롱프레스 임계 (ms)
const DND_MOUSE_SLOP = 4;       // 마우스 드래그 시작 임계 (px)
const DND_TOUCH_SLOP = 10;      // 롱프레스 중 허용 흔들림 (px)
const DND_INDENT = 34;          // 들여쓰기 판정 가로 오프셋 (px)
const DND_EDGE = 56;            // 자동 스크롤 감지 여백 (px)
const DND_NEST_DWELL = 200;     // 보드에서 카드 위에 머물러야 중첩으로 바뀌는 시간 (ms)

/* ─────────────────────────── 시작 ─────────────────────────── */
function dndDown(e) {
  /* 새 상호작용이 시작됐으므로 직전 드래그가 걸어 둔 클릭 억제를 먼저 푼다.
     (버튼 위에서 눌러 아래 early return 으로 빠지는 경우까지 포함해야 하므로 맨 앞에 둔다) */
  DND.moved = false;
  if (DND.active || DND.armed) return;
  if (e.button !== undefined && e.button !== 0) return;
  if (!dndEnabled()) return;
  if (e.target.closest('button, input, textarea, a')) return;
  const el = e.target.closest('#wrap .sub-row[data-k], #wrap .task[data-k], #wrap .card[data-k]');
  if (!el) return;

  DND.armed = true; DND.moved = false; DND.touch = e.pointerType === 'touch';
  DND.sx = DND.x = e.clientX; DND.sy = DND.y = e.clientY;
  DND.src = el; DND.key = el.dataset.k; DND.pointerId = e.pointerId;
  DND.onBoard = !!el.closest('#board');

  if (DND.touch) {
    DND.timer = setTimeout(() => { if (DND.armed) dndActivate(); }, DND_TOUCH_HOLD);
  }
}

function dndActivate() {
  DND.armed = false; DND.active = true; DND.moved = true;
  const el = DND.src;
  const r = el.getBoundingClientRect();
  /* 잡은 지점은 "드래그가 시작된 순간"이 아니라 "처음 누른 지점"(sx,sy) 기준이어야 한다.
     현재 좌표로 잡으면 임계값만큼 움직인 거리가 오프셋에 섞여 블록이 손에서 미끄러진다. */
  DND.offX = DND.sx - r.left; DND.offY = DND.sy - r.top;

  const g = el.cloneNode(true);
  g.id = 'dragGhost';
  g.style.width = r.width + 'px';
  g.classList.remove('dragging');
  document.body.appendChild(g);
  DND.ghost = g;
  /* 고스트는 서브태스크 목록을 숨기므로 원본보다 작을 수 있다.
     잡은 지점이 고스트 밖으로 나가지 않도록 오프셋을 고스트 크기에 맞춰 보정한다. */
  const gr = g.getBoundingClientRect();
  DND.offX = Math.max(8, Math.min(DND.offX, gr.width - 8));
  DND.offY = Math.max(8, Math.min(DND.offY, gr.height - 8));

  const line = document.createElement('div');
  line.id = 'dropLine';
  document.body.appendChild(line);
  DND.line = line;

  el.classList.add('dragging');
  document.body.classList.add('dragging-active');
  try { el.setPointerCapture(DND.pointerId); } catch (err) { /* 무시 */ }
  if (navigator.vibrate && DND.touch) navigator.vibrate(8);
  dndPaint();
  DND.raf = requestAnimationFrame(dndTick);
}

/* ─────────────────────────── 이동 ─────────────────────────── */
function dndMove(e) {
  if (!DND.armed && !DND.active) return;
  DND.x = e.clientX; DND.y = e.clientY;
  const dx = Math.abs(DND.x - DND.sx), dy = Math.abs(DND.y - DND.sy);

  if (DND.armed) {
    if (DND.touch) {
      if (dx > DND_TOUCH_SLOP || dy > DND_TOUCH_SLOP) dndCancel();   // 스크롤에 양보
    } else if (dx > DND_MOUSE_SLOP || dy > DND_MOUSE_SLOP) {
      dndActivate();
    }
    return;
  }
  e.preventDefault();
  dndPaint();
}

/** 고스트 위치와 드롭 인디케이터를 갱신한다 */
function dndPaint() {
  if (!DND.active) return;
  DND.ghost.style.transform =
    `translate(${DND.x - DND.offX}px, ${DND.y - DND.offY}px) scale(1.02) rotate(1.4deg)`;
  const d = DND.onBoard ? dndBoardTarget() : dndListTarget();
  DND.drop = d;

  const nesting = !!(d && d.nestCard);
  if (DND.hotCard && DND.hotCard !== (d && d.nestCard)) DND.hotCard.classList.remove('nest-on');
  DND.hotCard = nesting ? d.nestCard : null;
  if (DND.hotCard) DND.hotCard.classList.add('nest-on');

  const wantCol = (d && d.col && !nesting) ? d.col : null;
  if (DND.hotCol && DND.hotCol !== wantCol) DND.hotCol.classList.remove('drop-on');
  DND.hotCol = wantCol;
  if (DND.hotCol) DND.hotCol.classList.add('drop-on');

  if (!d || !d.rect) { DND.line.style.display = 'none'; return; }
  DND.line.style.display = 'block';
  DND.line.style.left = (d.rect.left + (d.indent || 0)) + 'px';
  DND.line.style.width = (d.rect.width - (d.indent || 0)) + 'px';
  DND.line.style.top = d.top + 'px';
}

/* ─────────────────────────── 드롭 대상 계산 ─────────────────────────── */
/** 리스트 뷰: 순서 + 들여쓰기 단계 */
function dndListTarget() {
  const srcId = DND.key.split('/')[1];
  const rows = [...document.querySelectorAll('#wrap .task[data-k]')]
    .filter(r => r !== DND.src)
    .filter(r => { const t = taskByKey(r.dataset.k); return !t || t.parent !== srcId; });  // 자기 자손 제외
  let prev = null, prevRect = null, firstRect = null;
  for (const r of rows) {
    const b = r.getBoundingClientRect();
    if (!firstRect) firstRect = b;
    if (DND.y > b.top + b.height / 2) { prev = r; prevRect = b; }
  }
  const dx = DND.x - DND.sx;
  const prevTask = prev ? taskByKey(prev.dataset.k) : null;
  let parentId;
  if (!prevTask) parentId = null;                                   // 맨 위 → 최상위
  else if (dx > DND_INDENT) parentId = prevTask.parent || prevTask.id;   // 들여쓰기
  else if (dx < -DND_INDENT) parentId = null;                       // 내어쓰기
  else parentId = prevTask.parent || null;                          // 직전 항목과 같은 레벨

  const rect = prevRect || firstRect;
  if (!rect) return { previousId: null, parentId: null, rect: null };
  return {
    previousId: prevTask ? prevTask.id : null,
    parentId,
    rect,
    top: prevRect ? prevRect.bottom - 1 : firstRect.top - 1,
    indent: parentId ? 30 : 0
  };
}

/** 보드 뷰: 컬럼 + 순서 */
function dndBoardTarget() {
  const under = document.elementFromPoint(DND.x, DND.y);
  let col = under && under.closest ? under.closest('.col') : null;
  if (!col) {                                        // 컬럼 사이 여백 → 가장 가까운 컬럼
    let best = null, bd = Infinity;
    for (const c of document.querySelectorAll('.col')) {
      const b = c.getBoundingClientRect();
      const d = DND.x < b.left ? b.left - DND.x : DND.x > b.right ? DND.x - b.right : 0;
      if (d < bd) { bd = d; best = c; }
    }
    col = best;
  }
  if (!col) return null;
  const body = col.querySelector('.col-body');
  const ownCard = DND.src.closest('.card');
  const cards = [...body.querySelectorAll('.card[data-k]')].filter(c => c !== DND.src && c !== ownCard);

  /* 1차 판정 — 카드 몸통(가운데 40%) 위에서 잠깐 머무르면 그 카드의 서브태스크로 만든다.
     그냥 지나가는 것만으로 중첩되면 "다른 목록으로 옮기려다 서브태스크가 되는" 사고가 난다.
     그래서 같은 카드 위에 DND_NEST_DWELL 만큼 머문 뒤에야 중첩 모드로 전환한다. */
  let over = null;
  for (const c of cards) {
    const b = c.getBoundingClientRect();
    if (DND.x >= b.left && DND.x <= b.right &&
        DND.y >= b.top + b.height * 0.30 && DND.y <= b.bottom - b.height * 0.30) { over = c; break; }
  }
  if (over !== DND.nestCand) { DND.nestCand = over; DND.nestSince = performance.now(); }
  if (over && performance.now() - DND.nestSince >= DND_NEST_DWELL) {
    return {
      col, colId: col.dataset.colId, colKind: col.dataset.colKind,
      nestCard: over, nestId: over.dataset.k.split('/')[1], nestKey: over.dataset.k, rect: null
    };
  }

  /* 2차 판정 — 순서 변경 */
  let prev = null, prevRect = null;
  for (const c of cards) {
    const b = c.getBoundingClientRect();
    if (DND.y > b.top + b.height / 2) { prev = c; prevRect = b; }
  }
  const bb = body.getBoundingClientRect();
  return {
    col,
    colId: col.dataset.colId,
    colKind: col.dataset.colKind,
    previousId: prev ? prev.dataset.k.split('/')[1] : null,
    rect: { left: bb.left + 10, width: bb.width - 20 },
    top: prevRect ? prevRect.bottom + 3 : bb.top + 2,
    indent: 0
  };
}

/* ─────────────────────────── 자동 스크롤 ─────────────────────────── */
function dndTick() {
  if (!DND.active) return;
  const sc = $('scroller');
  const r = sc.getBoundingClientRect();
  if (DND.y < r.top + DND_EDGE) sc.scrollTop -= Math.ceil((r.top + DND_EDGE - DND.y) / 5);
  else if (DND.y > r.bottom - DND_EDGE) sc.scrollTop += Math.ceil((DND.y - (r.bottom - DND_EDGE)) / 5);

  const board = $('board');
  if (board) {
    const b = board.getBoundingClientRect();
    if (DND.x < b.left + DND_EDGE) board.scrollLeft -= Math.ceil((b.left + DND_EDGE - DND.x) / 4);
    else if (DND.x > b.right - DND_EDGE) board.scrollLeft += Math.ceil((DND.x - (b.right - DND_EDGE)) / 4);
    if (DND.drop && DND.drop.col) {
      const body = DND.drop.col.querySelector('.col-body');
      const cb = body.getBoundingClientRect();
      if (DND.y < cb.top + 30) body.scrollTop -= 6;
      else if (DND.y > cb.bottom - 30) body.scrollTop += 6;
    }
  }
  dndPaint();
  DND.raf = requestAnimationFrame(dndTick);
}

/* ─────────────────────────── 커밋 ─────────────────────────── */
function dndUp() {
  if (DND.armed) { dndCancel(); return; }
  if (!DND.active) return;
  const d = DND.drop, key = DND.key;
  dndTeardown();
  const t = taskByKey(key);
  if (!t || !d) { render(); return; }

  if (DND.srcWasCard) {
    if (d.nestKey) { nestUnder(t, d.nestKey); return; }
    if (d.colKind === 'list') {
      /* 같은 컬럼 안에서의 이동은 '순서 바꾸기' 다. 마감일·중요도로 정렬된 상태에서는
         정렬이 곧바로 덮어쓰므로 조용히 되돌리지 말고 이유를 말해 준다.
         다른 컬럼으로 옮기는 것은 목록 변경이라 정렬과 무관하게 그대로 처리한다. */
      if (d.colId === t.listId) {
        if (!reorderOn()) { toast('순서 바꾸기는 등록일순에서만 됩니다'); render(); return; }
        applyMove(t, { previousId: d.previousId, parentId: null });
      } else applyMove(t, { destList: d.colId, previousId: reorderOn() ? d.previousId : null, parentId: null });
    } else if (d.colKind === 'p') {
      const np = +d.colId;
      if (np !== t.p) updateMeta(t, { p: np }); else render();
    } else if (d.colKind === 'due') {
      const T = todayY();
      const map = { over: () => addDays(T, -1), today: () => T, tmr: () => addDays(T, 1),
                    week: () => addDays(T, 3), later: () => addDays(T, 14), none: () => null };
      const nd = (map[d.colId] || (() => t.due))();
      if (nd !== t.due) patchTask(t, { due: ymdToDue(nd) }); else render();
    } else render();
    return;
  }
  applyMove(t, { previousId: d.previousId, parentId: d.parentId });
}

function dndCancel() { dndTeardown(); }

function dndTeardown() {
  const wasActive = DND.active;
  clearTimeout(DND.timer);
  cancelAnimationFrame(DND.raf);
  DND.srcWasCard = DND.onBoard;
  if (DND.src) {
    DND.src.classList.remove('dragging');
    try { DND.src.releasePointerCapture(DND.pointerId); } catch (e) { /* 무시 */ }
  }
  if (DND.ghost) DND.ghost.remove();
  if (DND.line) DND.line.remove();
  if (DND.hotCol) DND.hotCol.classList.remove('drop-on');
  if (DND.hotCard) DND.hotCard.classList.remove('nest-on');
  document.body.classList.remove('dragging-active');
  DND.armed = DND.active = false;
  DND.ghost = DND.line = DND.hotCol = DND.hotCard = DND.nestCand = null;
  /* 드래그가 실제로 일어났을 때만 직후의 click 을 한 번 삼킨다.
     (단순 탭이었다면 삼키면 안 된다 — 상세 패널이 안 열린다) */
  if (wasActive) { DND.moved = true; setTimeout(() => { DND.moved = false; }, 150); }
  else DND.moved = false;
}

/* ─────────────────────────── 바인딩 ─────────────────────────── */
function dndInit() {
  const w = $('wrap');
  w.addEventListener('pointerdown', dndDown);
  window.addEventListener('pointermove', dndMove, { passive: false });
  window.addEventListener('pointerup', dndUp);
  window.addEventListener('pointercancel', dndCancel);
  window.addEventListener('blur', dndCancel);
  // 롱프레스 중 iOS 의 컨텍스트 메뉴/선택 확대를 막는다
  w.addEventListener('contextmenu', e => { if (DND.active || DND.armed) e.preventDefault(); });
}
dndInit();
