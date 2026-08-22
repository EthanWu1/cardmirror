export type FlowRouteChoiceId = 'slot1' | 'slot2' | 'slot3' | 'separate';
export type FlowRouteSlotId = Exclude<FlowRouteChoiceId, 'separate'>;

export type FlowRouteChoice =
  | { id: FlowRouteSlotId; label: string }
  | { id: 'separate'; label: 'Open Separate' };

export function flowRouteChoices(): FlowRouteChoice[] {
  return [
    { id: 'slot1', label: '1' },
    { id: 'slot2', label: '2' },
    { id: 'slot3', label: '3' },
    { id: 'separate', label: 'Open Separate' },
  ];
}

export function flowRouteSlotId(choiceId: FlowRouteChoiceId): FlowRouteSlotId | null {
  return choiceId === 'separate' ? null : choiceId;
}

export function canOpenFlowSeparate(host: {
  kind: 'browser' | 'electron' | 'tauri';
  canSpawnWindow: boolean;
}): boolean {
  return host.kind === 'electron' && host.canSpawnWindow;
}

export function flowSaveCleanCommit(opts: { savedGen: number; currentGen: number }): {
  clean: boolean;
  dirty: boolean;
} {
  const clean = opts.savedGen === opts.currentGen;
  return { clean, dirty: !clean };
}

export function isMultiPaneFlowRouteFile(name: string | null | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return lower.endsWith('.cmflow') || lower.endsWith('.flowline.json');
}

export function canAdoptFlowSaveAsHandle(opts: {
  owner: 'none' | 'self' | 'other';
  openInAnotherWindow: boolean;
}): boolean {
  return !opts.openInAnotherWindow && opts.owner !== 'other';
}
