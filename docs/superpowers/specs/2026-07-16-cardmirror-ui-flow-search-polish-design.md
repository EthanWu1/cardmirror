# CardMirror UI, Flow, and Search Polish Design

Date: 2026-07-16

## Goal

Make CardMirror feel more like a focused desktop writing app while fixing the specific usability problems reported in the current build:

- Move Home and Settings into the left ribbon command cluster.
- Open the desktop app maximized by default.
- Make Search Everything fast enough that typing does not freeze the app.
- Clean up the home and settings surfaces so they use fewer shades and clearer icons.
- Make native Flow match Verba Flowline instead of looking like a generic CardMirror grid.
- Replace the boxed three-pane route picker with an in-place blurred document routing interaction.

This spec supersedes the earlier Flow styling direction in `2026-07-16-cardmirror-flow-design.md` where it conflicts with the user's later request that Flow look identical to Verba Flowline.

## Scope

In scope:

- Renderer chrome changes in `index.html`, `src/editor/style.css`, and the ribbon tests.
- Home screen layout and icons in `src/editor/home-screen.ts`.
- Settings visual simplification in `src/editor/settings-ui.ts` and settings CSS.
- Desktop default window sizing in `apps/desktop/src/main.ts`.
- Search Everything performance in `src/editor/quick-card-search-ui.ts`, `src/editor/file-search.ts`, and related tests.
- Flow workspace DOM/CSS changes under `src/editor/flow`.
- Three-pane route overlay behavior in `src/editor/pane-route-overlay.ts`, `src/editor/multi-pane-shell.ts`, and tests.

Out of scope:

- Reworking collaboration protocol behavior.
- Changing `.docx` save/conflict semantics.
- Replacing the existing icon generation pipeline.
- Rebuilding all modal dialogs.

## Ribbon And Window Chrome

The left file-operation stack becomes a 3 by 2 command grid:

- Row 1: Open, New, Save.
- Row 2: Autosave, Home, Settings.

Home and Settings keep their current command wiring in `index.ts`, but their DOM nodes move out of `.ribbon-right-grid` and into the left command stack. The right ribbon section should contain:

- Top presence avatars.
- The three custom window controls: minimize, maximize or restore, close.

This preserves the current frameless Electron window model while removing utility clutter from the far right.

The desktop app opens maximized by default using `BrowserWindow.maximize()` after window creation. It should not use exclusive fullscreen or kiosk behavior. Users can still restore the window with the maximize button.

## Search Everything Performance

The current palette does too much synchronous work per input event: it searches every source, sorts full result sets, and can re-render large result arrays. The fix is to keep the visible behavior but make the hot path bounded.

Implementation requirements:

- Debounce typed input briefly, targeting one search per animation frame or a short timer.
- Keep the input responsive immediately even while file lists or evidence rows are still indexing.
- Precompute lowercase search keys for file entries and evidence rows after they are loaded.
- Cap each source before merging, then cap the merged list before rendering.
- Keep file and evidence parsing off the input hot path. It should continue in idle chunks and rerun search only when fresh rows arrive.
- Preserve keyboard navigation and Enter behavior.

Search results should still include commands, settings, quick cards, dropzone, files, and evidence mode results where supported. Empty query behavior stays unchanged.

## Home Screen

The home screen should read as a simple Word-like start surface:

- Gray app background instead of a bright white surface.
- Sidebar actions remain compact.
- Search bar width should match the result list width.
- Icons should be visually distinct:
  - Open: folder.
  - New: document.
  - Cards: card/bookmark-style icon.
  - Flow: grid/table-style icon.
  - Convert: refresh/transfer-style icon.
  - Settings, if surfaced on home, uses gear only.
- Remove visual busyness from repeated chips and bubbles.

The home screen should remain usable when no document is open and when returning from a document. It should not hide important recents or Flow recents.

## Settings Panel

Settings should keep the left navigation layout but use fewer competing shades:

- One ribbon-gray header.
- One left-nav gray surface.
- One white/content surface.
- Rows separated by subtle dividers, not stacked fills.
- Active tab uses a single muted hover/selected fill.
- Inputs and buttons use the same visual language as ribbon controls.

The goal is less contrast noise, not a full settings architecture rewrite. Existing categories, setting metadata, deep links, and row controls remain intact.

## Flow Workspace

Native Flow should visually and structurally match Verba Flowline rather than the current CardMirror grid.

Target structure:

- A Flowline shell with a table-like sheet.
- Sticky column headers and row headers.
- Compact spreadsheet cells with `cell-value` rendering.
- A focused editor overlay for the active cell.
- Bottom sheet tabs for AFF/NEG sheets and round/title controls.
- Flowline-style selection frame and active-cell styling.

Use the existing CardMirror `.cmflow` model and file format. The change is presentation and interaction structure, not a new storage format.

Flow can still live inside a CardMirror pane or separate window. If three-pane mode is active, opening or creating a Flow routes through the pane route interaction or opens separately.

## Three-Pane Route Picker

The route picker should stop feeling like a modal slot dialog. It should blur the live document area itself.

Behavior:

- No boxed dialog in the center.
- The current document area receives a heavy blur/dim overlay.
- If no pane is open, clicking the blurred document area opens into the first slot.
- If panes are open, moving near the left or right edge previews where the incoming document will go.
- Existing panes animate aside to make room for the incoming pane.
- The user can add into an existing visible section, not only empty slots.
- A small bottom circular pill opens the document separately.
- Escape or the close affordance cancels.

This should be implemented through classes and transform transitions, not by rebuilding the full multi-pane layout on every mouse move.

## Testing

Add or update focused tests for:

- Ribbon DOM: Home and Settings are in the left command stack; right grid only contains window controls.
- Desktop window behavior: createWindow maximizes by default without fullscreen.
- Search Everything: input search does not synchronously parse evidence files; result rendering is capped; async indexing can refresh results.
- Home screen: action icons/classes and search/result widths are stable.
- Settings CSS: fewer surface tokens and the expected left-nav layout remain.
- Flow workspace: renders Flowline shell, sheet table, row/column headers, tabs, and active cell classes.
- Pane route overlay: renders blur routing layer, edge targets, separate pill, and dispatches selected route.

Manual verification after implementation:

- Start the desktop app and confirm it opens maximized.
- Type rapidly in Search Everything with a large file-search folder configured.
- Open Settings and confirm rows/buttons remain visible on hover.
- Create a Flow and compare it to Verba Flowline.
- In three-pane mode, open a new doc and confirm the routing blur/edge animation feels clear.

## Risks And Mitigations

Search performance risk:
Large `.docx` parsing is still CPU-heavy. The mitigation is to keep parsing out of the input event and only surface results when the index is ready.

Flow fidelity risk:
Verba Flowline is an add-in UI with its own assumptions. CardMirror should copy the visual and interaction structure while keeping CardMirror's native file model.

Three-pane animation risk:
Animating live editor panes can cause layout jank if it changes actual pane sizes too often. Preview should use transforms during hover and commit the real layout only on click.

Theme risk:
Changing shared color tokens can break contrast elsewhere. Prefer scoped CSS updates for home/settings/route/Flow unless a token change is clearly app-wide.

