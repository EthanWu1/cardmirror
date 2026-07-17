export function shouldShowHomeAfterBlankBoot(_opts: {
  isFirstWindow: boolean;
  modeSwitchPending: boolean;
}): boolean {
  return true;
}

export interface InitialDocBootPayloadLike {
  name?: string | null;
  filename?: string | null;
  path?: string | null;
  format?: string | null;
  joinShareCode?: string | null;
  resumeRoomId?: string | null;
}

export function shouldDeferFlowOpen(
  target: InitialDocBootPayloadLike | null | undefined,
): boolean {
  if (!target) return false;
  if (String(target.format ?? '').toLowerCase() === 'cmflow') return true;
  return [target.name, target.filename, target.path].some((value) =>
    String(value ?? '').toLowerCase().endsWith('.cmflow'),
  );
}

export function shouldHandleInitialDocPayload(
  payload: InitialDocBootPayloadLike | null | undefined,
): boolean {
  if (!payload) return false;
  if (payload.joinShareCode || payload.resumeRoomId) return true;
  return !shouldDeferFlowOpen(payload);
}
