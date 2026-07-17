import type { FlowRound } from './flow-model.js';

export type OpenedFlowFormat = 'cmflow' | 'flowline-json';
export type FlowReplacementChoice = 'save' | 'discard' | 'cancel';
export type FlowReplacementDecision = 'proceed' | 'abort';

export function flowFormatForFilename(name: string | null | undefined): OpenedFlowFormat | null {
  if (!name) return null;
  const lower = name.toLowerCase();
  if (lower.endsWith('.cmflow')) return 'cmflow';
  if (lower.endsWith('.flowline.json')) return 'flowline-json';
  return null;
}

export function suggestedFlowSaveName(name: string | null | undefined): string {
  const fallback = 'flow.cmflow';
  if (!name) return fallback;
  if (/\.flowline\.json$/i.test(name)) return name.replace(/\.flowline\.json$/i, '.cmflow');
  if (/\.json$/i.test(name)) return name.replace(/\.json$/i, '.cmflow');
  return name;
}

export function flowDirtyEquals(round: FlowRound, baselineJson: string | null): boolean {
  if (baselineJson === null) return true;
  return JSON.stringify(round) !== baselineJson;
}

export function flowBaselineForRound(round: FlowRound): string {
  return JSON.stringify(round);
}

export function shouldClearFlowStateBeforeBlankDocMount(activeFlowWorkspace: unknown | null | undefined): boolean {
  return activeFlowWorkspace != null;
}

export async function resolveFlowReplacementDecision(opts: {
  activeDirty: boolean;
  pristineStarter: boolean;
  prompt: () => FlowReplacementChoice | Promise<FlowReplacementChoice>;
  save: () => boolean | Promise<boolean>;
  discard: () => void | Promise<void>;
}): Promise<FlowReplacementDecision> {
  if (!opts.activeDirty) return 'proceed';

  const choice = await opts.prompt();
  if (choice === 'cancel') return 'abort';
  if (choice === 'discard') {
    await opts.discard();
    return 'proceed';
  }
  return (await opts.save()) ? 'proceed' : 'abort';
}
