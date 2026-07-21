/**
 * Save As modal. Promise-based — resolves with the user's chosen
 * filename + format + export options, or `null` if they cancelled.
 *
 * Two output formats:
 *   - `cmir` — CardMirror native (lossless JSON, no Verbatim round-
 *     trip). Recommended for docs that live entirely in CardMirror.
 *   - `docx` — Microsoft Word / Verbatim. Use for sharing with
 *     teammates still on Verbatim, or for any tournament-day round
 *     where the receiving party needs Word.
 *
 * Layout (minimal — field feedback 2026-07-19): a Name field, a Type
 * dropdown (Original = everything, Send = no analytics/undertags/comments,
 * Read = read-mode export, Marked = marked cards only), a compact Format
 * toggle (.cmir / .docx), and a Cancel / Save footer. Save applies the
 * selected Type. The Format toggle drives the default filename extension
 * and which filter the OS dialog defaults to.
 */

import { settings } from './settings.js';
import { setIcon } from './icons';

export type SaveAsFormat = 'cmir' | 'docx';

export interface SaveAsResult {
  filename: string;
  /** Which on-disk format the user picked. */
  format: SaveAsFormat;
  /** Include comments in the saved doc. */
  includeComments: boolean;
  /** Include analytic content. When false, doc-level analytic_units
   *  drop entirely; in-card analytic paragraphs drop. */
  includeAnalytics: boolean;
  /** Include undertag paragraphs (doc-level and inside cards /
   *  analytic_units). */
  includeUndertags: boolean;
  /** Save only what's visible in read mode: headings, tags, in-card
   *  analytics, cite-marked text inside cite_paragraphs, highlighted
   *  text inside body paragraphs. Mutually exclusive with the three
   *  include-* options above. */
  readMode: boolean;
  /** Bake the private note layer into the file as real comments. Off by
   *  default — notes are private and normally never leave CardMirror. */
  includeNotes: boolean;
  /** Bake the private AI-thread layer into the file as real comments.
   *  Off by default, same rationale as notes. */
  includeAiThreads: boolean;
  /** Keep ONLY the cards that contain a reading marker, flat (no headings, no
   *  analytics). Mutually exclusive with the include-* / readMode options. */
  markedCardsOnly: boolean;
}

export interface OpenSaveAsOptions {
  /** Initial filename suggestion (with or without an extension — the
   *  dialog will normalize on confirm). */
  initialFilename: string;
  /** Default format to pre-select. Usually the current doc's format
   *  (so re-saving stays in the same format unless the user changes
   *  it). New docs default to `'cmir'`, the native format. */
  defaultFormat: SaveAsFormat;
}

export function openSaveAs(opts: OpenSaveAsOptions): Promise<SaveAsResult | null> {
  return new Promise((resolve) => {
    new SaveAsModal(opts, resolve);
  });
}

const FORMAT_LABELS: Record<SaveAsFormat, string> = {
  cmir: 'CardMirror native (.cmir)',
  docx: 'Microsoft Word (.docx)',
};

const FORMAT_BLURBS: Record<SaveAsFormat, string> = {
  cmir: 'Lossless. No conversion. Best for docs that stay in CardMirror.',
  docx: 'For sharing with Verbatim users or any Word-based workflow.',
};

/** Content options a Save As "type" carries, minus the filename/format
 *  the user sets separately. */
type SaveContentOptions = Omit<SaveAsResult, 'filename' | 'format'>;

type SaveTypeId = 'original' | 'send' | 'read' | 'marked';

interface SaveTypeDef {
  id: SaveTypeId;
  label: string;
  blurb: string;
  /** Filename prefix setting key, when this type prepends one. */
  prefixKey?: 'sendDocPrefix' | 'readDocPrefix' | 'markedDocPrefix';
  opts: SaveContentOptions;
}

/** The four save "types" the dropdown offers. Order = dropdown order;
 *  `original` (everything) is the default. */
const SAVE_TYPES: SaveTypeDef[] = [
  {
    id: 'original',
    label: 'Original',
    blurb: 'Everything in the document.',
    opts: {
      includeComments: true,
      includeAnalytics: true,
      includeUndertags: true,
      readMode: false,
      includeNotes: false,
      includeAiThreads: false,
      markedCardsOnly: false,
    },
  },
  {
    id: 'send',
    label: 'Send',
    blurb: 'Excludes analytics, undertags, and comments.',
    prefixKey: 'sendDocPrefix',
    opts: {
      includeComments: false,
      includeAnalytics: false,
      includeUndertags: false,
      readMode: false,
      includeNotes: false,
      includeAiThreads: false,
      markedCardsOnly: false,
    },
  },
  {
    id: 'read',
    label: 'Read',
    blurb: 'The read-mode view of the document.',
    prefixKey: 'readDocPrefix',
    opts: {
      includeComments: false,
      includeAnalytics: false,
      includeUndertags: false,
      readMode: true,
      includeNotes: false,
      includeAiThreads: false,
      markedCardsOnly: false,
    },
  },
  {
    id: 'marked',
    label: 'Marked',
    blurb: 'Only the cards you marked.',
    prefixKey: 'markedDocPrefix',
    opts: {
      includeComments: false,
      includeAnalytics: false,
      includeUndertags: true,
      readMode: false,
      includeNotes: false,
      includeAiThreads: false,
      markedCardsOnly: true,
    },
  },
];

class SaveAsModal {
  private readonly overlay: HTMLDivElement;
  private readonly dialog: HTMLDivElement;
  private filenameInput!: HTMLInputElement;
  private settled = false;
  private currentFormat: SaveAsFormat;
  private currentType: SaveTypeDef = SAVE_TYPES[0]!;

  constructor(
    private readonly opts: OpenSaveAsOptions,
    private readonly settle: (r: SaveAsResult | null) => void,
  ) {
    this.currentFormat = opts.defaultFormat;
    this.overlay = document.createElement('div');
    this.overlay.className = 'pmd-save-as-overlay';

    this.dialog = document.createElement('div');
    this.dialog.className = 'pmd-save-as-dialog';
    this.overlay.appendChild(this.dialog);

    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.cancel();
    });

    document.addEventListener('keydown', this.handleKey);

    this.render();
    document.body.appendChild(this.overlay);

    requestAnimationFrame(() => {
      this.filenameInput.focus();
      // Select just the basename, not the extension, so the user can
      // type a new name without clobbering the extension.
      const dot = this.filenameInput.value.lastIndexOf('.');
      if (dot > 0) {
        this.filenameInput.setSelectionRange(0, dot);
      } else {
        this.filenameInput.select();
      }
    });
  }

  private readonly handleKey = (e: KeyboardEvent): void => {
    if (this.settled) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.cancel();
    }
  };

  private render(): void {
    const header = document.createElement('header');
    header.className = 'pmd-save-as-header';
    const title = document.createElement('h2');
    title.textContent = 'Save As';
    header.appendChild(title);
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'pmd-save-as-close';
    setIcon(closeBtn, 'close');
    closeBtn.title = 'Cancel';
    closeBtn.addEventListener('click', () => this.cancel());
    header.appendChild(closeBtn);
    this.dialog.appendChild(header);

    const form = document.createElement('form');
    form.className = 'pmd-save-as-body';
    // Enter / the footer Save button save using the selected Type. (Field
    // feedback 2026-07-19: Type is a dropdown, not a row of buttons; Format
    // is a compact toggle, not a dropdown.)
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.confirmSelectedType();
    });

    form.appendChild(this.buildFileNameSection());
    form.appendChild(this.buildTypeSection());
    form.appendChild(this.buildFormatSection());

    // Footer: Cancel + Save (saves with the selected Type + Format).
    const footer = document.createElement('footer');
    footer.className = 'pmd-save-as-footer';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'pmd-save-as-btn pmd-save-as-btn-secondary';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this.cancel());
    footer.appendChild(cancel);
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'pmd-save-as-btn pmd-save-as-btn-primary';
    save.textContent = 'Save';
    footer.appendChild(save);
    form.appendChild(footer);

    this.dialog.appendChild(form);
  }

  /** TYPE section: a heading + a dropdown of the four save types
   *  (Original / Send / Read / Marked) with a one-line blurb below. */
  private buildTypeSection(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'pmd-save-as-field';
    const heading = document.createElement('div');
    heading.className = 'pmd-save-as-options-heading';
    heading.textContent = 'Type';
    wrap.appendChild(heading);

    const select = document.createElement('select');
    select.className = 'pmd-save-as-input pmd-save-as-type-select';
    select.setAttribute('aria-label', 'Save type');
    for (const type of SAVE_TYPES) {
      const option = document.createElement('option');
      option.value = type.id;
      option.textContent = type.label;
      option.selected = type.id === this.currentType.id;
      select.appendChild(option);
    }
    const blurb = document.createElement('div');
    blurb.className = 'pmd-save-as-format-row-blurb';
    blurb.textContent = this.currentType.blurb;
    select.addEventListener('change', () => {
      this.currentType = SAVE_TYPES.find((t) => t.id === select.value) ?? SAVE_TYPES[0]!;
      blurb.textContent = this.currentType.blurb;
    });
    wrap.appendChild(select);
    wrap.appendChild(blurb);
    return wrap;
  }

  /** Save with the selected Type's content options + the live filename
   *  and format, applying the type's filename prefix when enabled. */
  private confirmSelectedType(): void {
    const prefix = this.currentType.prefixKey ? settings.get(this.currentType.prefixKey) : '';
    this.confirmWith(this.currentType.opts, prefix);
  }

  /** FILE NAME section: a heading + the file-name input. */
  private buildFileNameSection(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'pmd-save-as-field';
    const heading = document.createElement('div');
    heading.className = 'pmd-save-as-options-heading';
    heading.textContent = 'Name';
    wrap.appendChild(heading);
    this.filenameInput = document.createElement('input');
    this.filenameInput.type = 'text';
    this.filenameInput.className = 'pmd-save-as-input';
    this.filenameInput.value = withExtension(this.opts.initialFilename, this.currentFormat);
    this.filenameInput.spellcheck = false;
    this.filenameInput.autocomplete = 'off';
    wrap.appendChild(this.filenameInput);
    return wrap;
  }

  /** FORMAT section: a heading + a compact two-segment toggle (.cmir /
   *  .docx) with a one-line blurb (field feedback 2026-07-19: format is a
   *  toggle, not a dropdown). */
  private buildFormatSection(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'pmd-save-as-format';
    const heading = document.createElement('div');
    heading.className = 'pmd-save-as-options-heading';
    heading.textContent = 'Format';
    wrap.appendChild(heading);

    const toggle = document.createElement('div');
    toggle.className = 'pmd-save-as-format-toggle';
    toggle.setAttribute('role', 'radiogroup');
    toggle.setAttribute('aria-label', 'File format');
    const blurb = document.createElement('div');
    blurb.className = 'pmd-save-as-format-row-blurb';
    blurb.textContent = FORMAT_BLURBS[this.currentFormat];
    const segments: Record<SaveAsFormat, HTMLButtonElement> = { cmir: null!, docx: null! };
    const syncSegments = (): void => {
      for (const id of ['cmir', 'docx'] as const) {
        const on = id === this.currentFormat;
        segments[id].classList.toggle('is-active', on);
        segments[id].setAttribute('aria-checked', String(on));
      }
      blurb.textContent = FORMAT_BLURBS[this.currentFormat];
    };
    for (const id of ['cmir', 'docx'] as const) {
      const seg = document.createElement('button');
      seg.type = 'button';
      seg.className = 'pmd-save-as-format-seg';
      seg.setAttribute('role', 'radio');
      seg.textContent = id === 'cmir' ? '.cmir' : '.docx';
      seg.title = FORMAT_LABELS[id];
      seg.addEventListener('click', () => {
        this.setFormat(id);
        syncSegments();
      });
      segments[id] = seg;
      toggle.appendChild(seg);
    }
    syncSegments();
    wrap.appendChild(toggle);
    wrap.appendChild(blurb);
    return wrap;
  }

  /** Update the format and swap the filename's extension to match. */
  private setFormat(format: SaveAsFormat): void {
    this.currentFormat = format;
    this.filenameInput.value = withExtension(this.filenameInput.value, format);
  }

  /** Save with the given content options + the live filename /
   *  format. Shared by every preset and the Save Custom submit.
   *  `prefix` (from the Send/Read/Marked Doc presets) is prepended
   *  to the file name when the `prefixPresetSaveFilenames` setting
   *  is on. No-op on an empty filename. */
  private confirmWith(
    opts: {
      includeComments: boolean;
      includeAnalytics: boolean;
      includeUndertags: boolean;
      readMode: boolean;
      includeNotes: boolean;
      includeAiThreads: boolean;
      markedCardsOnly: boolean;
    },
    prefix = '',
  ): void {
    const trimmed = this.filenameInput.value.trim();
    if (!trimmed) return;
    const named = withExtension(trimmed, this.currentFormat);
    const usePrefix = prefix && settings.get('prefixPresetSaveFilenames');
    this.finish({
      filename: usePrefix ? prefix + named : named,
      format: this.currentFormat,
      ...opts,
    });
  }

  private cancel(): void {
    this.finish(null);
  }

  private finish(result: SaveAsResult | null): void {
    if (this.settled) return;
    this.settled = true;
    document.removeEventListener('keydown', this.handleKey);
    this.overlay.remove();
    this.settle(result);
  }
}

/** Normalize a filename to end with the right extension for the
 *  chosen format. Strips other known extensions first so swapping
 *  the format radio replaces `.docx` with `.cmir` and vice versa
 *  without piling them up. */
function withExtension(filename: string, format: SaveAsFormat): string {
  let base = filename.trim();
  for (const ext of ['.cmir', '.docx']) {
    if (base.toLowerCase().endsWith(ext)) {
      base = base.slice(0, -ext.length);
      break;
    }
  }
  return `${base}.${format}`;
}
