/**
 * Word Count Selection modal.
 *
 * Shows the read-aloud word count for the current selection (or the
 * full doc if nothing is selected) plus read-time estimates for every
 * configured reader.
 */

import type { EditorView } from 'prosemirror-view';
import { settings } from './settings.js';
import { countReadAloudWords, formatReadTime, formatNumber } from './word-count.js';
import { setIcon } from './icons';

class WordCountModal {
  private overlay: HTMLDivElement;
  private dialog: HTMLDivElement;

  constructor() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'pmd-settings-overlay'; // reuse modal overlay style
    this.overlay.style.display = 'none';

    this.dialog = document.createElement('div');
    this.dialog.className = 'pmd-settings-dialog';
    this.overlay.appendChild(this.dialog);

    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (this.overlay.style.display !== 'none' && e.key === 'Escape') this.close();
    });

    document.body.appendChild(this.overlay);
  }

  open(view: EditorView): void {
    this.render(view);
    this.overlay.style.display = '';
  }

  close(): void {
    this.overlay.style.display = 'none';
  }

  private render(view: EditorView): void {
    this.dialog.innerHTML = '';

    const header = document.createElement('header');
    header.className = 'pmd-settings-header';
    const title = document.createElement('h2');
    title.textContent = 'Word Count Selection';
    header.appendChild(title);
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'pmd-settings-close';
    setIcon(closeBtn, 'close');
    closeBtn.addEventListener('click', () => this.close());
    header.appendChild(closeBtn);
    this.dialog.appendChild(header);

    const body = document.createElement('div');
    body.className = 'pmd-settings-list';
    this.dialog.appendChild(body);

    const sel = view.state.selection;
    const hasSelection = !sel.empty;
    const words = hasSelection
      ? countReadAloudWords(view.state.doc, sel.from, sel.to)
      : countReadAloudWords(view.state.doc);

    const scope = document.createElement('p');
    scope.className = 'pmd-wc-scope';
    scope.textContent = hasSelection
      ? `Selection: ${formatNumber(words)} read-aloud words`
      : `Full document: ${formatNumber(words)} read-aloud words`;
    body.appendChild(scope);

    const readers = settings.get('readers');
    if (readers.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'pmd-settings-empty';
      empty.textContent = 'No readers configured. Add some in Settings.';
      body.appendChild(empty);
      return;
    }

    const table = document.createElement('table');
    table.className = 'pmd-wc-table';
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    for (const h of ['Reader', 'WPM', 'Time']) {
      const th = document.createElement('th');
      th.textContent = h;
      trh.appendChild(th);
    }
    thead.appendChild(trh);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const r of readers) {
      const tr = document.createElement('tr');
      const tdName = document.createElement('td');
      tdName.textContent = r.name;
      tr.appendChild(tdName);
      const tdWpm = document.createElement('td');
      tdWpm.textContent = String(r.wpm);
      tdWpm.className = 'pmd-wc-numeric';
      tr.appendChild(tdWpm);
      const tdTime = document.createElement('td');
      tdTime.textContent = formatReadTime(words, r.wpm);
      tdTime.className = 'pmd-wc-numeric';
      tr.appendChild(tdTime);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    body.appendChild(table);
  }
}

let singleton: WordCountModal | null = null;

export function openWordCount(view: EditorView): void {
  if (!singleton) singleton = new WordCountModal();
  singleton.open(view);
}
