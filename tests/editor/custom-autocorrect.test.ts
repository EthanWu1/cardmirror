/**
 * Custom autocorrections (custom-autocorrect-plugin.ts) + clash semantics.
 * Layers: pure matcher tables (boundaries, longest-match, case adaptation),
 * static conflict warnings, plugin-level convert/revert/scope, the
 * autocapitalize DECORATOR composition (fwk → Framework at a tag's sentence
 * start), and runtime priority against the custom dash — including the
 * "--"→"---" entry that motivated the clash design.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { Plugin } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  customAutocorrectPlugin,
  customAutocorrectKey,
  findCustomMatch,
  entryConflictWarnings,
} from '../../src/editor/custom-autocorrect-plugin.js';
import { customDashPlugin } from '../../src/editor/custom-dash-plugin.js';
import { settings } from '../../src/editor/settings.js';

const n = schema.nodes;
const m = schema.marks;

beforeEach(() => {
  settings.set('customAutocorrectEnabled', true);
  settings.set('customAutocorrects', [
    { from: 'fwk', to: 'framework' },
    { from: 'asap', to: 'as soon as possible' },
    { from: '--', to: '---' },
    { from: 'wk', to: 'week' },
    { from: 'CX', to: 'cross-examination' },
  ]);
  settings.set('autoCapitalizeSentences', false);
  settings.set('customDashEnabled', false);
});

describe('findCustomMatch (pure matcher)', () => {
  const entries = () => settings.get('customAutocorrects');

  it('matches a word-led key at a boundary', () => {
    const hit = findCustomMatch('the fwk', entries())!;
    expect(hit).not.toBeNull();
    expect(hit.replacement).toBe('framework');
    expect(hit.start).toBe(4);
  });

  it('word boundary: wk never fires inside fwk (longest match wins there anyway)', () => {
    // 'nwk' ends with 'wk' but 'n' is a word char → no boundary → no match.
    expect(findCustomMatch('thinwk', entries())).toBeNull();
  });

  it('punctuation-led key refuses inside a longer run of its lead char', () => {
    expect(findCustomMatch('x--', entries())!.replacement).toBe('---');
    expect(findCustomMatch('x---', entries())).toBeNull(); // run guard
  });

  it('block start counts as a boundary', () => {
    expect(findCustomMatch('fwk', entries())!.replacement).toBe('framework');
  });

  it('case adaptation for lowercase keys: First-cap and ALL-CAPS', () => {
    expect(findCustomMatch('Fwk', entries())!.replacement).toBe('Framework');
    expect(findCustomMatch('FWK', entries())!.replacement).toBe('FRAMEWORK');
    expect(findCustomMatch('fWk', entries())).toBeNull(); // mixed: refuse
  });

  it('a key defined with uppercase matches literally only', () => {
    expect(findCustomMatch('CX', entries())!.replacement).toBe('cross-examination');
    expect(findCustomMatch('cx', entries())).toBeNull();
  });

  it('an inline atom (U+FFFC) blocks keys from matching ACROSS it', () => {
    // 'fwk' cannot match across the atom — the sentinel breaks the sequence.
    expect(findCustomMatch('f￼wk', [{ from: 'fwk', to: 'framework' }])).toBeNull();
    // But an atom is a word BOUNDARY: a key typed right after one stands
    // alone and legitimately matches (like after punctuation).
    expect(findCustomMatch('f￼wk', entries())!.replacement).toBe('week');
  });
});

describe('entryConflictWarnings (static clash detection)', () => {
  it('flags hyphen keys the active dash trigger consumes', () => {
    const w = entryConflictWarnings('--', {
      smartQuotes: false,
      customDashEnabled: true,
      customDashTrigger: '--',
    });
    expect(w.length).toBe(1);
    expect(w[0]).toContain('Custom dash');
  });

  it('no flag when the dash trigger is longer than the key', () => {
    const w = entryConflictWarnings('--', {
      smartQuotes: false,
      customDashEnabled: true,
      customDashTrigger: '---',
    });
    expect(w).toEqual([]);
  });

  it('flags quote-bearing keys under smart quotes; silent when everything is off', () => {
    expect(
      entryConflictWarnings(`"x"`, {
        smartQuotes: true,
        customDashEnabled: false,
        customDashTrigger: '---',
      }).length,
    ).toBe(1);
    expect(
      entryConflictWarnings(`"x"`, {
        smartQuotes: false,
        customDashEnabled: false,
        customDashTrigger: '---',
      }),
    ).toEqual([]);
  });
});

// ─── Plugin level ──────────────────────────────────────────────────
const tag = (...k: PMNode[]) => n['tag']!.create({ id: newHeadingId() }, k);
const cardBody = (t: string) => n['card_body']!.create(null, schema.text(t));
function propsOf(plugin: Plugin) {
  return plugin.props as unknown as {
    handleTextInput: (v: unknown, from: number, to: number, text: string) => boolean;
    handleKeyDown: (v: unknown, e: unknown) => boolean;
  };
}
const BS = { key: 'Backspace', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };

/** Type chars one at a time at the end of `blockName`, driving one or more
 *  plugins in registration order (first handled wins, like PM). */
function makeHarness(d: PMNode, plugins: Plugin[]) {
  let state = EditorState.create({ doc: d, plugins });
  const view = {
    get state() {
      return state;
    },
    dispatch(tr: unknown) {
      state = state.apply(tr as never);
    },
  };
  const type = (blockName: string, char: string): boolean => {
    let end = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === blockName) end = pos + 1 + node.content.size;
    });
    if (end < 0) throw new Error(`no ${blockName}`);
    for (const plugin of plugins) {
      if (propsOf(plugin).handleTextInput(view, end, end, char)) return true;
    }
    view.dispatch(view.state.tr.insertText(char, end, end));
    return false;
  };
  const textOf = (blockName: string): string => {
    let out = '';
    view.state.doc.descendants((node) => {
      if (node.type.name === blockName) out = node.textContent;
    });
    return out;
  };
  return { view, type, textOf };
}
const docWithTagAndBody = (tagText: string, bodyText: string) =>
  n['doc']!.createChecked(null, [
    n['card']!.createChecked(null, [tag(schema.text(tagText)), cardBody(bodyText)]),
  ]);

describe('custom autocorrect plugin: mechanics and composition', () => {
  it('expands in a card body (applies everywhere) and reverts on Backspace', () => {
    const plugin = customAutocorrectPlugin();
    const h = makeHarness(docWithTagAndBody('T', 'need the fwk'), [plugin]);
    expect(h.type('card_body', ' ')).toBe(true);
    expect(h.textOf('card_body')).toBe('need the framework ');
    expect(propsOf(plugin).handleKeyDown(h.view, BS)).toBe(true);
    expect(h.textOf('card_body')).toBe('need the fwk ');
  });

  it('does nothing when disabled or when no entry matches', () => {
    settings.set('customAutocorrectEnabled', false);
    const plugin = customAutocorrectPlugin();
    const h = makeHarness(docWithTagAndBody('T', 'need the fwk'), [plugin]);
    expect(h.type('card_body', ' ')).toBe(false);
    expect(h.textOf('card_body')).toBe('need the fwk ');
  });

  it('composes with auto-capitalization: fwk → Framework at a tag sentence start', () => {
    settings.set('autoCapitalizeSentences', true);
    const plugin = customAutocorrectPlugin();
    const h = makeHarness(docWithTagAndBody('warming real. fwk', 'b'), [plugin]);
    expect(h.type('tag', ' ')).toBe(true);
    expect(h.textOf('tag')).toBe('warming real. Framework ');
  });

  it('composition respects autocap scope: stays lowercase in a card body', () => {
    settings.set('autoCapitalizeSentences', true);
    const plugin = customAutocorrectPlugin();
    const h = makeHarness(docWithTagAndBody('T', 'sentence end. fwk'), [plugin]);
    expect(h.type('card_body', ' ')).toBe(true);
    expect(h.textOf('card_body')).toBe('sentence end. framework ');
  });

  it('multi-word expansions capitalize their LEADING word only', () => {
    settings.set('autoCapitalizeSentences', true);
    const plugin = customAutocorrectPlugin();
    const h = makeHarness(docWithTagAndBody('done. asap', 'b'), [plugin]);
    expect(h.type('tag', ' ')).toBe(true);
    expect(h.textOf('tag')).toBe('done. As soon as possible ');
  });

  it('composed conversions revert to the typed literal in ONE Backspace', () => {
    settings.set('autoCapitalizeSentences', true);
    const plugin = customAutocorrectPlugin();
    const h = makeHarness(docWithTagAndBody('done. fwk', 'b'), [plugin]);
    h.type('tag', ' ');
    expect(h.textOf('tag')).toBe('done. Framework ');
    expect(propsOf(plugin).handleKeyDown(h.view, BS)).toBe(true);
    expect(h.textOf('tag')).toBe('done. fwk ');
  });

  it('a mixed-marks sequence is skipped (partial marking preserved)', () => {
    const d = n['doc']!.createChecked(null, [
      n['card']!.createChecked(null, [
        tag(schema.text('T')),
        n['card_body']!.create(null, [
          schema.text('x f', []),
          schema.text('wk', [m['highlight']!.create()]),
        ]),
      ]),
    ]);
    const plugin = customAutocorrectPlugin();
    const h = makeHarness(d, [plugin]);
    expect(h.type('card_body', ' ')).toBe(false);
    expect(h.textOf('card_body')).toBe('x fwk ');
  });
});

describe('runtime clash priority: custom dash vs the "--"→"---" entry', () => {
  it('dash trigger "--": the dash wins at the second hyphen; the entry never fires', () => {
    settings.set('customDashEnabled', true);
    settings.set('customDashTrigger', '--');
    settings.set('customDashStyle', 'em');
    // Registration order: dash BEFORE custom (char-triggered first).
    const plugins = [customDashPlugin(), customAutocorrectPlugin()];
    const h = makeHarness(docWithTagAndBody('T', 'x'), plugins);
    expect(h.type('card_body', '-')).toBe(false); // first hyphen: plain
    expect(h.type('card_body', '-')).toBe(true); // second: dash converts
    expect(h.textOf('card_body')).toBe('x—');
    // Graceful: the entry is unreachable, nothing corrupted; the settings UI
    // warns about exactly this combination (entryConflictWarnings above).
  });

  it('dash trigger "---": both features coexist — the entry expands on commit', () => {
    settings.set('customDashEnabled', true);
    settings.set('customDashTrigger', '---');
    const plugins = [customDashPlugin(), customAutocorrectPlugin()];
    const h = makeHarness(docWithTagAndBody('T', 'x'), plugins);
    expect(h.type('card_body', '-')).toBe(false);
    expect(h.type('card_body', '-')).toBe(false);
    expect(h.type('card_body', ' ')).toBe(true); // commit: -- → ---
    expect(h.textOf('card_body')).toBe('x--- ');
  });

  it('the entry output does not cascade: typing "-" after a literal "---" stays inert', () => {
    settings.set('customDashEnabled', true);
    settings.set('customDashTrigger', '---');
    const plugins = [customDashPlugin(), customAutocorrectPlugin()];
    const h = makeHarness(docWithTagAndBody('T', 'x'), plugins);
    h.type('card_body', '-');
    h.type('card_body', '-');
    h.type('card_body', ' '); // → 'x--- '
    // Delete the trailing space so the run is at the caret, then type '-':
    h.view.dispatch(h.view.state.tr.delete(h.view.state.doc.content.size - 3, h.view.state.doc.content.size - 2));
    expect(h.type('card_body', '-')).toBe(false); // dash run-guard refuses
    expect(h.textOf('card_body')).toBe('x----');
  });
});
