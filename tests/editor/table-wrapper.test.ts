// @vitest-environment jsdom

/**
 * Table `.tableWrapper` survival across plugin reconfigure.
 *
 * prosemirror-tables' columnResizing() registers its table nodeView
 * (which wraps tables in `.tableWrapper` — all table CSS hangs off it)
 * by mutating its own spec inside `state.init`. Handing a FRESH
 * instance to `reconfigure` never runs `init` (same plugin key → state
 * preserved), so the view rebuilds node views from an empty map and
 * tables re-render unwrapped: borders + column resizing silently die.
 * The app reconfigures on every keybinding / macro change, so this was
 * user-visible as "table cell borders turn invisible".
 *
 * Guarded both ways: the first test documents the upstream trap (if it
 * starts failing, prosemirror-tables fixed it and table-plugins.ts can
 * be simplified); the second proves our shared singletons keep the
 * wrapper alive across reconfigure.
 */

import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { columnResizing, tableEditing } from 'prosemirror-tables';
import { schema } from '../../src/schema/index.js';
import {
  columnResizingPlugin,
  tableEditingPlugin,
} from '../../src/editor/table-plugins.js';

function tableDoc() {
  const { nodes } = schema;
  const cell = () =>
    nodes['table_cell']!.createChecked(null, nodes['paragraph']!.create(null, schema.text('x')));
  const row = nodes['table_row']!.createChecked(null, [cell(), cell()]);
  const table = nodes['table']!.createChecked(null, [row]);
  return nodes['doc']!.createChecked(null, [table]);
}

function mount(plugins: import('prosemirror-state').Plugin[]) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const view = new EditorView(container, {
    state: EditorState.create({ doc: tableDoc(), plugins }),
  });
  return { container, view };
}

describe('tableWrapper across reconfigure', () => {
  it('documents the upstream trap: fresh columnResizing() loses the wrapper', () => {
    const { container, view } = mount([columnResizing(), tableEditing()]);
    expect(container.querySelector('.tableWrapper')).not.toBeNull();
    // Reconfigure with FRESH instances — same plugin keys, so init is
    // skipped and the new instances carry no table nodeView.
    view.updateState(
      view.state.reconfigure({ plugins: [columnResizing(), tableEditing()] }),
    );
    expect(container.querySelector('.tableWrapper')).toBeNull();
    // If this assertion ever fails, prosemirror-tables fixed the init
    // side effect and the singleton arrangement can be revisited.
    view.destroy();
  });

  it('shared singletons keep the wrapper (and borders CSS hook) alive', () => {
    const { container, view } = mount([columnResizingPlugin, tableEditingPlugin]);
    expect(container.querySelector('.tableWrapper')).not.toBeNull();
    view.updateState(
      view.state.reconfigure({ plugins: [columnResizingPlugin, tableEditingPlugin] }),
    );
    expect(container.querySelector('.tableWrapper')).not.toBeNull();
    // A second round-trip (the keybindings editor can be visited many
    // times per session) stays stable too.
    view.updateState(
      view.state.reconfigure({ plugins: [columnResizingPlugin, tableEditingPlugin] }),
    );
    expect(container.querySelector('.tableWrapper')).not.toBeNull();
    view.destroy();
  });
});
