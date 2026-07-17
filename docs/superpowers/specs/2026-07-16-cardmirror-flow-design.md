# CardMirror Native Flow Design

Date: 2026-07-16

## Goal

Add a native Flow workspace to CardMirror based on the local Verba Flowline Word add-in, not Verbatim/Excel. Flow becomes a first-class CardMirror file type with its own home surface, open/save behavior, ribbon command, settings category, and three-pane routing.

## Source Reference

The behavior reference is the local Verba Flowline add-in:

- `C:\Users\ethan\OneDrive\Desktop\verba\public\word-addin\flowline-model.js`
- `C:\Users\ethan\OneDrive\Desktop\verba\public\word-addin\flowline-grid.js`
- `C:\Users\ethan\OneDrive\Desktop\verba\public\word-addin\flowline-store.js`
- `C:\Users\ethan\OneDrive\Desktop\verba\public\word-addin\taskpane.html`
- `C:\Users\ethan\OneDrive\Desktop\verba\public\word-addin\taskpane.css`
- `C:\Users\ethan\OneDrive\Desktop\verba\public\word-addin\taskpane.js`

The implementation should reuse the model/grid semantics where practical, but restyle and integrate the UI with CardMirror. It must not call Excel, open Verbatim Flow, or depend on the old Windows COM bridge for Create Flow.

## File Model

Introduce `.cmflow` as the native CardMirror flow file type.

The saved file is JSON with a small CardMirror wrapper:

```json
{
  "kind": "cardmirror-flow",
  "version": 1,
  "flowlineVersion": 34,
  "round": {
    "id": "round-...",
    "title": "Unnamed1",
    "format": "ld",
    "settings": {},
    "flows": []
  },
  "createdAt": "2026-07-16T00:00:00.000Z",
  "updatedAt": "2026-07-16T00:00:00.000Z"
}
```

`round` remains compatible with Verba Flowline's exported `.flowline.json` payload. CardMirror should:

- Open `.cmflow` directly.
- Import `.flowline.json` by reading its `round` payload or accepting a raw round object.
- Export a `.flowline.json` compatible payload for Verba Flowline.
- Normalize old or partial round payloads through the Flowline model.

## Flow Workspace

The Flow workspace is not a ProseMirror document. It is a separate view type with:

- LD, PF, and Policy presets.
- AFF/NEG flow tabs.
- Speech columns from Verba Flowline.
- Default 40 rows.
- Editable cells with multiline text.
- Range selection, copy, cut, paste, and TSV import/export behavior.
- Bold formatting for active cell or selected range.
- Find in the current flow.
- Add AFF / Add NEG flow buttons.
- Delete and reorder flow tabs.
- Round title editing.
- Zoom controls.
- Basic undo for sheet edits.

The UI should follow CardMirror's current Word-like gray chrome, using existing design tokens and dialog/button styles. It should not visually feel like an iframe or separate web app.

## Home Integration

The home sidebar gets a `FLOW` action. The home main area gets a bottom `Flows` section that lists recent `.cmflow` files.

Home search should include:

- `.docx`
- `.cmir`
- `.cmflow`

Actions:

- `FLOW` creates a new flow using the default Flow format setting.
- Opening a `.cmflow` from search or recents opens the Flow workspace.
- Opening a `.flowline.json` imports it as a Flow workspace and offers Save As `.cmflow` on first save.

## Ribbon Integration

Add ribbon command IDs for:

- `createFlow`
- `openFlow`
- `exportFlowlineJson`
- `importFlowlineJson`

`createFlow` must be available to custom ribbon buttons. It creates a CardMirror-native Flow, not an Excel workbook.

Existing old Verbatim/Excel Flow commands can stay for compatibility, but they should be clearly separated from the new native Flow commands in settings and command labels.

## Settings Integration

Add a new `Flow` settings category.

Move the old `flowHostOnLaunch` setting into this category as a legacy Excel/Verbatim bridge option.

Add settings for:

- Default Flow format: LD, PF, Policy.
- AFF color.
- NEG color.
- Selection color.
- Flow zoom default.
- Flow keyboard shortcuts.

Keyboard shortcuts should follow the Verba Flowline defaults where they do not collide with stronger CardMirror commands:

- Bold: Ctrl+B / Cmd+B mapping through CardMirror's existing key display rules.
- Find: Ctrl+Alt+F.
- Save Now: Ctrl+Alt+S.
- Edit Cell: F2.
- Open Flows: Ctrl+Shift+O.
- Command Palette: Ctrl+Shift+P.
- Previous Flow: Ctrl+ArrowLeft.
- Next Flow: Ctrl+ArrowRight.
- Add AFF: Ctrl+Shift+A.
- Add NEG: Ctrl+Shift+N.
- Zoom In: Ctrl+=.
- Zoom Out: Ctrl+-.
- Reset Zoom: Ctrl+0.

## Three-Pane Integration

In multi-pane mode, opening or creating a Flow prompts for a route:

- Slot 1
- Slot 2
- Slot 3
- Open Separate

If routed into a slot, the slot holds a Flow record instead of a document record. The slot title, close behavior, dirty state, save routing, and tab stack should work the same way as document records.

A Flow slot does not render a document outline. For this implementation, the nav area for that slot stays hidden to avoid misleading document outline behavior.

`Open Separate` opens the flow in a new CardMirror window if the desktop host can spawn a window. On web or if spawning fails, fall back to opening in the current window with a clear error toast.

## Save And Dirty State

Flow saves through CardMirror's host save APIs:

- Saved `.cmflow` files save in place.
- Unsaved flows use Save As and default to `.cmflow`.
- Imported `.flowline.json` starts dirty and saves as `.cmflow` unless the user explicitly exports.
- Dirty tracking compares the current normalized Flow wrapper with the last saved baseline.

Autosave applies to saved `.cmflow` files using the same per-file autosave preference model as `.cmir`. `.docx` behavior is unchanged.

## Error Handling

Expected errors:

- Invalid `.cmflow` JSON: show a CardMirror-style dialog saying the flow file could not be opened.
- Invalid `.flowline.json`: show a similar import error.
- Save fails: use the existing save failure surface.
- Three-pane slot route canceled: do nothing.
- Open Separate unsupported: show a toast and fall back to current window routing.
- Shortcut conflict: the settings UI should show the same conflict behavior used by existing ribbon shortcuts.

## Testing

Add tests for:

- `.cmflow` wrapper parse/serialize/normalize.
- `.flowline.json` import/export compatibility.
- Flow model operations ported from Verba Flowline: create round, add/delete/reorder flows, update cell, range TSV copy/paste, bold range.
- Home search/listing includes `.cmflow`.
- Home sidebar contains `FLOW`.
- `createFlow` appears in custom ribbon command options.
- Settings contains a `Flow` category and old `flowHostOnLaunch` moved there.
- Three-pane routing offers Slot 1, Slot 2, Slot 3, and Open Separate.
- Dirty tracking for changed and unchanged flows.
- Typecheck and build.

## Out Of Scope For First Pass

- Real-time coediting for `.cmflow`.
- Full Verba hosted storage or install ID behavior.
- Excel or Verbatim Flow automation.
- Quick Analytics beyond what is already represented by the Flowline model.
- A separate Flow-specific nav outline.
