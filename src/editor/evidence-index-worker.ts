import type { Node as PMNode } from 'prosemirror-model';
import { fromDocx } from '../import/index.js';
import { parseNative } from '../native/index.js';
import {
  extractEvidenceRows,
  evidenceSearchText,
  type EvidenceSearchRow,
  type FileEntry,
  type OpenableFileFormat,
} from './file-search.js';

interface EvidenceIndexRequest {
  type: 'index-evidence-file';
  jobId: number;
  entry: FileEntry;
  bytes: Uint8Array;
  format: OpenableFileFormat;
}

interface EvidenceIndexSuccess {
  type: 'evidence-file-indexed';
  jobId: number;
  rows: EvidenceSearchRow[];
}

interface EvidenceIndexFailure {
  type: 'evidence-file-error';
  jobId: number;
  message: string;
}

type EvidenceIndexResponse = EvidenceIndexSuccess | EvidenceIndexFailure;

async function parseEvidenceFile(bytes: Uint8Array, format: OpenableFileFormat): Promise<PMNode> {
  if (format === 'docx') return fromDocx(bytes);
  if (format === 'cmflow') throw new Error('Flow files do not have searchable document objects.');
  return parseNative(bytes).doc;
}

self.addEventListener('message', (event: MessageEvent<EvidenceIndexRequest>) => {
  const request = event.data;
  if (!request || request.type !== 'index-evidence-file') return;
  void (async () => {
    try {
      const doc = await parseEvidenceFile(request.bytes, request.format);
      const rows = extractEvidenceRows(doc, request.entry);
      for (const row of rows) row.searchText ??= evidenceSearchText(row);
      const response: EvidenceIndexResponse = {
        type: 'evidence-file-indexed',
        jobId: request.jobId,
        rows,
      };
      self.postMessage(response);
    } catch (err) {
      const response: EvidenceIndexResponse = {
        type: 'evidence-file-error',
        jobId: request.jobId,
        message: err instanceof Error ? err.message : 'Could not index evidence file.',
      };
      self.postMessage(response);
    }
  })();
});
