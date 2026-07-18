/**
 * Mode-switch marker: the handoff record carried across the reload a
 * `multiDocWorkspace` toggle triggers.
 *
 * Before reloading, the initiating window journals the docs that should reopen
 * and writes this marker to sessionStorage. After the reload, startup recovery
 * auto-opens exactly the listed docs and leaves unrelated recovery journals
 * alone for the normal recovery sidebar.
 */

export interface ModeSwitchDoc {
  uid: string;
  dirty: boolean;
}

interface ModeSwitchMarkerPayload {
  docs: ModeSwitchDoc[];
  toMultiDoc?: boolean;
}

export function encodeModeSwitchMarker(
  docs: ModeSwitchDoc[],
  opts: { toMultiDoc?: boolean } = {},
): string {
  const payload: ModeSwitchMarkerPayload = { docs };
  if (typeof opts.toMultiDoc === 'boolean') payload.toMultiDoc = opts.toMultiDoc;
  return JSON.stringify(payload);
}

/** Decode a marker read back from sessionStorage. `null` input means no mode
 *  switch happened. A malformed marker still means a switch happened, so return
 *  an empty list and prevent unrelated journals from being swept in. */
export function decodeModeSwitchMarker(raw: string | null): ModeSwitchDoc[] | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { docs?: unknown };
    if (!Array.isArray(parsed.docs)) return [];
    return parsed.docs.filter(
      (d): d is ModeSwitchDoc =>
        typeof d === 'object' &&
        d !== null &&
        typeof (d as ModeSwitchDoc).uid === 'string' &&
        typeof (d as ModeSwitchDoc).dirty === 'boolean',
    );
  } catch {
    return [];
  }
}

/** Direction carried by the mode-switch marker. Older markers omitted this and
 *  should behave like the historical all-docs handoff, so invalid/missing input
 *  returns null instead of inventing a direction. */
export function decodeModeSwitchTarget(raw: string | null): boolean | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { toMultiDoc?: unknown };
    return typeof parsed.toMultiDoc === 'boolean' ? parsed.toMultiDoc : null;
  } catch {
    return null;
  }
}

/** Choose which journal reports should be reopened after the reload. Single to
 *  three-pane keeps only the current local document so it lands in slot 1
 *  instead of sweeping every open window into the workspace. Other switches keep
 *  the already-scoped local + remote list. */
export function modeSwitchReopenDocsForLayoutSwitch(
  localDocs: ModeSwitchDoc[],
  remoteDocs: ModeSwitchDoc[],
  switchingToMultiDoc: boolean,
): ModeSwitchDoc[] {
  if (switchingToMultiDoc) return localDocs.slice(0, 1);
  return [...localDocs, ...remoteDocs];
}

/** uid to was-dirty-before-the-switch, for scoping + journal cleanup. */
export function modeSwitchDirtyMap(docs: ModeSwitchDoc[]): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const d of docs) {
    // A uid reported dirty by any channel stays dirty; losing an unsaved-changes
    // flag is worse than a redundant close prompt.
    map.set(d.uid, (map.get(d.uid) ?? false) || d.dirty);
  }
  return map;
}
