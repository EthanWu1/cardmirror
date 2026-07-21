// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  WorkspaceTabStrip,
  computeSplitLayout,
  type PaneLayout,
  type TabModel,
  type WorkspaceTabStripCallbacks,
} from '../../src/editor/workspace-tabs.js';

function makeStrip(overrides: Partial<WorkspaceTabStripCallbacks> = {}) {
  const cb: WorkspaceTabStripCallbacks = {
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onReorderSegment: vi.fn(),
    ...overrides,
  };
  const strip = new WorkspaceTabStrip(cb);
  document.body.appendChild(strip.el);
  return { strip, cb };
}

function singlePane(): TabModel {
  return {
    segments: [
      {
        slotId: 'slot1',
        focused: true,
        tabs: [
          { uid: 'a', filename: '1AC.cmir', dirty: false, active: true, kind: 'doc' },
          { uid: 'b', filename: 'Neg.docx', dirty: true, active: false, kind: 'doc' },
        ],
      },
    ],
  };
}

function twoPanes(): TabModel {
  return {
    segments: [
      {
        slotId: 'slot1',
        focused: false,
        tabs: [{ uid: 'a', filename: '1AC.cmir', dirty: false, active: true, kind: 'doc' }],
      },
      {
        slotId: 'slot2',
        focused: true,
        tabs: [{ uid: 'b', filename: 'Flow', dirty: false, active: true, kind: 'flow' }],
      },
    ],
  };
}

describe('WorkspaceTabStrip', () => {
  it('renders one segment as a flat tab bar (no split chrome)', () => {
    const { strip } = makeStrip();
    strip.render(singlePane());
    strip.flush();
    expect(strip.el.classList.contains('pmd-tab-strip-split')).toBe(false);
    const tabs = strip.el.querySelectorAll('.pmd-tab');
    expect(tabs).toHaveLength(2);
    // No pane badges or dividers with a single segment.
    expect(strip.el.querySelectorAll('.pmd-tab-seg-badge')).toHaveLength(0);
    expect(strip.el.querySelectorAll('.pmd-tab-seg-divider')).toHaveLength(0);
  });

  it('reflects active + dirty state on the tabs', () => {
    const { strip } = makeStrip();
    strip.render(singlePane());
    strip.flush();
    const [a, b] = Array.from(strip.el.querySelectorAll<HTMLElement>('.pmd-tab'));
    expect(a!.classList.contains('pmd-tab-active')).toBe(true);
    expect(a!.querySelector<HTMLElement>('.pmd-tab-dirty')!.hidden).toBe(true);
    expect(b!.classList.contains('pmd-tab-active')).toBe(false);
    expect(b!.querySelector<HTMLElement>('.pmd-tab-dirty')!.hidden).toBe(false);
  });

  it('groups panes into badged segments with dividers when split', () => {
    const { strip } = makeStrip();
    strip.render(twoPanes());
    strip.flush();
    expect(strip.el.classList.contains('pmd-tab-strip-split')).toBe(true);
    expect(strip.el.querySelectorAll('.pmd-tab-seg')).toHaveLength(2);
    expect(strip.el.querySelectorAll('.pmd-tab-seg-badge')).toHaveLength(2);
    expect(strip.el.querySelectorAll('.pmd-tab-seg-divider')).toHaveLength(1);
    const focused = strip.el.querySelector('.pmd-tab-seg-focused');
    expect(focused?.getAttribute('data-slot')).toBe('slot2');
    // A flow tab is tagged so it can read differently.
    expect(strip.el.querySelector('.pmd-tab-flow')).not.toBeNull();
  });

  it('selects a tab on a plain click (pointerdown → pointerup, no drag)', () => {
    const { strip, cb } = makeStrip();
    strip.render(singlePane());
    strip.flush();
    const second = strip.el.querySelectorAll<HTMLElement>('.pmd-tab')[1]!;
    second.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 40, bubbles: true }));
    window.dispatchEvent(new MouseEvent('pointerup', { button: 0, clientX: 40, bubbles: true }));
    expect(cb.onSelect).toHaveBeenCalledWith('slot1', 'b');
    expect(cb.onReorderSegment).not.toHaveBeenCalled();
  });

  it('closes a tab via its ✕ without also selecting it', () => {
    const { strip, cb } = makeStrip();
    strip.render(singlePane());
    strip.flush();
    const closeBtn = strip.el
      .querySelectorAll<HTMLElement>('.pmd-tab')[1]!
      .querySelector<HTMLButtonElement>('.pmd-tab-close')!;
    closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cb.onClose).toHaveBeenCalledWith('slot1', 'b');
    expect(cb.onSelect).not.toHaveBeenCalled();
  });

  it('destroy() removes the element and clears children (drop-zone teardown)', () => {
    const { strip } = makeStrip();
    strip.render(singlePane());
    strip.flush();
    strip.destroy();
    expect(strip.el.parentElement).toBeNull();
    expect(strip.el.children).toHaveLength(0);
  });
});

describe('computeSplitLayout (drag-to-split math)', () => {
  const pane = (uids: string[], visibleUid = uids[uids.length - 1]!): PaneLayout => ({
    uids,
    visibleUid,
  });

  it('splits one pane into two, dragged tab on the RIGHT', () => {
    const cur = [pane(['a', 'b', 'c'], 'c')];
    const out = computeSplitLayout(cur, 'b', 0, 'right', 3);
    expect(out).toEqual([
      { uids: ['a', 'c'], visibleUid: 'c' }, // b removed, c still visible
      { uids: ['b'], visibleUid: 'b' }, // new pane on the right
    ]);
  });

  it('splits one pane into two, dragged tab on the LEFT', () => {
    const cur = [pane(['a', 'b', 'c'], 'c')];
    const out = computeSplitLayout(cur, 'b', 0, 'left', 3);
    expect(out).toEqual([
      { uids: ['b'], visibleUid: 'b' }, // new pane on the left
      { uids: ['a', 'c'], visibleUid: 'c' },
    ]);
  });

  it('repairs the source pane visible tab when the dragged tab was visible', () => {
    const cur = [pane(['a', 'b'], 'b')]; // b is visible and gets dragged out
    const out = computeSplitLayout(cur, 'b', 0, 'right', 3);
    expect(out![0]).toEqual({ uids: ['a'], visibleUid: 'a' });
  });

  it('drops a tab INTO another pane (move between panes, becomes visible there)', () => {
    const cur = [pane(['a', 'b'], 'a'), pane(['c'], 'c')];
    // Drag b from pane 0 into pane 1.
    const out = computeSplitLayout(cur, 'b', 1, 'into', 3);
    expect(out).toEqual([
      { uids: ['a'], visibleUid: 'a' },
      { uids: ['c', 'b'], visibleUid: 'b' },
    ]);
  });

  it('collapses a source pane that the dragged tab emptied', () => {
    const cur = [pane(['a'], 'a'), pane(['b', 'c'], 'c')];
    // Drag the only tab of pane 0 into pane 1 → pane 0 disappears.
    const out = computeSplitLayout(cur, 'a', 1, 'into', 3);
    expect(out).toEqual([{ uids: ['b', 'c', 'a'], visibleUid: 'a' }]);
  });

  it('refuses a split that would exceed the pane cap', () => {
    const cur = [pane(['a']), pane(['b']), pane(['c'])]; // already 3 panes
    // Dragging d... (well, dragging an existing tab to a NEW pane would be 4).
    const withD = [pane(['a', 'd'], 'a'), pane(['b']), pane(['c'])];
    const out = computeSplitLayout(withD, 'd', 2, 'right', 3);
    expect(out).toBeNull();
  });

  it('allows a move that stays within the cap even at 3 panes (into)', () => {
    const cur = [pane(['a', 'd'], 'a'), pane(['b']), pane(['c'])];
    const out = computeSplitLayout(cur, 'd', 1, 'into', 3);
    expect(out).toEqual([
      { uids: ['a'], visibleUid: 'a' },
      { uids: ['b', 'd'], visibleUid: 'd' },
      { uids: ['c'], visibleUid: 'c' },
    ]);
  });
});
