/**
 * Workspace tab strip — the Chrome-style tab bar that sits below the ribbon
 * and above the nav rail + panes when the `tabbedWorkspace` setting is on.
 *
 * Phase 1 of the tabbed-workspace feature: this is a PRESENTATION LAYER over
 * the existing multi-pane shell. Every open document is already a `PaneRecord`
 * living in a slot's stack; this surfaces those records as tabs instead of
 * hiding them inside the per-slot stack dropdown. Clicking a tab switches the
 * slot's visible doc; ✕ closes it; dragging reorders within a pane's segment.
 *
 * With one pane it reads as a flat Chrome tab bar. With the view split across
 * slots it groups tabs into one segment per pane (Chrome tab-group style),
 * mapped 1:1 onto `slot1`/`slot2`/`slot3`. Moving tabs BETWEEN segments (and
 * dragging a tab into the canvas to split) is a later phase; this file owns
 * rendering, selection, close, and within-segment reordering only.
 *
 * The component is deliberately dumb: it renders a `TabModel` the shell builds
 * from its live slot state and emits intent callbacks. The shell owns the
 * records and applies the intent (show / close / reorder), then re-renders.
 */

/** One tab = one open document (a `PaneRecord`). */
export interface TabEntry {
  /** The record's stable `uid` — the identity the shell routes intents by. */
  uid: string;
  /** Display filename (already defaulted to '(untitled)' by the shell). */
  filename: string;
  /** Unsaved-changes dot. */
  dirty: boolean;
  /** True when this is its slot's currently-visible doc. */
  active: boolean;
  kind: 'doc' | 'flow';
}

/** One segment = one pane (slot) that currently holds >=1 document. */
export interface TabSegment {
  slotId: string;
  /** True when this segment's slot is the focused pane. */
  focused: boolean;
  tabs: TabEntry[];
}

export interface TabModel {
  segments: TabSegment[];
}

/** A pane's contents as plain uids — the pure shape the split math works on
 *  (no DOM, no records), so the layout rules are unit-testable. */
export interface PaneLayout {
  uids: string[];
  visibleUid: string;
}

/** Where a tab dropped, relative to a reference pane. `into` = merge into that
 *  pane's stack; `left`/`right` = create a new pane on that side of it. */
export type DropSide = 'left' | 'right' | 'into';

/**
 * Compute the new left-to-right pane arrangement after dragging `draggedUid`
 * out of the strip and dropping it on `side` of the pane at `refIndex`.
 *
 * Pure: takes the current panes (left→right) and returns the desired panes
 * (left→right), or `null` when the move would exceed `maxPanes` (the caller
 * cancels the drop). The dragged uid is removed from wherever it was first;
 * emptied panes are dropped; a `left`/`right` drop inserts a fresh
 * single-tab pane on that side of the reference; `into` appends it to the
 * reference pane and makes it visible there.
 */
export function computeSplitLayout(
  panes: readonly PaneLayout[],
  draggedUid: string,
  refIndex: number,
  side: DropSide,
  maxPanes: number,
): PaneLayout[] | null {
  // Remove the dragged uid from every pane; repair a pane whose visible tab
  // was the dragged one (fall back to its new last tab).
  const working: PaneLayout[] = panes.map((p) => {
    const uids = p.uids.filter((u) => u !== draggedUid);
    const visibleUid = p.visibleUid === draggedUid ? (uids[uids.length - 1] ?? '') : p.visibleUid;
    return { uids, visibleUid };
  });
  const ref = working[refIndex];
  if (!ref) return null;

  if (side === 'into') {
    ref.uids.push(draggedUid);
    ref.visibleUid = draggedUid;
  } else {
    const newPane: PaneLayout = { uids: [draggedUid], visibleUid: draggedUid };
    const at = side === 'left' ? refIndex : refIndex + 1;
    working.splice(at, 0, newPane);
  }

  const result = working.filter((p) => p.uids.length > 0);
  if (result.length > maxPanes) return null;
  // A drop that changes nothing (e.g. dragging the only tab of a solo pane
  // "beside" itself) — let the caller treat a single unchanged pane as a
  // no-op rather than churning the layout.
  return result;
}

export interface WorkspaceTabStripCallbacks {
  /** Make `uid` the visible doc of its slot and focus that slot. */
  onSelect(slotId: string, uid: string): void;
  /** Close the document `uid` (routes through the slot's close flow, so a
   *  dirty doc still gets its save prompt). */
  onClose(slotId: string, uid: string): void;
  /** Reorder a slot's stack to the given uid order (a within-segment drag
   *  settled). The array is every uid in that segment, in the new order. */
  onReorderSegment(slotId: string, orderedUids: string[]): void;
  /** The drag left the strip (moved down into the canvas). Fired on each
   *  move while outside so the shell can show / update drop-zone highlights
   *  under the pointer. */
  onDragOutOfStrip?(uid: string, sourceSlotId: string, clientX: number, clientY: number): void;
  /** The drag re-entered the strip — hide any drop-zone highlight. */
  onDragBackIntoStrip?(): void;
  /** The tab was released outside the strip — commit a split / move at the
   *  pointer, or cancel if it isn't over a valid zone. */
  onDropOutsideStrip?(uid: string, sourceSlotId: string, clientX: number, clientY: number): void;
  /** A within-strip drag settled over a DIFFERENT segment — move the tab to
   *  `toSlotId`, ordering that segment as `orderedUids`. */
  onMoveTabToSegment?(uid: string, fromSlotId: string, toSlotId: string, orderedUids: string[]): void;
  /** Right-click on a tab — open a context menu at the pointer. */
  onTabContextMenu?(slotId: string, uid: string, clientX: number, clientY: number): void;
}

/** Pointer travel (px) before a press becomes a drag rather than a click. */
const DRAG_THRESHOLD = 5;

export class WorkspaceTabStrip {
  readonly el: HTMLElement;
  private cb: WorkspaceTabStripCallbacks;
  /** Coalesces multiple render() requests in a tick into one rebuild. */
  private pendingModel: TabModel | null = null;
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Active pointer-drag state, or null when not dragging a tab. */
  private drag: {
    slotId: string;
    uid: string;
    tabEl: HTMLElement;
    segEl: HTMLElement;
    startX: number;
    startY: number;
    /** Cursor offset from the tab's left edge at grab time, so the carried
     *  proxy sits under the same spot the user grabbed. */
    grabDX: number;
    started: boolean;
    /** True while the pointer is below the strip (in the canvas) — split
     *  mode, handled by the shell's drop zones, not in-strip reorder. */
    outside: boolean;
    pointerId: number;
    /** The floating "carried" tab that tracks the cursor (created on start). */
    proxy: HTMLElement | null;
    /** In-strip landing target while dragging within the strip: the segment
     *  and the index within it the tab would drop at. Null while outside. */
    inStrip: { segEl: HTMLElement; index: number } | null;
  } | null = null;
  /** Insertion caret shown in the strip while reordering (created lazily). */
  private insertCaret: HTMLElement | null = null;

  constructor(cb: WorkspaceTabStripCallbacks) {
    this.cb = cb;
    this.el = document.createElement('div');
    this.el.className = 'pmd-tab-strip';
    this.el.setAttribute('role', 'tablist');
    this.el.setAttribute('aria-label', 'Open documents');
  }

  /** Queue a re-render from `model`. Coalesced to once per tick so a burst
   *  of shell mutations (open + focus + layout in one tick) rebuilds once.
   *  Uses a timer, NOT requestAnimationFrame: a minimized / backgrounded
   *  window throttles rAF indefinitely, which would strand the strip on a
   *  stale render after a background open / co-edit update. */
  render(model: TabModel): void {
    this.pendingModel = model;
    if (this.coalesceTimer !== null) return;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      const m = this.pendingModel;
      this.pendingModel = null;
      if (m) this.rebuild(m);
    }, 0);
  }

  /** Force any queued render to happen now (tests + teardown). */
  flush(): void {
    if (this.coalesceTimer !== null) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
    const m = this.pendingModel;
    this.pendingModel = null;
    if (m) this.rebuild(m);
  }

  destroy(): void {
    if (this.coalesceTimer !== null) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
    this.pendingModel = null;
    this.drag?.proxy?.remove();
    this.insertCaret?.remove();
    this.insertCaret = null;
    this.el.replaceChildren();
    this.el.remove();
  }

  private rebuild(model: TabModel): void {
    const multiSegment = model.segments.length > 1;
    this.el.classList.toggle('pmd-tab-strip-split', multiSegment);
    const frag = document.createDocumentFragment();
    model.segments.forEach((seg, i) => {
      if (i > 0) {
        const divider = document.createElement('div');
        divider.className = 'pmd-tab-seg-divider';
        divider.setAttribute('aria-hidden', 'true');
        frag.appendChild(divider);
      }
      frag.appendChild(this.buildSegment(seg, multiSegment));
    });
    this.el.replaceChildren(frag);
    this.scrollActiveIntoView();
  }

  /** Keep the focused pane's active tab within the strip's horizontal scroll
   *  viewport when tabs overflow. Only nudges the strip's own scrollLeft — no
   *  ancestor scrolling. */
  private scrollActiveIntoView(): void {
    const focusedSeg = this.el.querySelector('.pmd-tab-seg-focused') ?? this.el;
    const active = focusedSeg.querySelector<HTMLElement>('.pmd-tab-active');
    if (!active) return;
    const ar = active.getBoundingClientRect();
    const sr = this.el.getBoundingClientRect();
    if (ar.width === 0 && ar.left === 0) return; // not laid out (jsdom) — skip
    if (ar.left < sr.left) this.el.scrollLeft -= sr.left - ar.left + 8;
    else if (ar.right > sr.right) this.el.scrollLeft += ar.right - sr.right + 8;
  }

  private buildSegment(seg: TabSegment, showSlotBadge: boolean): HTMLElement {
    const segEl = document.createElement('div');
    segEl.className = 'pmd-tab-seg';
    segEl.dataset['slot'] = seg.slotId;
    segEl.classList.toggle('pmd-tab-seg-focused', seg.focused);
    if (showSlotBadge) {
      const badge = document.createElement('span');
      badge.className = 'pmd-tab-seg-badge';
      badge.textContent = seg.slotId.replace('slot', '');
      badge.title = `Pane ${seg.slotId.replace('slot', '')}`;
      segEl.appendChild(badge);
    }
    for (const tab of seg.tabs) {
      segEl.appendChild(this.buildTab(seg.slotId, tab, segEl));
    }
    return segEl;
  }

  private buildTab(slotId: string, tab: TabEntry, segEl: HTMLElement): HTMLElement {
    const el = document.createElement('div');
    el.className = 'pmd-tab';
    el.dataset['uid'] = tab.uid;
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', tab.active ? 'true' : 'false');
    el.classList.toggle('pmd-tab-active', tab.active);
    el.classList.toggle('pmd-tab-flow', tab.kind === 'flow');
    el.title = tab.filename;

    const dot = document.createElement('span');
    dot.className = 'pmd-tab-dirty';
    dot.setAttribute('aria-hidden', 'true');
    dot.hidden = !tab.dirty;
    el.appendChild(dot);

    const name = document.createElement('span');
    name.className = 'pmd-tab-name';
    name.textContent = tab.filename;
    el.appendChild(name);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'pmd-tab-close';
    close.title = 'Close';
    close.setAttribute('aria-label', `Close ${tab.filename}`);
    close.textContent = '×';
    // Don't let a close press start a drag or a select.
    close.addEventListener('pointerdown', (e) => e.stopPropagation());
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.cb.onClose(slotId, tab.uid);
    });
    el.appendChild(close);

    // A plain click selects; a press-and-drag reorders / splits.
    el.addEventListener('pointerdown', (e) => this.onTabPointerDown(e, slotId, tab.uid, el, segEl));
    // Middle-click closes (Chrome affordance). `auxclick` fires for the
    // middle button after a full press+release without starting a drag.
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this.cb.onClose(slotId, tab.uid);
      }
    });
    // Right-click → context menu (Close / Close others / Close to the right /
    // move to a new pane), owned by the shell.
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.cb.onTabContextMenu?.(slotId, tab.uid, e.clientX, e.clientY);
    });
    return el;
  }

  private onTabPointerDown(
    e: PointerEvent,
    slotId: string,
    uid: string,
    tabEl: HTMLElement,
    segEl: HTMLElement,
  ): void {
    if (e.button !== 0) return;
    const rect = tabEl.getBoundingClientRect();
    this.drag = {
      slotId,
      uid,
      tabEl,
      segEl,
      startX: e.clientX,
      startY: e.clientY,
      grabDX: e.clientX - rect.left,
      started: false,
      outside: false,
      pointerId: e.pointerId,
      proxy: null,
      inStrip: null,
    };
    const onMove = (ev: PointerEvent): void => this.onTabPointerMove(ev);
    const onUp = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      this.onTabPointerUp(ev, slotId, uid);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  private onTabPointerMove(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    if (!drag.started) {
      if (
        Math.abs(e.clientX - drag.startX) < DRAG_THRESHOLD &&
        Math.abs(e.clientY - drag.startY) < DRAG_THRESHOLD
      ) {
        return;
      }
      drag.started = true;
      // The real tab stays put as a dim placeholder; the carried proxy is what
      // moves. This is what makes the drag feel like holding something rather
      // than a tab snapping between slots.
      drag.tabEl.classList.add('pmd-tab-dragging');
      this.el.classList.add('pmd-tab-strip-dragging');
      drag.proxy = this.createDragProxy(drag.tabEl);
    }
    this.positionDragProxy(drag, e.clientX, e.clientY);

    // Below the strip's bottom edge = split mode: hand geometry to the shell,
    // which owns the pane layout + drop zones. Above/within = in-strip reorder.
    const stripBottom = this.el.getBoundingClientRect().bottom;
    const nowOutside = e.clientY > stripBottom + 4;
    if (nowOutside) {
      drag.outside = true;
      drag.inStrip = null;
      this.hideInsertCaret();
      this.cb.onDragOutOfStrip?.(drag.uid, drag.slotId, e.clientX, e.clientY);
      return;
    }
    if (drag.outside) {
      drag.outside = false;
      this.cb.onDragBackIntoStrip?.();
    }
    // In-strip: find the segment under the pointer and the index the tab would
    // land at (by sibling midpoints). Show a caret at that gap — the real tabs
    // are NOT moved (that was the janky part); the order is applied on drop.
    const segs = Array.from(this.el.querySelectorAll<HTMLElement>('.pmd-tab-seg'));
    let targetSeg: HTMLElement = drag.segEl;
    for (const seg of segs) {
      const r = seg.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right) {
        targetSeg = seg;
        break;
      }
    }
    const siblings = Array.from(
      targetSeg.querySelectorAll<HTMLElement>('.pmd-tab:not(.pmd-tab-dragging)'),
    );
    let index = siblings.length;
    for (let i = 0; i < siblings.length; i++) {
      const r = siblings[i]!.getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) {
        index = i;
        break;
      }
    }
    drag.inStrip = { segEl: targetSeg, index };
    this.showInsertCaret(targetSeg, siblings, index);
  }

  private onTabPointerUp(e: PointerEvent, slotId: string, uid: string): void {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    drag.tabEl.classList.remove('pmd-tab-dragging');
    this.el.classList.remove('pmd-tab-strip-dragging');
    drag.proxy?.remove();
    this.hideInsertCaret();
    if (!drag.started) {
      // No drag → treat as a click: select the tab.
      this.cb.onSelect(slotId, uid);
      return;
    }
    if (drag.outside) {
      // Released in the canvas → the shell commits a split / move (or cancels
      // if it isn't over a valid drop zone).
      this.cb.onDropOutsideStrip?.(uid, slotId, e.clientX, e.clientY);
      return;
    }
    // A within-strip drag settled: apply the caret's landing target. Build the
    // destination segment's new uid order with the dragged tab inserted at the
    // caret index (the dragged tab is excluded from `siblings`, so the index is
    // already relative to the remaining tabs).
    const target = drag.inStrip;
    if (!target) return;
    const toSlotId = target.segEl.dataset['slot'] ?? slotId;
    const siblingUids = Array.from(
      target.segEl.querySelectorAll<HTMLElement>('.pmd-tab:not(.pmd-tab-dragging)'),
    ).map((t) => t.dataset['uid'] ?? '');
    const order = [...siblingUids];
    order.splice(Math.min(target.index, order.length), 0, uid);
    if (toSlotId === slotId) {
      this.cb.onReorderSegment(slotId, order);
    } else {
      this.cb.onMoveTabToSegment?.(uid, slotId, toSlotId, order);
    }
  }

  /** Build the floating pill that tracks the cursor during a drag. */
  private createDragProxy(tabEl: HTMLElement): HTMLElement {
    const proxy = document.createElement('div');
    proxy.className = 'pmd-tab-drag-proxy';
    if (tabEl.classList.contains('pmd-tab-flow')) proxy.classList.add('pmd-tab-flow');
    const dot = document.createElement('span');
    dot.className = 'pmd-tab-drag-proxy-dot';
    const name = document.createElement('span');
    name.className = 'pmd-tab-drag-proxy-name';
    name.textContent = tabEl.querySelector('.pmd-tab-name')?.textContent ?? '';
    proxy.append(dot, name);
    document.body.appendChild(proxy);
    return proxy;
  }

  private positionDragProxy(
    drag: NonNullable<WorkspaceTabStrip['drag']>,
    x: number,
    y: number,
  ): void {
    if (!drag.proxy) return;
    // Keep the pill under the point the user grabbed, lifted slightly above the
    // cursor so the label stays readable.
    const left = x - drag.grabDX;
    const top = y - 14;
    drag.proxy.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px) rotate(-2.5deg) scale(1.03)`;
  }

  private showInsertCaret(segEl: HTMLElement, siblings: HTMLElement[], index: number): void {
    if (!this.insertCaret) {
      this.insertCaret = document.createElement('div');
      this.insertCaret.className = 'pmd-tab-insert-caret';
      this.insertCaret.hidden = true;
      document.body.appendChild(this.insertCaret);
    }
    const segRect = segEl.getBoundingClientRect();
    let caretX: number;
    if (siblings.length === 0) {
      caretX = segRect.left + 4;
    } else if (index >= siblings.length) {
      caretX = siblings[siblings.length - 1]!.getBoundingClientRect().right + 1;
    } else {
      caretX = siblings[index]!.getBoundingClientRect().left - 1;
    }
    const caret = this.insertCaret;
    caret.style.left = `${Math.round(caretX)}px`;
    caret.style.top = `${Math.round(segRect.top + 3)}px`;
    caret.style.height = `${Math.round(segRect.height - 4)}px`;
    caret.hidden = false;
  }

  private hideInsertCaret(): void {
    if (this.insertCaret) this.insertCaret.hidden = true;
  }
}
