import {
  DOMSerializer,
  type Fragment,
  type Schema,
} from 'prosemirror-model';

interface WordStyleRule {
  selector: string;
  styleName: string;
  outlineLevel?: number;
  css: Record<string, string>;
}

export interface CardMirrorClipboardOptions {
  bodyFont?: string | (() => string | null | undefined) | null;
}

const BODY_FONT_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,li,td,th';

const BLOCK_STYLE_RULES: WordStyleRule[] = [
  {
    selector: '.pmd-pocket',
    styleName: '"Heading 1"',
    outlineLevel: 1,
    css: {
      'font-weight': 'bold',
      'font-size': '18pt',
      'text-align': 'center',
      border: '1.5pt solid #000',
    },
  },
  {
    selector: '.pmd-hat',
    styleName: '"Heading 2"',
    outlineLevel: 2,
    css: {
      'font-weight': 'bold',
      'font-size': '16pt',
      'text-align': 'center',
      'text-decoration': 'underline double',
    },
  },
  {
    selector: '.pmd-block',
    styleName: '"Block Headings"',
    outlineLevel: 3,
    css: {
      'font-weight': 'bold',
      'font-size': '14pt',
      'text-align': 'center',
      'text-decoration': 'underline',
    },
  },
  {
    selector: '.pmd-tag',
    styleName: 'Tag',
    outlineLevel: 4,
    css: {
      'font-weight': 'bold',
      'font-size': '13pt',
    },
  },
  {
    selector: '.pmd-analytic',
    styleName: 'Analytic',
    outlineLevel: 4,
    css: {
      'font-weight': 'bold',
      'font-size': '13pt',
      color: '#1F3864',
    },
  },
  {
    selector: '.pmd-undertag',
    styleName: 'Undertag',
    css: {
      color: '#1F3864',
    },
  },
  {
    selector: '.pmd-cite-para',
    styleName: 'Normal',
    css: {
      'font-size': '11pt',
    },
  },
  {
    selector: '.pmd-card-body',
    styleName: 'Normal',
    css: {
      'font-size': '11pt',
    },
  },
];

const MARK_STYLE_RULES: WordStyleRule[] = [
  {
    selector: '.pmd-cite',
    styleName: '"Style13ptBold"',
    css: {
      'font-weight': 'bold',
      'font-size': '13pt',
    },
  },
  {
    selector: '.pmd-underline',
    styleName: '"StyleUnderline"',
    css: {
      'text-decoration': 'underline',
    },
  },
  {
    selector: '.pmd-emphasis',
    styleName: 'Emphasis',
    css: {
      'text-decoration': 'underline',
      'font-style': 'normal',
    },
  },
  {
    selector: '.pmd-undertag-mark',
    styleName: 'UndertagChar',
    css: {
      color: '#1F3864',
    },
  },
  {
    selector: '.pmd-analytic-mark',
    styleName: 'AnalyticChar',
    css: {
      color: '#1F3864',
    },
  },
];

function styleMap(el: HTMLElement): Map<string, string> {
  const out = new Map<string, string>();
  const raw = el.getAttribute('style') ?? '';
  for (const decl of raw.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const key = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).trim();
    if (key && value) out.set(key, value);
  }
  return out;
}

function writeStyleMap(el: HTMLElement, map: Map<string, string>): void {
  if (map.size === 0) {
    el.removeAttribute('style');
    return;
  }
  el.setAttribute(
    'style',
    Array.from(map, ([key, value]) => `${key}:${value}`).join('; '),
  );
}

function addStyles(el: HTMLElement, css: Record<string, string>): void {
  const map = styleMap(el);
  for (const [key, value] of Object.entries(css)) {
    if (!map.has(key.toLowerCase())) map.set(key.toLowerCase(), value);
  }
  writeStyleMap(el, map);
}

function addWordStyle(el: HTMLElement, rule: WordStyleRule): void {
  addStyles(el, {
    'mso-style-name': rule.styleName,
    ...(rule.outlineLevel ? { 'mso-outline-level': String(rule.outlineLevel) } : {}),
    ...rule.css,
  });
}

function highlightCssColor(el: HTMLElement): string | null {
  const color = el.getAttribute('data-highlight') ?? '';
  if (!color || color === 'none') return null;
  const map: Record<string, string> = {
    yellow: '#ffff00',
    green: '#00ff00',
    cyan: '#00ffff',
    magenta: '#ff00ff',
    blue: '#0000ff',
    red: '#ff0000',
    lightGray: '#c0c0c0',
    darkGray: '#808080',
    black: '#000000',
  };
  return map[color] ?? null;
}

function cssFontFamilyValue(name: string): string {
  const clean = name.trim();
  if (/^[a-zA-Z0-9_-]+$/.test(clean)) return clean;
  return `"${clean.replace(/["\\]/g, '\\$&')}"`;
}

function resolveBodyFont(options: CardMirrorClipboardOptions | undefined): string | null {
  const raw = typeof options?.bodyFont === 'function' ? options.bodyFont() : options?.bodyFont;
  const font = String(raw ?? '').trim();
  return font || null;
}

function decorateElement(el: HTMLElement, bodyFont: string | null): void {
  if (bodyFont && el.matches(BODY_FONT_SELECTOR)) {
    addStyles(el, { 'font-family': cssFontFamilyValue(bodyFont) });
  }
  for (const rule of BLOCK_STYLE_RULES) {
    if (el.matches(rule.selector)) addWordStyle(el, rule);
  }
  for (const rule of MARK_STYLE_RULES) {
    if (el.matches(rule.selector)) addWordStyle(el, rule);
  }
  if (el.matches('strong,b')) addStyles(el, { 'font-weight': 'bold' });
  if (el.matches('em,i')) addStyles(el, { 'font-style': 'italic' });
  if (el.matches('u')) addStyles(el, { 'text-decoration': 'underline' });
  if (el.classList.contains('pmd-highlight')) {
    const color = highlightCssColor(el);
    if (color) addStyles(el, { 'background-color': color });
  }
  const fontFamily = el.getAttribute('data-font-family')?.trim();
  if (fontFamily) addStyles(el, { 'font-family': cssFontFamilyValue(fontFamily) });
}

export function decorateCardMirrorClipboardFragment<T extends ParentNode>(
  root: T,
  options?: CardMirrorClipboardOptions,
): T {
  const bodyFont = resolveBodyFont(options);
  if (root instanceof HTMLElement) decorateElement(root, bodyFont);
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    decorateElement(el, bodyFont);
  }
  return root;
}

export function serializeCardMirrorClipboardHtml(
  fragment: Fragment,
  schema: Schema,
  options?: CardMirrorClipboardOptions,
): string {
  const serializer = DOMSerializer.fromSchema(schema);
  const container = document.createElement('div');
  container.appendChild(
    decorateCardMirrorClipboardFragment(serializer.serializeFragment(fragment), options),
  );
  return container.innerHTML;
}

export function cardMirrorClipboardSerializer(
  schema: Schema,
  clipboardOptions?: CardMirrorClipboardOptions,
): DOMSerializer {
  const base = DOMSerializer.fromSchema(schema);
  return {
    serializeFragment(fragment: Fragment, options?: Parameters<DOMSerializer['serializeFragment']>[1], target?: Parameters<DOMSerializer['serializeFragment']>[2]) {
      const root = base.serializeFragment(fragment, options, target);
      return decorateCardMirrorClipboardFragment(root, clipboardOptions);
    },
    serializeNode: base.serializeNode.bind(base),
  } as unknown as DOMSerializer;
}
