// @vitest-environment jsdom

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canOpenFlowSeparate,
  canAdoptFlowSaveAsHandle,
  flowSaveCleanCommit,
  flowRouteChoices,
  flowRouteSlotId,
  isMultiPaneFlowRouteFile,
  type FlowRouteChoice,
} from '../../src/editor/flow/flow-routing.js';

const multiPaneShellSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/editor/multi-pane-shell.ts'),
  'utf8',
);
const editorStyleSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/editor/style.css'),
  'utf8',
);

describe('multi-pane flow routing', () => {
  it('offers three slots and open separate for flows', () => {
    expect(flowRouteChoices().map((choice: FlowRouteChoice) => choice.id)).toEqual([
      'slot1',
      'slot2',
      'slot3',
      'separate',
    ]);
  });

  it('maps only slot route choices to pane slot ids', () => {
    expect(flowRouteSlotId('slot1')).toBe('slot1');
    expect(flowRouteSlotId('slot2')).toBe('slot2');
    expect(flowRouteSlotId('slot3')).toBe('slot3');
    expect(flowRouteSlotId('separate')).toBeNull();
  });

  it('only opens separate flow windows on desktop hosts that can spawn', () => {
    expect(canOpenFlowSeparate({ kind: 'electron', canSpawnWindow: true })).toBe(true);
    expect(canOpenFlowSeparate({ kind: 'electron', canSpawnWindow: false })).toBe(false);
    expect(canOpenFlowSeparate({ kind: 'browser', canSpawnWindow: true })).toBe(false);
    expect(canOpenFlowSeparate({ kind: 'tauri', canSpawnWindow: true })).toBe(false);
  });

  it('keeps flow saves dirty when edits land during the async write', () => {
    expect(flowSaveCleanCommit({ savedGen: 4, currentGen: 4 })).toEqual({
      clean: true,
      dirty: false,
    });
    expect(flowSaveCleanCommit({ savedGen: 4, currentGen: 5 })).toEqual({
      clean: false,
      dirty: true,
    });
  });

  it('recognizes flow files before per-slot document loading', () => {
    expect(isMultiPaneFlowRouteFile('round.cmflow')).toBe(true);
    expect(isMultiPaneFlowRouteFile('round.flowline.json')).toBe(true);
    expect(isMultiPaneFlowRouteFile('notes.json')).toBe(false);
    expect(isMultiPaneFlowRouteFile('brief.docx')).toBe(false);
  });

  it('refuses to adopt a Save As handle already owned elsewhere', () => {
    expect(canAdoptFlowSaveAsHandle({ owner: 'none', openInAnotherWindow: false })).toBe(true);
    expect(canAdoptFlowSaveAsHandle({ owner: 'self', openInAnotherWindow: false })).toBe(true);
    expect(canAdoptFlowSaveAsHandle({ owner: 'other', openInAnotherWindow: false })).toBe(false);
    expect(canAdoptFlowSaveAsHandle({ owner: 'none', openInAnotherWindow: true })).toBe(false);
  });

  it('routes multi-pane open prompts through the blurred pane route overlay', () => {
    expect(multiPaneShellSource).toContain("from './pane-route-overlay.js'");
    expect(multiPaneShellSource).toContain('showPaneRouteOverlay({');
    expect(multiPaneShellSource).not.toContain("overlay.className = 'pmd-route-overlay'");
    expect(multiPaneShellSource).not.toContain("dialog.className = 'pmd-route-dialog'");
    expect(multiPaneShellSource).not.toContain("row.className = 'pmd-route-buttons'");
    expect(multiPaneShellSource).not.toContain("btn.className = 'pmd-route-btn'");
  });

  it('autosaves saved multi-pane Flow records in place', () => {
    expect(multiPaneShellSource).toContain('function scheduleFlowAutosave');
    expect(multiPaneShellSource).toContain('function runFlowAutosave');
    expect(multiPaneShellSource).toContain("record.format !== 'cmflow'");
    expect(multiPaneShellSource).toContain('await host.saveExisting(record.handle, bytes)');
  });

  it('marks flow panes so document-only footer chrome is hidden while the pane header remains', () => {
    expect(multiPaneShellSource).toContain("this.paneEl.classList.toggle('pmd-pane-flow', isFlowRecord(rec))");
    expect(editorStyleSource).toContain('.pmd-pane.pmd-pane-flow .pmd-pane-footer');
    expect(editorStyleSource).not.toContain('.pmd-pane.pmd-pane-flow .pmd-pane-chip,\n.pmd-pane.pmd-pane-flow .pmd-pane-footer');
  });
});
