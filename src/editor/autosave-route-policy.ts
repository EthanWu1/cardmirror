export type AutosaveRouteFormat = 'cmir' | 'docx' | 'cmflow' | 'flowline-json' | null;

export interface AutosaveRouteState {
  dirty: boolean;
  format: AutosaveRouteFormat;
  handle: unknown | null;
  supportsInPlaceSave: boolean;
  autosaveEnabled: boolean;
  forcedAutosave?: boolean;
}

function hasStableWritableHandle(handle: unknown): boolean {
  return typeof handle === 'string' && handle.trim().length > 0;
}

export function isAutosaveBackedRoute(state: AutosaveRouteState): boolean {
  if (state.format !== 'cmir' && state.format !== 'cmflow') return false;
  if (!hasStableWritableHandle(state.handle)) return false;
  if (!state.supportsInPlaceSave) return false;
  return state.autosaveEnabled || state.forcedAutosave === true;
}

export function shouldPromptBeforeRoute(state: AutosaveRouteState): boolean {
  return state.dirty && !isAutosaveBackedRoute(state);
}
