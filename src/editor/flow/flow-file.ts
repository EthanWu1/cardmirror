import { flowlineVersion, normalizeRound, type FlowRound } from './flow-model.js';

const FLOW_FILE_KIND = 'cardmirror-flow';
const FLOW_FILE_VERSION = 1;
const INVALID_JSON_MESSAGE = 'Flow file is not valid JSON.';
const INVALID_FLOW_FILE_VERSION_MESSAGE = 'CardMirror Flow version is unsupported.';
const INVALID_FLOW_FILE_ROUND_MESSAGE = 'CardMirror Flow round payload must be an object.';
const INVALID_FLOWLINE_JSON_MESSAGE = 'Flowline JSON payload must be an object round.';

export interface CardMirrorFlowFile {
  kind: typeof FLOW_FILE_KIND;
  version: typeof FLOW_FILE_VERSION;
  flowlineVersion: number;
  round: FlowRound;
  createdAt: string;
  updatedAt: string;
}

export function parseFlowFile(bytes: Uint8Array): CardMirrorFlowFile {
  const parsed = parseJson(bytes);
  if (!isRecord(parsed) || parsed.kind !== FLOW_FILE_KIND) {
    throw new Error('Flow file is not a CardMirror Flow wrapper.');
  }

  if (parsed.version !== FLOW_FILE_VERSION) {
    throw new Error(INVALID_FLOW_FILE_VERSION_MESSAGE);
  }

  if (!isRecord(parsed.round)) {
    throw new Error(INVALID_FLOW_FILE_ROUND_MESSAGE);
  }

  const round = normalizeRound(parsed.round);
  const now = iso();
  return {
    kind: FLOW_FILE_KIND,
    version: FLOW_FILE_VERSION,
    flowlineVersion: readNumber(parsed.flowlineVersion) ?? flowlineVersion(),
    round,
    createdAt: readString(parsed.createdAt) ?? round.createdAt ?? now,
    updatedAt: readString(parsed.updatedAt) ?? round.updatedAt ?? now,
  };
}

export function parseFlowlineJson(bytes: Uint8Array): FlowRound {
  const parsed = parseJson(bytes);
  if (!isRecord(parsed)) {
    throw new Error(INVALID_FLOWLINE_JSON_MESSAGE);
  }

  const rawRound = Object.prototype.hasOwnProperty.call(parsed, 'round') ? parsed.round : parsed;
  if (!isRecord(rawRound)) {
    throw new Error(INVALID_FLOWLINE_JSON_MESSAGE);
  }

  return normalizeRound(rawRound);
}

export function serializeFlowFile(input: {
  round: FlowRound;
  createdAt?: string;
  updatedAt?: string;
}): Uint8Array {
  const now = iso();
  const file: CardMirrorFlowFile = {
    kind: FLOW_FILE_KIND,
    version: FLOW_FILE_VERSION,
    flowlineVersion: flowlineVersion(),
    round: normalizeRound(input.round),
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };

  return new TextEncoder().encode(JSON.stringify(file, null, 2));
}

export function exportFlowlineJson(round: FlowRound): string {
  return JSON.stringify(normalizeRound(round), null, 2);
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(INVALID_JSON_MESSAGE);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function iso(): string {
  return new Date().toISOString();
}
