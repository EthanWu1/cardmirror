// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { createRound } from '../../src/editor/flow/flow-model.js';
import {
  flowBaselineForRound,
  flowDirtyEquals,
  flowFormatForFilename,
  resolveFlowReplacementDecision,
  shouldClearFlowStateBeforeBlankDocMount,
  suggestedFlowSaveName,
} from '../../src/editor/flow/flow-single-pane.js';

describe('single-pane flow helpers', () => {
  it('detects flow formats from filenames', () => {
    expect(flowFormatForFilename('round.cmflow')).toBe('cmflow');
    expect(flowFormatForFilename('round.flowline.json')).toBe('flowline-json');
    expect(flowFormatForFilename('round.docx')).toBe(null);
  });

  it('suggests cmflow save names for imported Flowline JSON', () => {
    expect(suggestedFlowSaveName('round.flowline.json')).toBe('round.cmflow');
    expect(suggestedFlowSaveName('round.json')).toBe('round.cmflow');
  });

  it('tracks dirty state by normalized JSON baseline', () => {
    const round = createRound({ format: 'ld', title: 'Round' });
    const baseline = JSON.stringify(round);
    expect(flowDirtyEquals(round, baseline)).toBe(false);
    expect(flowDirtyEquals({ ...round, title: 'Changed' }, baseline)).toBe(true);
    expect(flowDirtyEquals(round, null)).toBe(true);
  });

  it('creates a clean baseline for a newly created blank flow', () => {
    const round = createRound({ format: 'ld', title: 'Round' });
    const baseline = flowBaselineForRound(round);

    expect(flowDirtyEquals(round, baseline)).toBe(false);
    expect(flowDirtyEquals({ ...round, title: 'Changed' }, baseline)).toBe(true);
  });

  it('requires clearing flow state before mounting a blank document', () => {
    expect(shouldClearFlowStateBeforeBlankDocMount({})).toBe(true);
    expect(shouldClearFlowStateBeforeBlankDocMount(null)).toBe(false);
  });

  it('allows clean pristine flow replacement without prompting', async () => {
    const calls: string[] = [];
    const result = await resolveFlowReplacementDecision({
      activeDirty: false,
      pristineStarter: true,
      prompt: async () => {
        calls.push('prompt');
        return 'cancel' as const;
      },
      save: async () => {
        calls.push('save');
        return true;
      },
      discard: async () => {
        calls.push('discard');
      },
    });

    expect(result).toBe('proceed');
    expect(calls).toEqual([]);
  });

  it('prompts before replacing dirty content only', async () => {
    const dirtyCalls: string[] = [];
    const dirtyResult = await resolveFlowReplacementDecision({
      activeDirty: true,
      pristineStarter: true,
      prompt: async () => {
        dirtyCalls.push('prompt');
        return 'discard' as const;
      },
      save: async () => {
        dirtyCalls.push('save');
        return true;
      },
      discard: async () => {
        dirtyCalls.push('discard');
      },
    });

    const cleanNonPristineCalls: string[] = [];
    const cleanNonPristineResult = await resolveFlowReplacementDecision({
      activeDirty: false,
      pristineStarter: false,
      prompt: async () => {
        cleanNonPristineCalls.push('prompt');
        return 'cancel' as const;
      },
      save: async () => {
        cleanNonPristineCalls.push('save');
        return true;
      },
      discard: async () => {
        cleanNonPristineCalls.push('discard');
      },
    });

    expect(dirtyResult).toBe('proceed');
    expect(dirtyCalls).toEqual(['prompt', 'discard']);
    expect(cleanNonPristineResult).toBe('proceed');
    expect(cleanNonPristineCalls).toEqual([]);
  });

  it('continues replacement only after a successful save', async () => {
    const failedSaveCalls: string[] = [];
    const failedSaveResult = await resolveFlowReplacementDecision({
      activeDirty: true,
      pristineStarter: true,
      prompt: async () => {
        failedSaveCalls.push('prompt');
        return 'save' as const;
      },
      save: async () => {
        failedSaveCalls.push('save');
        return false;
      },
      discard: async () => {
        failedSaveCalls.push('discard');
      },
    });

    const savedCalls: string[] = [];
    const savedResult = await resolveFlowReplacementDecision({
      activeDirty: true,
      pristineStarter: true,
      prompt: async () => {
        savedCalls.push('prompt');
        return 'save' as const;
      },
      save: async () => {
        savedCalls.push('save');
        return true;
      },
      discard: async () => {
        savedCalls.push('discard');
      },
    });

    expect(failedSaveResult).toBe('abort');
    expect(failedSaveCalls).toEqual(['prompt', 'save']);
    expect(savedResult).toBe('proceed');
    expect(savedCalls).toEqual(['prompt', 'save']);
  });
});
