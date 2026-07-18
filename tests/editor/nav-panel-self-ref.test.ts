// @vitest-environment jsdom
/**
 * An intra-doc live window (`self_ref`) projects an atom with no doc children,
 * so the nav pane resolves its source and shows the projected content as
 * read-only "windowed" rows (with the transclusion rail), alongside the real
 * source section.
 */
import { describe, it, expect } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { type Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { NavigationPanel } from '../../src/editor/nav-panel.js';
import { createSelfRefNode, isSelfRef } from '../../src/editor/self-transclusion.js';
import { settings } from '../../src/editor/settings.js';

const block = (text: string, id: string): PMNode => schema.nodes['block']!.create({ id }, schema.text(text));
function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
/** A card with a cite (author/date) via a cite_mark, so the nav shows a cite
 *  preview on hover. */
function citedCard(tag: string, citeText: string): PMNode {
  const citeMark = schema.marks['cite_mark']!.create();
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['cite_paragraph']!.create(null, schema.text(citeText, [citeMark])),
    schema.nodes['card_body']!.create(null, schema.text('body')),
  ]);
}

function setup(children: PMNode[]) {
  const doc = schema.nodes['doc']!.create(null, children);
  const el = document.createElement('div');
  document.body.appendChild(el);
  const view = new EditorView(el, { state: EditorState.create({ doc }) });
  const nav = new NavigationPanel(document.createElement('div'));
  nav.attach(view);
  return { view, nav };
}
function rows(nav: NavigationPanel): HTMLElement[] {
  const listEl = (nav as unknown as Record<string, unknown>)['listEl'] as HTMLElement;
  return [...listEl.querySelectorAll('.pmd-nav-item')] as HTMLElement[];
}
const labelOf = (li: HTMLElement): string =>
  (li.querySelector('.pmd-nav-label') as HTMLElement | null)?.textContent ?? '';

describe('NavigationPanel — self_ref windows in the outline', () => {
  it('projects the window content as read-only windowed rows', () => {
    const { view, nav } = setup([
      block('Source', 'src'),
      card('Alpha', 'a'),
      card('Bravo', 'b'),
      block('Elsewhere', 'oth'),
      createSelfRefNode(schema, 'src', '↳ Source'),
    ]);
    nav.update(view.state.doc);
    const all = rows(nav);
    const windowed = all.filter((li) => li.classList.contains('pmd-nav-item-window'));
    // The window projects Alpha + Bravo (Source's two cards).
    expect(windowed.map(labelOf)).toEqual(['Alpha', 'Bravo']);
    // Windowed rows carry the transclusion rail and no data-id (read-only).
    expect(windowed.every((li) => li.classList.contains('pmd-nav-item-zone'))).toBe(true);
    expect(windowed.every((li) => !li.dataset['id'])).toBe(true);
    view.destroy();
  });

  it('updates the windowed rows when the source changes', () => {
    const { view, nav } = setup([
      block('Source', 'src'),
      card('Alpha', 'a'),
      block('Elsewhere', 'oth'),
      createSelfRefNode(schema, 'src', '↳ Source'),
    ]);
    nav.update(view.state.doc);
    expect(rows(nav).filter((li) => li.classList.contains('pmd-nav-item-window')).map(labelOf)).toEqual([
      'Alpha',
    ]);
    // Add a card to the source section (before "Elsewhere").
    let othPos = -1;
    view.state.doc.forEach((n, off) => {
      if (n.attrs?.['id'] === 'oth') othPos = off;
    });
    view.dispatch(view.state.tr.insert(othPos, card('Bravo', 'b')));
    nav.update(view.state.doc);
    expect(rows(nav).filter((li) => li.classList.contains('pmd-nav-item-window')).map(labelOf)).toEqual([
      'Alpha',
      'Bravo',
    ]);
    view.destroy();
  });

  it('windowed rows carry cite text (for the hover cite preview)', () => {
    const { view, nav } = setup([
      block('Source', 'src'),
      citedCard('Alpha', "Author '24"),
      block('Elsewhere', 'oth'),
      createSelfRefNode(schema, 'src', '↳ Source'),
    ]);
    // Cite previews only render with the setting on.
    settings.set('showCitePreview', true);
    nav.update(view.state.doc);
    const windowed = rows(nav).find((li) => li.classList.contains('pmd-nav-item-window'));
    expect(windowed).toBeTruthy();
    const preview = windowed!.querySelector('.pmd-nav-cite-preview') as HTMLElement | null;
    expect(preview?.textContent).toContain("Author '24");
    view.destroy();
  });

  it('carries the caret highlight onto the window rows when the live view is node-selected', () => {
    const { view, nav } = setup([
      block('Source', 'src'),
      card('Alpha', 'a'),
      card('Bravo', 'b'),
      block('Elsewhere', 'oth'),
      createSelfRefNode(schema, 'src', '↳ Source'),
    ]);
    nav.update(view.state.doc);
    let selfPos = -1;
    view.state.doc.forEach((n, off) => {
      if (isSelfRef(n)) selfPos = off;
    });
    expect(selfPos).toBeGreaterThan(-1);

    // A node-selected live view lights ITS projected rows (not the heading above).
    nav.setCaretHeading(selfPos, selfPos);
    const selected = (li: HTMLElement) => li.classList.contains('pmd-nav-item-selected');
    const windowed = rows(nav).filter((li) => li.classList.contains('pmd-nav-item-window'));
    expect(windowed.length).toBeGreaterThan(0);
    expect(windowed.every(selected)).toBe(true);
    // No real heading row is lit while the window holds the caret.
    const realSelected = rows(nav).filter((li) => !li.classList.contains('pmd-nav-item-window') && selected(li));
    expect(realSelected).toHaveLength(0);

    // Moving the caret back to a real heading clears the window highlight.
    nav.setCaretHeading(0, null);
    expect(rows(nav).filter((li) => li.classList.contains('pmd-nav-item-window')).some(selected)).toBe(false);
    view.destroy();
  });

  it('shows nothing extra when the window source is missing', () => {
    const { view, nav } = setup([
      block('Elsewhere', 'oth'),
      createSelfRefNode(schema, 'gone', '↳ Gone'),
    ]);
    nav.update(view.state.doc);
    expect(rows(nav).filter((li) => li.classList.contains('pmd-nav-item-window'))).toHaveLength(0);
    view.destroy();
  });
});
