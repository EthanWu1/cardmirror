import { describe, expect, it, vi } from 'vitest';
import {
  buildRibbonKeymap,
  DEFAULT_RIBBON_KEYS,
  RIBBON_COMMAND_IDS,
  RIBBON_COMMAND_LABELS,
  ribbonCommandForKey,
  runRibbonCommand,
} from '../../src/editor/ribbon-commands.js';
import { availableRibbonCommandIds } from '../../src/editor/ribbon-availability.js';

describe('flow ribbon commands', () => {
  it('exposes native flow commands and keeps legacy Excel command separate', () => {
    expect(RIBBON_COMMAND_IDS).toContain('createFlow');
    expect(RIBBON_COMMAND_IDS).toContain('addAffFlow');
    expect(RIBBON_COMMAND_IDS).toContain('addNegFlow');
    expect(RIBBON_COMMAND_IDS).toContain('openFlow');
    expect(RIBBON_COMMAND_IDS).toContain('importFlowlineJson');
    expect(RIBBON_COMMAND_IDS).toContain('exportFlowlineJson');
    expect(RIBBON_COMMAND_IDS).toContain('flowFind');
    expect(RIBBON_COMMAND_IDS).toContain('flowSaveNow');
    expect(RIBBON_COMMAND_IDS).toContain('createLegacyExcelFlow');
    expect(RIBBON_COMMAND_LABELS.createFlow).toBe('Create Flow');
    expect(RIBBON_COMMAND_LABELS.addAffFlow).toBe('Add AFF Flow');
    expect(RIBBON_COMMAND_LABELS.addNegFlow).toBe('Add NEG Flow');
    expect(RIBBON_COMMAND_LABELS.createLegacyExcelFlow).toBe('Create Excel Flow (Legacy)');
    expect(RIBBON_COMMAND_LABELS.startFlowHost).toBe('Start Excel Flow Bridge');
  });

  it('runs native flow commands through RibbonContext', () => {
    const createFlow = vi.fn();
    const addAffFlow = vi.fn();
    const addNegFlow = vi.fn();
    const openFlow = vi.fn();
    const importFlowlineJson = vi.fn();
    const exportFlowlineJson = vi.fn();
    const flowFind = vi.fn();
    const flowSaveNow = vi.fn();
    const createLegacyExcelFlow = vi.fn();
    const ctx = {
      createFlow,
      addAffFlow,
      addNegFlow,
      openFlow,
      importFlowlineJson,
      exportFlowlineJson,
      flowFind,
      flowSaveNow,
      createLegacyExcelFlow,
    } as never;

    runRibbonCommand('createFlow', ctx);
    runRibbonCommand('addAffFlow', ctx);
    runRibbonCommand('addNegFlow', ctx);
    runRibbonCommand('openFlow', ctx);
    runRibbonCommand('importFlowlineJson', ctx);
    runRibbonCommand('exportFlowlineJson', ctx);
    runRibbonCommand('flowFind', ctx);
    runRibbonCommand('flowSaveNow', ctx);
    runRibbonCommand('createLegacyExcelFlow', ctx);

    expect(createFlow).toHaveBeenCalled();
    expect(addAffFlow).toHaveBeenCalled();
    expect(addNegFlow).toHaveBeenCalled();
    expect(openFlow).toHaveBeenCalled();
    expect(importFlowlineJson).toHaveBeenCalled();
    expect(exportFlowlineJson).toHaveBeenCalled();
    expect(flowFind).toHaveBeenCalled();
    expect(flowSaveNow).toHaveBeenCalled();
    expect(createLegacyExcelFlow).toHaveBeenCalled();
  });

  it('uses keymap-compatible Flowline shortcut defaults without overriding Save', () => {
    expect(ribbonCommandForKey('Mod-Alt-f')).toBe('flowFind');
    expect(ribbonCommandForKey('Mod-Alt-Shift-s')).toBe('flowSaveNow');
    expect(ribbonCommandForKey('Mod-Shift-o')).toBe('openFlow');
    expect(DEFAULT_RIBBON_KEYS.save).toBe('Mod-s');
    expect(DEFAULT_RIBBON_KEYS.flowSaveNow).not.toBe(DEFAULT_RIBBON_KEYS.save);
    expect(DEFAULT_RIBBON_KEYS.flowSaveNow).not.toBe(DEFAULT_RIBBON_KEYS.saveSendDoc);
    expect(ribbonCommandForKey('Mod-s')).toBe('save');
    expect(ribbonCommandForKey('Mod-Alt-s')).toBe('saveSendDoc');
  });

  it('dispatches Flow Save with a real keymap binding distinct from Save Send Doc', () => {
    const flowSaveNow = vi.fn();
    const saveSendDoc = vi.fn();
    const keymap = buildRibbonKeymap({}, { flowSaveNow, saveSendDoc } as never);

    expect(keymap['Mod-Alt-Shift-s']).toBeDefined();
    expect(keymap['Mod-Alt-s']).toBeDefined();
    keymap['Mod-Alt-Shift-s']!({} as never, () => {}, undefined);
    keymap['Mod-Alt-s']!({} as never, () => {}, undefined);

    expect(flowSaveNow).toHaveBeenCalledTimes(1);
    expect(saveSendDoc).toHaveBeenCalledTimes(1);
  });

  it('does not use runRibbonCommand as a fake ProseMirror command runner', () => {
    expect(() => runRibbonCommand('toggleBold' as never)).toThrow(/viewless commands/);
  });

  it('keeps native Flow available off Windows while hiding the legacy Excel bridge', () => {
    const available = availableRibbonCommandIds();
    expect(available).toContain('createFlow');
    expect(available).toContain('addAffFlow');
    expect(available).toContain('addNegFlow');
    expect(available).not.toContain('sendToFlowColumn');
    expect(available).not.toContain('sendToFlowCell');
    expect(available).not.toContain('sendHeadingsToFlowColumn');
    expect(available).not.toContain('sendHeadingsToFlowCell');
    expect(available).not.toContain('pullFromFlow');
    expect(available).not.toContain('createLegacyExcelFlow');
    expect(available).not.toContain('startFlowHost');
  });
});
