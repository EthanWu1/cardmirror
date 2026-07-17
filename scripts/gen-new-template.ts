#!/usr/bin/env tsx
/**
 * Generate the "New > CardMirror Document" template — a minimal blank
 * `.cmir` that Windows Explorer's ShellNew mechanism copies when the
 * user creates a new CardMirror file from the right-click "New" submenu
 * (see `apps/desktop/build/installer.nsh`). It's shipped into the
 * install via electron-builder `extraResources`, landing at
 * `$INSTDIR\resources\new-template.cmir`, which the registry key points
 * at.
 *
 * The output is committed (like `scripts/gen-icons.mjs`'s CSS). Re-run
 * it after a native `formatVersion` bump so the template stays a valid,
 * current-format empty doc:
 *
 *   npm run gen:new-template
 *
 * NOTE: the Windows integration this feeds is UNTESTED on a real
 * Windows machine — verify there before relying on it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schema } from '../src/schema/index.js';
import { serializeNative } from '../src/native/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../apps/desktop/resources/new-template.cmir');

// A blank document: a single empty paragraph (the doc's content is
// `(...)*`, so this is the minimal doc you can actually type into).
// CardMirror opens it as an empty, editable doc; the first real save
// re-stamps its metadata.
const doc = schema.nodes['doc']!.createChecked(null, [
  schema.nodes['paragraph']!.create(null),
]);

const bytes = serializeNative(doc, { appVersion: 'CardMirror (new-file template)' });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, bytes);
console.log(`Wrote ${out} (${bytes.byteLength} bytes)`);
