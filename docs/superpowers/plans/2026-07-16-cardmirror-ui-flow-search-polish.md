# CardMirror UI Flow Search Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the CardMirror desktop UI, make Search Everything responsive, make native Flow match Verba Flowline, and replace the boxed three-pane route picker with an in-place blurred routing interaction.

**Architecture:** Keep the existing editor, Flow file model, and multi-pane model. Move DOM nodes and CSS scopes where possible; add small focused helpers for search scheduling/cache rather than restructuring the command palette. Flow changes replace the current grid presentation with a Flowline-like DOM while preserving `.cmflow` persistence.

**Tech Stack:** TypeScript, Electron, ProseMirror, Vitest/jsdom, CSS, existing Untitled UI mask icon system.

---

## File Structure

- `index.html`: move Home/Settings into the left ribbon command stack and leave right grid for window controls.
- `apps/desktop/src/main.ts`: maximize the BrowserWindow after creation.
- `src/editor/index.ts`: keep button wiring working after DOM move.
- `src/editor/home-screen.ts`: update action icon classes and keep search/result width alignment.
- `src/editor/quick-card-search-ui.ts`: add debounced search scheduling, bounded source merging, and cached search keys.
- `src/editor/file-search.ts`: add precomputed searchable keys for file/evidence rows while preserving existing public APIs.
- `src/editor/settings-ui.ts`: keep structure, rely on CSS cleanup.
- `src/editor/style.css`: ribbon/home/settings/search/route/Flow style updates.
- `src/editor/flow/flow-workspace.ts`: render Flowline-like shell/table/tabs/active cell instead of textarea grid.
- `src/editor/flow/flow-workspace.css`: port Verba Flowline visual structure.
- `src/editor/pane-route-overlay.ts`: route overlay state/classes for edge hover and separate pill.
- `src/editor/multi-pane-shell.ts`: pass active slot/doc context and add route overlay preview classes if needed.
- Tests under `tests/editor` and `tests/desktop`: update expectations and add regression checks.

---

### Task 1: Ribbon Left 3x2 And Default Maximized Window

**Files:**
- Modify: `index.html`
- Modify: `apps/desktop/src/main.ts`
- Test: `tests/editor/ribbon-right-grid.test.ts`
- Test: `tests/desktop/window-controls.test.ts`

- [ ] **Step 1: Write/update the ribbon DOM test**

Add assertions that `settings-btn` and `home-btn` are inside the left file stack and absent from `.ribbon-right-grid`.

```ts
it('moves Home and Settings into the left file command stack', () => {
  const parsed = new DOMParser().parseFromString(indexHtml, 'text/html');
  const fileStack = parsed.querySelector('#file-command-stack');
  const rightGrid = parsed.querySelector('.ribbon-right-grid');

  expect(fileStack).not.toBeNull();
  expect(fileStack!.querySelector('#open-btn')).not.toBeNull();
  expect(fileStack!.querySelector('#new-btn')).not.toBeNull();
  expect(fileStack!.querySelector('#export-btn')).not.toBeNull();
  expect(fileStack!.querySelector('#autosave-btn')).not.toBeNull();
  expect(fileStack!.querySelector('#home-btn')).not.toBeNull();
  expect(fileStack!.querySelector('#settings-btn')).not.toBeNull();
  expect(rightGrid!.querySelector('#home-btn')).toBeNull();
  expect(rightGrid!.querySelector('#settings-btn')).toBeNull();
});
```

- [ ] **Step 2: Run the failing ribbon test**

Run: `npm.cmd test -- tests/editor/ribbon-right-grid.test.ts`

Expected: FAIL because `#file-command-stack` does not exist and Home/Settings are still in the right grid.

- [ ] **Step 3: Move the DOM nodes**

In `index.html`, change the unnamed file stack to:

```html
<div id="file-command-stack" class="ribbon-button-stack ribbon-file-command-stack">
  <button id="open-btn" type="button" title="Open a document" aria-label="Open"><span class="pmd-icon pmd-icon-open" aria-hidden="true"></span></button>
  <button id="new-btn" type="button" title="New document" aria-label="New document"><span class="pmd-icon pmd-icon-new" aria-hidden="true"></span></button>
  <button id="export-btn" type="button" disabled title="Save" aria-label="Save"><span class="pmd-icon pmd-icon-save" aria-hidden="true"></span></button>
  <button id="autosave-btn" type="button" aria-pressed="false" title="Autosave is off - click to turn on" aria-label="Toggle autosave"><span class="pmd-icon pmd-icon-autosave" aria-hidden="true"></span></button>
  <button id="home-btn" type="button" class="ribbon-home-btn" title="Home" aria-label="Home"><span class="pmd-icon pmd-icon-home" aria-hidden="true"></span></button>
  <button id="settings-btn" type="button" title="Settings" aria-label="Settings"><span class="pmd-icon pmd-icon-settings" aria-hidden="true"></span></button>
</div>
```

Then remove Home/Settings from `.ribbon-right-grid`, leaving:

```html
<div class="ribbon-right-grid">
  <button id="window-minimize-btn" class="ribbon-window-btn" type="button" title="Minimize" aria-label="Minimize window"><span class="pmd-icon pmd-icon-minus" aria-hidden="true"></span></button>
  <button id="window-maximize-btn" class="ribbon-window-btn" type="button" title="Maximize or restore" aria-label="Maximize or restore window"><span class="pmd-icon pmd-icon-expand" aria-hidden="true"></span></button>
  <button id="window-close-btn" class="ribbon-window-btn ribbon-window-close-btn" type="button" title="Close" aria-label="Close window"><span class="pmd-icon pmd-icon-close" aria-hidden="true"></span></button>
</div>
```

- [ ] **Step 4: Add CSS for the 3x2 file command stack**

In `src/editor/style.css`, add a scoped rule near the ribbon stack rules:

```css
.ribbon-file-command-stack {
  grid-template-columns: repeat(3, 1.45rem);
  grid-template-rows: repeat(2, 1.45rem);
}
```

- [ ] **Step 5: Add/update desktop maximize test**

In `tests/desktop/window-controls.test.ts`, assert the main process source calls `maximize()` near window creation:

```ts
it('maximizes new desktop windows by default without fullscreen', async () => {
  const mainSource = await fs.readFile(path.join(process.cwd(), 'apps', 'desktop', 'src', 'main.ts'), 'utf8');
  expect(mainSource).toContain('win.maximize();');
  expect(mainSource).not.toContain('fullscreen: true');
  expect(mainSource).not.toContain('kiosk: true');
});
```

- [ ] **Step 6: Implement desktop maximize**

After the `BrowserWindow` is constructed in `createWindow`, add:

```ts
  win.maximize();
```

Do not add `fullscreen: true` or `kiosk: true`.

- [ ] **Step 7: Run targeted tests**

Run:

```powershell
npm.cmd test -- tests/editor/ribbon-right-grid.test.ts tests/desktop/window-controls.test.ts
```

Expected: PASS.

---

### Task 2: Search Everything Hot-Path Performance

**Files:**
- Modify: `src/editor/file-search.ts`
- Modify: `src/editor/quick-card-search-ui.ts`
- Test: `tests/editor/file-search.test.ts`
- Test: `tests/editor/quick-card-search-ui-flow.test.ts`

- [ ] **Step 1: Add tests for cached search keys**

In `tests/editor/file-search.test.ts`, add a test that file entries can carry a cached lowercase search key and still rank the same.

```ts
it('uses precomputed file search text when available', () => {
  const files = [
    { path: '/root/AFF/Health Care.docx', relPath: 'AFF/Health Care.docx', name: 'Health Care', mtimeMs: 2, searchText: 'health care aff' },
    { path: '/root/NEG/Economy.cmir', relPath: 'NEG/Economy.cmir', name: 'Economy', mtimeMs: 3, searchText: 'economy neg' },
  ];
  expect(searchFiles(files, 'aff')[0].name).toBe('Health Care');
});
```

- [ ] **Step 2: Add helper types and cached-key support**

In `src/editor/file-search.ts`, extend `FileEntry` and `EvidenceSearchRow` with optional keys:

```ts
searchText?: string;
```

Add helpers:

```ts
function fileSearchText(f: FileEntry): string {
  return f.searchText ?? `${f.name.toLowerCase()} ${dirName(f.relPath).toLowerCase()}`;
}

function evidenceSearchText(row: EvidenceSearchRow): string {
  return row.searchText ?? `${row.text.toLowerCase()} ${row.label.toLowerCase()} ${row.fileName.toLowerCase()} ${dirName(row.relPath).toLowerCase()}`;
}
```

Update `searchFiles` and `searchEvidenceRows` to use these helpers instead of recomputing lowercased fields repeatedly.

- [ ] **Step 3: Add capped merge helper test**

In `tests/editor/quick-card-search-ui-flow.test.ts`, add a source-level assertion by exporting a small pure helper from the UI module:

```ts
import { capResultsForRender } from '../../src/editor/quick-card-search-ui';

it('caps result arrays before render', () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ source: 'command', name: `Command ${i}`, meta: '', matchedName: true, snippet: null }));
  expect(capResultsForRender(rows as any, 80)).toHaveLength(80);
});
```

- [ ] **Step 4: Implement bounded render helpers**

In `src/editor/quick-card-search-ui.ts`, add:

```ts
const SOURCE_RESULT_LIMIT = 60;
const MERGED_RESULT_LIMIT = 180;

export function capResultsForRender<T>(rows: readonly T[], limit = MERGED_RESULT_LIMIT): T[] {
  return rows.length <= limit ? [...rows] : rows.slice(0, limit);
}

function sourceCap(rows: PaletteResult[]): PaletteResult[] {
  return capResultsForRender(rows, SOURCE_RESULT_LIMIT);
}
```

Apply `sourceCap(...)` to each source in no-prefix Search Everything before merging, then apply `capResultsForRender(..., MERGED_RESULT_LIMIT)` to the merged array before `finishSearch()`.

- [ ] **Step 5: Debounce input search**

Replace direct input handler:

```ts
this.input.addEventListener('input', () => this.runSearch());
```

with a scheduled search:

```ts
this.input.addEventListener('input', () => this.scheduleSearch());
```

Add fields:

```ts
private searchRaf = 0;
private searchTimer = 0;
```

Add methods:

```ts
private scheduleSearch(): void {
  if (this.searchRaf) cancelAnimationFrame(this.searchRaf);
  if (this.searchTimer) window.clearTimeout(this.searchTimer);
  this.searchRaf = requestAnimationFrame(() => {
    this.searchRaf = 0;
    this.runSearch();
  });
}
```

In `close()`, cancel any pending frame/timer.

- [ ] **Step 6: Keep evidence parsing off the hot path**

In `loadEvidenceRows`, keep the existing async loop but add cached search text when creating rows:

```ts
const extracted = extractEvidenceRows(doc, entry).map((row) => ({
  ...row,
  searchText: `${row.text.toLowerCase()} ${row.label.toLowerCase()} ${row.fileName.toLowerCase()} ${dirName(row.relPath).toLowerCase()}`,
}));
```

- [ ] **Step 7: Run targeted search tests**

Run:

```powershell
npm.cmd test -- tests/editor/file-search.test.ts tests/editor/quick-card-search-ui-flow.test.ts
```

Expected: PASS.

---

### Task 3: Home Screen Icons And Settings Visual Simplification

**Files:**
- Modify: `src/editor/home-screen.ts`
- Modify: `src/editor/style.css`
- Test: `tests/editor/home-screen-flow.test.ts`
- Test: `tests/editor/mac-word-light-theme.test.ts`

- [ ] **Step 1: Write/update home icon test**

In `tests/editor/home-screen-flow.test.ts`, assert the action icons are distinct:

```ts
expect(document.querySelector('.pmd-home-action [class*="pmd-icon-open"]')).not.toBeNull();
expect(document.querySelector('.pmd-home-action [class*="pmd-icon-new"]')).not.toBeNull();
expect(document.querySelector('.pmd-home-action [class*="pmd-icon-bookmark"]')).not.toBeNull();
expect(document.querySelector('.pmd-home-action [class*="pmd-icon-grid"]')).not.toBeNull();
expect(document.querySelector('.pmd-home-action [class*="pmd-icon-reset"]')).not.toBeNull();
```

- [ ] **Step 2: Update action icon assignments**

In `src/editor/home-screen.ts`, render:

```ts
actions.appendChild(this.actionCard('OPEN', '', this.actionRunners[0]!, { icon: 'pmd-icon-open' }));
actions.appendChild(this.actionCard('NEW', '', this.actionRunners[1]!, { icon: 'pmd-icon-new' }));
actions.appendChild(this.actionCard('CARDS', '', this.actionRunners[2]!, { icon: 'pmd-icon-bookmark' }));
actions.appendChild(this.actionCard('FLOW', '', this.actionRunners[3]!, { icon: 'pmd-icon-grid' }));
actions.appendChild(this.actionCard('CONVERT', '', this.actionRunners[4]!, { icon: 'pmd-icon-reset' }));
```

If `pmd-icon-grid` does not exist, add it through the same CSS mask style used by the existing generated icon file only if the repo already contains a matching icon. Otherwise use `pmd-icon-table` if present.

- [ ] **Step 3: Simplify home CSS**

In `src/editor/style.css`, update home surface rules:

```css
.pmd-home-screen {
  background: var(--pmd-c-surface);
}

.pmd-home-main {
  background: var(--pmd-c-surface);
}

.pmd-home-search-section,
.pmd-home-recents,
.pmd-home-recents-header,
.pmd-home-sessions-section,
.pmd-home-flows-section {
  max-width: 760px;
}
```

- [ ] **Step 4: Simplify settings CSS**

Keep the left-nav structure but reduce shade noise:

```css
.pmd-settings-dialog {
  background: var(--pmd-c-bg);
  border-color: var(--pmd-c-ribbon-border);
}

.pmd-settings-tabs-bar {
  background: var(--pmd-c-ribbon);
  color: var(--pmd-c-ribbon-text);
}

.pmd-settings-list {
  background: var(--pmd-c-bg);
}

.pmd-settings-row {
  border-bottom: 1px solid var(--pmd-c-divider-faint);
}
```

- [ ] **Step 5: Update theme test expectations**

Update `tests/editor/mac-word-light-theme.test.ts` so it expects the simplified settings surfaces and does not require extra shade variation beyond header/nav/content.

- [ ] **Step 6: Run targeted tests**

Run:

```powershell
npm.cmd test -- tests/editor/home-screen-flow.test.ts tests/editor/mac-word-light-theme.test.ts
```

Expected: PASS.

---

### Task 4: Flowline-Like Native Flow Workspace

**Files:**
- Modify: `src/editor/flow/flow-workspace.ts`
- Modify: `src/editor/flow/flow-workspace.css`
- Test: `tests/editor/flow-workspace.test.ts`

- [ ] **Step 1: Write Flowline DOM test**

In `tests/editor/flow-workspace.test.ts`, assert:

```ts
expect(root.querySelector('.flowline-shell')).not.toBeNull();
expect(root.querySelector('.flowline-workspace')).not.toBeNull();
expect(root.querySelector('table.flowline-sheet')).not.toBeNull();
expect(root.querySelector('.sheet-tabs')).not.toBeNull();
expect(root.querySelector('.selection-frame')).not.toBeNull();
```

- [ ] **Step 2: Replace grid rendering with table rendering**

In `src/editor/flow/flow-workspace.ts`, render:

```ts
const shell = document.createElement('div');
shell.className = 'flowline-shell';
const workspace = document.createElement('div');
workspace.className = 'flowline-workspace';
const frame = document.createElement('div');
frame.className = 'sheet-frame';
const table = document.createElement('table');
table.className = 'flowline-sheet';
```

Render column headers in `thead` and row headers/cells in `tbody`. Each editable cell should contain:

```ts
const value = document.createElement('div');
value.className = 'cell-value';
value.textContent = cell.text;
td.appendChild(value);
```

Use a single active cell editor element:

```ts
const editor = document.createElement('textarea');
editor.className = 'cell-editor';
```

- [ ] **Step 3: Add active cell state**

Track active sheet/row/column in the workspace class. On cell click, position the editor over the cell and update the model on input. Keep the existing `onChange` callback.

- [ ] **Step 4: Port Flowline CSS**

Replace the current `.cm-flow-grid` CSS with Flowline class rules based on Verba's `taskpane.css`:

```css
.flowline-shell {
  display: grid;
  grid-template-rows: 1fr auto;
  height: 100%;
  background: #f3f3f3;
}

.flowline-workspace {
  overflow: auto;
}

.sheet-frame {
  position: relative;
  min-width: max-content;
}

.flowline-sheet {
  border-collapse: collapse;
  font-size: 12.5px;
}

.flowline-sheet th,
.flowline-sheet td {
  border: 1px solid #d0d0d0;
  min-width: 156px;
  height: 26px;
  padding: 0;
}

.cell-value {
  padding: 3px 6px;
  white-space: pre-wrap;
}

.cell-editor {
  position: absolute;
  z-index: 5;
  resize: none;
}

.selection-frame {
  position: absolute;
  border: 2px solid #217346;
  pointer-events: none;
}
```

- [ ] **Step 5: Run targeted Flow tests**

Run:

```powershell
npm.cmd test -- tests/editor/flow-workspace.test.ts tests/editor/flow-model.test.ts tests/editor/flow-file.test.ts
```

Expected: PASS.

---

### Task 5: Blurred Three-Pane Route Picker

**Files:**
- Modify: `src/editor/pane-route-overlay.ts`
- Modify: `src/editor/multi-pane-shell.ts`
- Modify: `src/editor/style.css`
- Test: `tests/editor/pane-route-overlay.test.ts`
- Test: `tests/editor/multi-pane-flow-routing.test.ts`

- [ ] **Step 1: Update overlay tests**

In `tests/editor/pane-route-overlay.test.ts`, assert the overlay uses blurred document routing classes:

```ts
expect(document.querySelector('.pmd-pane-route-overlay')).not.toBeNull();
expect(document.querySelector('.pmd-pane-route-blur-layer')).not.toBeNull();
expect(document.querySelector('.pmd-pane-route-edge-left')).not.toBeNull();
expect(document.querySelector('.pmd-pane-route-edge-right')).not.toBeNull();
expect(document.querySelector('.pmd-pane-route-separate')).not.toBeNull();
expect(document.querySelector('.pmd-pane-route-card')).toBeNull();
```

- [ ] **Step 2: Refactor overlay DOM**

In `src/editor/pane-route-overlay.ts`, keep the public `showPaneRouteOverlay` API but render:

```ts
const blur = document.createElement('button');
blur.className = 'pmd-pane-route-blur-layer';

const left = document.createElement('button');
left.className = 'pmd-pane-route-edge pmd-pane-route-edge-left';

const right = document.createElement('button');
right.className = 'pmd-pane-route-edge pmd-pane-route-edge-right';

const separate = document.createElement('button');
separate.className = 'pmd-pane-route-separate';
separate.textContent = 'Open separate';
```

Use `mouseenter`/`mouseleave` to add `pmd-pane-route-preview-left` or `pmd-pane-route-preview-right` on `document.body`.

- [ ] **Step 3: Add transform preview CSS**

In `src/editor/style.css`, replace card-like overlay styles:

```css
.pmd-pane-route-overlay {
  position: fixed;
  inset: var(--ribbon-height) 0 var(--status-bar-height) var(--nav-width);
  z-index: 1450;
  background: rgba(28, 28, 28, 0.18);
  backdrop-filter: blur(14px);
}

.pmd-pane-route-blur-layer {
  position: absolute;
  inset: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}

.pmd-pane-route-edge {
  position: absolute;
  top: 0;
  bottom: 0;
  width: min(18vw, 260px);
  border: 0;
  background: transparent;
  cursor: pointer;
}

.pmd-pane-route-edge-left { left: 0; }
.pmd-pane-route-edge-right { right: 0; }

.pmd-pane-route-edge::after {
  content: '+';
  position: absolute;
  top: 50%;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--pmd-c-accent);
  color: var(--pmd-c-text-on-accent);
  display: grid;
  place-items: center;
  opacity: 0;
  transform: translateY(-50%) scale(0.9);
  transition: opacity 140ms ease, transform 140ms ease;
}

.pmd-pane-route-edge:hover::after {
  opacity: 1;
  transform: translateY(-50%) scale(1);
}
```

- [ ] **Step 4: Add pane preview motion**

In CSS, add transform hints for the multi-pane row:

```css
body.pmd-pane-route-preview-left .pmd-multi-row {
  transform: translateX(18px);
  transition: transform 160ms ease;
}

body.pmd-pane-route-preview-right .pmd-multi-row {
  transform: translateX(-18px);
  transition: transform 160ms ease;
}
```

Remove the body preview classes when the overlay closes.

- [ ] **Step 5: Run targeted tests**

Run:

```powershell
npm.cmd test -- tests/editor/pane-route-overlay.test.ts tests/editor/multi-pane-flow-routing.test.ts
```

Expected: PASS.

---

### Task 6: Verification And Packaging

**Files:**
- No source files beyond previous tasks.

- [ ] **Step 1: Run all targeted test groups**

Run:

```powershell
npm.cmd test -- tests/editor/ribbon-right-grid.test.ts tests/desktop/window-controls.test.ts tests/editor/file-search.test.ts tests/editor/quick-card-search-ui-flow.test.ts tests/editor/home-screen-flow.test.ts tests/editor/mac-word-light-theme.test.ts tests/editor/flow-workspace.test.ts tests/editor/flow-model.test.ts tests/editor/flow-file.test.ts tests/editor/pane-route-overlay.test.ts tests/editor/multi-pane-flow-routing.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```powershell
npm.cmd run typecheck
```

Expected: PASS.

- [ ] **Step 3: Build renderer**

Run:

```powershell
npm.cmd run build
```

Expected: PASS.

- [ ] **Step 4: Build Windows installer**

Run:

```powershell
npm.cmd run desktop:dist
```

Expected: installer appears under `apps/desktop/release/`.

- [ ] **Step 5: Copy installer to Dropbox**

Run:

```powershell
Copy-Item -LiteralPath "apps\desktop\release\CardMirror Setup 0.1.0-beta.14.exe" -Destination "C:\Users\ethan\Dropbox\CardMirrorInstaller\CardMirror Setup 0.1.0-beta.14.exe" -Force
```

Expected: Dropbox installer is replaced.

