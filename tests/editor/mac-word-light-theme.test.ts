import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const styleCss = await fs.readFile(path.join(process.cwd(), 'src', 'editor', 'style.css'), 'utf8');
const multiPaneSource = await fs.readFile(
  path.join(process.cwd(), 'src', 'editor', 'multi-pane-shell.ts'),
  'utf8',
);
const indexHtml = await fs.readFile(path.join(process.cwd(), 'index.html'), 'utf8');
const editorIndexSource = await fs.readFile(path.join(process.cwd(), 'src', 'editor', 'index.ts'), 'utf8');
const quickCardSearchSource = await fs.readFile(
  path.join(process.cwd(), 'src', 'editor', 'quick-card-search-ui.ts'),
  'utf8',
);
const flowWorkspaceCss = await fs.readFile(
  path.join(process.cwd(), 'src', 'editor', 'flow', 'flow-workspace.css'),
  'utf8',
);

function rootTokens(): Map<string, string> {
  const rootMatch = /:root\s*\{([\s\S]*?)\n\}/.exec(styleCss);
  if (!rootMatch?.[1]) throw new Error('root token block not found');
  return parseTokens(rootMatch[1]);
}

function darkThemeTokens(): Map<string, string> {
  const darkMatch = /:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/.exec(styleCss);
  if (!darkMatch?.[1]) throw new Error('dark theme token block not found');
  return parseTokens(darkMatch[1]);
}

function parseTokens(block: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const match of block.matchAll(/(--pmd-c-[\w-]+)\s*:\s*([^;]+);/g)) {
    const name = match[1];
    const value = match[2];
    if (name && value) tokens.set(name, value.trim());
  }
  return tokens;
}

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm').exec(styleCss);
  if (!match?.[1]) throw new Error(`missing CSS rule: ${selector}`);
  return match[1];
}

function declarationsForSelector(selector: string): Map<string, string> {
  const cssWithoutComments = styleCss.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of cssWithoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectorList = match[1]?.split(',').map((part) => part.trim());
    const body = match[2];
    if (!selectorList?.includes(selector) || !body) continue;
    const declarations = new Map<string, string>();
    for (const declaration of body.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon < 0) continue;
      const property = declaration.slice(0, colon).trim();
      const value = declaration.slice(colon + 1).trim();
      if (property && value) declarations.set(property, value);
    }
    return declarations;
  }
  throw new Error(`missing CSS rule: ${selector}`);
}

describe('Mac Word-like chrome theme tokens', () => {
  it('uses a light Word-style ribbon with medium dark navigation around white paper', () => {
    const tokens = rootTokens();

    expect(tokens.get('--pmd-c-bg')).toBe('#fff');
    expect(tokens.get('--pmd-c-bg-soft')).toBe('#f1f2f4');
    expect(tokens.get('--pmd-c-surface')).toBe('#dfe1e4');
    expect(tokens.get('--pmd-c-surface-alt')).toBe('#d5d7da');
    expect(tokens.get('--pmd-c-ribbon')).toBe('#adadb0');
    expect(tokens.get('--pmd-c-ribbon-border')).toBe('#76787c');
    expect(tokens.get('--pmd-c-ribbon-text')).toBe('#1f1f1f');
    expect(tokens.get('--pmd-c-ribbon-text-secondary')).toBe('#454545');
    expect(tokens.get('--pmd-c-ribbon-hover')).toBe('rgba(0, 0, 0, 0.12)');
    expect(tokens.get('--pmd-c-status')).toBe('#adadb0');
    expect(tokens.get('--pmd-c-status-border')).toBe('#76787c');
    expect(tokens.get('--pmd-c-nav-bg')).toBe('#464646');
    expect(tokens.get('--pmd-c-nav-header-bg')).toBe('#4d4d4d');
    expect(tokens.get('--pmd-c-nav-selected')).toBe('#0a64ad');
    expect(tokens.get('--pmd-c-chrome-text')).toBe('#f2f2f2');
    expect(tokens.get('--pmd-c-chrome-text-secondary')).toBe('#c9c9c9');
    expect(tokens.get('--pmd-c-hover')).toBe('#d7d9dc');
    expect(tokens.get('--pmd-c-accent')).toBe('#1b5ea8');
    expect(tokens.get('--pmd-c-doc-paper')).toBe('#fff');
  });

  it('keeps the editor paper white instead of tinting it with chrome', () => {
    expect(styleCss).toContain('background: var(--pmd-c-doc-paper);');
    expect(styleCss).toContain('#ribbon,');
    expect(styleCss).toContain('.pmd-nav-panel');
    expect(styleCss).toContain('color: var(--pmd-c-chrome-text);');
  });

  it('uses genuinely dark Word-style chrome in dark mode (field feedback 2026-07-19)', () => {
    const tokens = darkThemeTokens();

    expect(tokens.get('--pmd-c-ribbon')).toBe('#2b2d30');
    expect(tokens.get('--pmd-c-ribbon-border')).toBe('#1c1e20');
    expect(tokens.get('--pmd-c-ribbon-text')).toBe('#e8e8e8');
    expect(tokens.get('--pmd-c-ribbon-text-secondary')).toBe('#b0b0b0');
    expect(tokens.get('--pmd-c-ribbon-hover')).toBe('rgba(255, 255, 255, 0.1)');
    expect(tokens.get('--pmd-c-status')).toBe('#2b2d30');
    expect(tokens.get('--pmd-c-status-border')).toBe('#1c1e20');
    expect(tokens.get('--pmd-c-nav-bg')).toBe('#2f2f2f');
    expect(tokens.get('--pmd-c-nav-header-bg')).toBe('#383838');
    expect(tokens.get('--pmd-c-scrollbar-chrome-hover')).toBe('rgba(255, 255, 255, 0.38)');
    expect(tokens.get('--pmd-c-scrollbar-doc-hover')).toBe('rgba(0, 0, 0, 0.28)');
  });

  it('gives dark-dialog buttons their own visible surface tokens', () => {
    // Cancel / Don't Save / route buttons live on DARK dialog bodies. They
    // must not borrow the ribbon tokens (a near-black ribbon made them
    // invisible, field bug 2026-07-19) and must not hardcode dark text.
    for (const selector of [
      '.pmd-route-btn',
      '.pmd-route-cancel',
      '.pmd-text-prompt-secondary',
      '.pmd-confirm-btn',
    ]) {
      expect(ruleBody(selector)).toContain('color: var(--pmd-c-dialog-button-text);');
      expect(ruleBody(selector)).not.toContain('color: #242424;');
      expect(ruleBody(selector)).not.toContain('var(--pmd-c-ribbon)');
    }
  });

  it('uses the same light ribbon chrome for the bottom status bar', () => {
    const tokens = rootTokens();

    expect(tokens.get('--pmd-c-status')).toBe('#adadb0');
    expect(tokens.get('--pmd-c-status-border')).toBe('#76787c');
    expect(ruleBody('#status-bar')).toContain('background: var(--pmd-c-ribbon);');
    expect(ruleBody('#status-bar')).toContain('border-top: 1px solid var(--pmd-c-ribbon-border);');
    expect(ruleBody('#status-bar')).toContain('color: var(--pmd-c-ribbon-text-secondary);');
    expect(ruleBody('.status-bar-btn')).toContain('color: var(--pmd-c-ribbon-text);');
    expect(ruleBody('.status-bar-btn:hover')).toContain('background: var(--pmd-c-ribbon-hover);');
    expect(ruleBody('.zoom-controls button')).toContain('color: var(--pmd-c-ribbon-text);');
    expect(ruleBody('.zoom-controls button:hover')).toContain('background: var(--pmd-c-ribbon-hover);');
    expect(ruleBody('#zoom-pct')).toContain('color: var(--pmd-c-ribbon-text-secondary);');
  });

  it('mounts Send and Receive into the status bar instead of the floating dropzone tray', () => {
    expect(indexHtml).toContain('id="pairing-status-controls"');
    expect(ruleBody('.pmd-status-pairing-controls')).toContain('display: none;');
    expect(ruleBody('.pmd-status-pairing-controls')).toContain('overflow: visible;');
    expect(ruleBody('.pmd-status-pairing-controls:has(.pmd-pill:not([hidden]))')).toContain('display: flex;');
    expect(ruleBody('.pmd-status-pairing-controls .pmd-pill-bar')).toContain('box-shadow: none;');
    expect(ruleBody('.pmd-status-pairing-controls .pmd-pill-bar')).toContain('background: transparent;');
    expect(ruleBody('.pmd-status-pairing-controls .pmd-pill-bar:hover')).toContain(
      'background: var(--pmd-c-ribbon-hover);',
    );
    expect(editorIndexSource).toContain("const pairingStatusControls = document.getElementById('pairing-status-controls')");
    expect(editorIndexSource).toContain('mountPairingPills(pairingStatusControls ?? pillTray, () => getActiveView());');
    expect(editorIndexSource).toContain("settings.get('showDropzonePill'),");
    expect(editorIndexSource).not.toContain("settings.get('showDropzonePill') || settings.get('pairingEnabled')");
  });

  it('keeps marked navigation headings readable on the dark pane', () => {
    expect(styleCss).toContain('background: var(--pmd-c-nav-selected);');
    expect(styleCss).toContain('color: var(--pmd-c-text-on-accent);');
    expect(styleCss).toContain('background-color: var(--pmd-c-nav-find-marker);');
  });

  it('uses a white navigation close icon on the dark pane header', () => {
    expect(ruleBody('.pmd-nav-close')).toContain('color: #fff;');
  });

  it('uses a left-nav Word-like settings dialog instead of a cramped tab strip', () => {
    const dialog = declarationsForSelector('.pmd-settings-dialog');
    const header = declarationsForSelector('.pmd-settings-header');
    const tabsBar = declarationsForSelector('.pmd-settings-tabs-bar');
    const tabs = declarationsForSelector('.pmd-settings-tabs');
    const activeTab = declarationsForSelector('.pmd-settings-tab-active');
    const list = declarationsForSelector('.pmd-settings-list');
    const row = declarationsForSelector('.pmd-settings-row');

    expect(dialog.get('display')).toBe('grid');
    expect(dialog.get('grid-template-columns')).toBe('12.25rem minmax(0, 1fr)');
    expect(header.get('background')).toBe('var(--pmd-c-ribbon)');
    expect(tabsBar.get('grid-column')).toBe('1');
    expect(tabsBar.get('border-right')).toBe('1px solid var(--pmd-c-ribbon-border)');
    expect(tabsBar.get('background')).toBe('var(--pmd-c-surface-soft)');
    expect(tabs.get('flex-direction')).toBe('column');
    expect(activeTab.get('background')).toBe('var(--pmd-c-bg)');
    expect(activeTab.get('border-color')).not.toBe('var(--pmd-c-ribbon-border)');
    expect(list.get('grid-column')).toBe('2');
    expect(list.get('background')).toBe('var(--pmd-c-bg)');
    expect(row.get('padding')).toBe('0.78rem 0');
    expect(row.get('border-bottom')).toBe('1px solid var(--pmd-c-divider-faint)');
  });

  it('puts the Save As dialog on the unified dark dialog system', () => {
    const overrides = styleCss.slice(styleCss.indexOf('Save As on the unified dark dialog system'));
    expect(overrides).toContain('background: var(--pmd-c-dialog-bg);');
    expect(overrides).toContain('color: var(--pmd-c-dialog-text);');
    expect(overrides).toContain('background: var(--pmd-c-dialog-bg-strong);');
    // Secondary buttons share the ribbon-gray cancel treatment; primaries stay accent blue.
    expect(overrides).toContain('.pmd-save-as-dialog .pmd-save-as-btn {');
    expect(overrides).toContain('background: var(--pmd-c-dialog-button);');
    expect(overrides).toContain('.pmd-save-as-dialog .pmd-save-as-btn-primary {');
    expect(overrides).toContain('background: var(--pmd-c-accent);');
  });

  it('aligns the home search and result sections on one Word-like surface', () => {
    expect(declarationsForSelector('.pmd-home-screen').get('background')).toBe('var(--pmd-c-surface)');
    expect(declarationsForSelector('.pmd-home-main').get('background')).toBe('var(--pmd-c-surface)');
    for (const selector of [
      '.pmd-home-search-section',
      '.pmd-home-recents',
      '.pmd-home-recents-header',
      '.pmd-home-sessions-section',
      '.pmd-home-flows-section',
    ]) {
      const declarations = declarationsForSelector(selector);
      expect(declarations.get('width')).toBe('min(720px, 100%)');
      expect(declarations.get('max-width')).toBe('720px');
    }
  });

  it('keeps collaboration avatars at the right edge before utility and window buttons', () => {
    const rightSection = /<div class="ribbon-section ribbon-right">([\s\S]*?)<\/div>\s*<\/div>\s*<\/header>/.exec(indexHtml)?.[1] ?? '';

    expect(rightSection).toContain('id="collab-top-presence"');
    expect(rightSection.indexOf('id="collab-top-presence"')).toBeLessThan(
      rightSection.indexOf('class="ribbon-right-grid"'),
    );
    expect(indexHtml).toContain('id="window-minimize-btn"');
    expect(indexHtml).toContain('id="window-maximize-btn"');
    expect(indexHtml).toContain('id="window-close-btn"');
    expect(indexHtml).not.toContain('id="github-btn"');
    expect(indexHtml).not.toContain('id="timer-toggle-btn"');
    expect(ruleBody('.pmd-collab-top-presence')).toContain('justify-content: flex-end;');
  });

  it('uses borderless animated live status dots', () => {
    const dot = /(?:^|\n)\.pmd-collab-live-dot\s*\{([\s\S]*?)\n\}/m.exec(styleCss)?.[1] ?? '';
    expect(dot).toContain('box-shadow: none;');
    expect(dot).toContain('animation: pmd-live-dot-pulse');
    expect(styleCss).toContain('@keyframes pmd-live-dot-pulse');
    expect(styleCss).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('uses hover-only themed scrollbars for the nav and document scrollers', () => {
    expect(styleCss).toContain('scrollbar-color: transparent transparent;');
    expect(styleCss).toContain('scrollbar-color: var(--pmd-c-scrollbar-chrome-hover) transparent;');
    expect(styleCss).toContain('scrollbar-color: var(--pmd-c-scrollbar-doc-hover) transparent;');
    expect(styleCss).toContain('::-webkit-scrollbar-thumb');
  });

  it('keeps route choice popups in the cleaner Word-style modal family', () => {
    expect(ruleBody('.pmd-route-dialog')).toContain('background: var(--pmd-c-dialog-bg);');
    expect(ruleBody('.pmd-route-dialog')).toContain('border: 1px solid var(--pmd-c-dialog-border);');
    expect(ruleBody('.pmd-route-dialog')).toContain('color: var(--pmd-c-dialog-text);');
    expect(ruleBody('.pmd-route-header')).toContain('color: var(--pmd-c-dialog-text);');
    expect(ruleBody('.pmd-route-btn')).toContain('background: var(--pmd-c-dialog-button);');
    expect(ruleBody('.pmd-route-btn')).toContain('color: var(--pmd-c-dialog-button-text);');
    expect(ruleBody('.pmd-route-btn:hover')).toContain('color: var(--pmd-c-dialog-button-text);');
    expect(ruleBody('.pmd-route-btn:hover')).toContain('border-color: var(--pmd-c-accent);');
    expect(ruleBody('.pmd-route-btn-primary')).toContain('background: var(--pmd-c-accent);');
    expect(ruleBody('.pmd-route-btn-danger')).toContain('background: color-mix(in srgb, var(--pmd-c-error) 68%, #202020);');
    expect(ruleBody('.pmd-route-cancel')).toContain('background: var(--pmd-c-dialog-button);');
    expect(ruleBody('.pmd-route-cancel:hover')).toContain('color: var(--pmd-c-dialog-button-text);');
    expect(ruleBody('.pmd-text-prompt-secondary')).toContain('background: var(--pmd-c-dialog-button);');
    expect(styleCss).toContain('.pmd-text-prompt-danger,');
    expect(styleCss).toContain('background: color-mix(in srgb, var(--pmd-c-error) 68%, #202020);');
  });

  it('uses compact buttons for the co-edited document close/end session screen', () => {
    expect(editorIndexSource).toContain("promptForChoice<'keep' | 'end'>");
    expect(editorIndexSource).not.toContain("promptForRouteChoice<'keep' | 'end'>");
    expect(editorIndexSource).not.toContain('Keep the session');
    expect(editorIndexSource).toContain("label: 'Close'");
  });

  it('renders the open-into route picker as a compact slot dialog with open separate', () => {
    expect(multiPaneSource).toContain('showPaneRouteOverlay');
    expect(multiPaneSource).not.toContain("dialog.className = 'pmd-route-dialog pmd-slot-picker-dialog';");
    expect(multiPaneSource).not.toContain("row.className = 'pmd-route-buttons';");
    expect(multiPaneSource).not.toContain("btn.className = 'pmd-route-btn';");
    expect(multiPaneSource).not.toContain("screen.className = 'pmd-slot-picker-screen';");
    expect(multiPaneSource).not.toContain('No document open');
    expect(declarationsForSelector('.pmd-pane-route-overlay').get('z-index')).toBe('1450');
    expect(declarationsForSelector('.pmd-pane-route-dialog').get('width')).toBe(
      'min(560px, calc(100vw - 32px))',
    );
    expect(declarationsForSelector('.pmd-pane-route-dialog').get('padding')).toBe('1rem 1.1rem 0.9rem');
    expect(declarationsForSelector('.pmd-pane-route-slots').get('grid-template-columns')).toBe(
      'repeat(3, minmax(0, 1fr))',
    );
    expect(declarationsForSelector('.pmd-pane-route-slots').get('gap')).toBe('0');
    expect(declarationsForSelector('.pmd-pane-route-slot').get('background')).toBe('var(--pmd-c-dialog-control)');
    expect(declarationsForSelector('.pmd-pane-route-slot').get('min-height')).toBe('112px');
    expect(declarationsForSelector('.pmd-pane-route-number').get('font-size')).toBe('2.25rem');
    expect(declarationsForSelector('.pmd-pane-route-number').get('border')).toBe('0');
    expect(declarationsForSelector('.pmd-slot-picker-number').get('font-size')).toBe('2.25rem');
    expect(declarationsForSelector('.pmd-slot-picker-number').get('border')).toBe('0');
    expect(declarationsForSelector('.pmd-route-cancel').get('border-radius')).toBe('4px');
    expect(declarationsForSelector('.pmd-pane-route-actions').get('justify-content')).toBe('flex-end');
  });

  it('keeps three-pane footer text from rendering mojibake', () => {
    expect(multiPaneSource).not.toContain("'Î£'");
    expect(multiPaneSource).not.toContain("' Â· '");
    expect(multiPaneSource).toContain("wcBtn.textContent = 'W';");
    expect(multiPaneSource).toContain("parts.join(' | ')");
    expect(multiPaneSource).not.toContain('Could not connect the shared document; local copy is open');
    expect(editorIndexSource).not.toContain('Could not connect the shared document; local copy is open');
  });

  it('keeps embedded Flow chrome compact and tied to the ribbon palette', () => {
    expect(flowWorkspaceCss).toContain('.flow-find {');
    expect(flowWorkspaceCss).toContain('display: none;');
    expect(flowWorkspaceCss).toContain('.sheet-tabs {');
    expect(flowWorkspaceCss).toContain('display: flex;');
    expect(flowWorkspaceCss).toContain('background: transparent;');
    expect(flowWorkspaceCss).toContain('overflow-y: visible;');
    expect(flowWorkspaceCss).toContain('.cm-flow-tab-close {');
    expect(flowWorkspaceCss).toContain('opacity: 0;');
    expect(flowWorkspaceCss).toContain('grid-template-rows: minmax(0, 1fr);');
    expect(declarationsForSelector('body.pmd-flow-active:not(.pmd-multi-doc) #nav-panel').get('display')).toBe(
      'none',
    );
    expect(declarationsForSelector('body.pmd-flow-active:not(.pmd-multi-doc) #status-bar').get('display')).toBe(
      'none',
    );
    expect(declarationsForSelector('body.pmd-flow-active:not(.pmd-multi-doc) #app').get('bottom')).toBe('0');
    expect(declarationsForSelector('body.pmd-flow-active:not(.pmd-multi-doc) #editor').get('padding')).toBe('0');
  });

  it('uses ribbon-border separators around Doc/Card and inline format controls', () => {
    expect(declarationsForSelector('.ribbon-doc-menu-panel').get('border-left')).toBe(
      '1px solid var(--pmd-c-ribbon-border)',
    );
    expect(declarationsForSelector('.ribbon-format-menu-panel').get('border-left')).toBe(
      '1px solid var(--pmd-c-ribbon-border)',
    );
  });

  it('routes manual-save replacement prompts through the shared unsaved dialog without before-creating wording', () => {
    expect(editorIndexSource).not.toContain("title: 'Save your current document before creating a new one?'");
    expect(editorIndexSource).toContain('return confirmCloseUnsaved(activeCloseUnsavedOptions());');
    expect(editorIndexSource).toContain('activeNeedsManualSavePrompt()');
    expect(editorIndexSource).not.toContain('if (!isPristineStarter || activeContentDirty()) {');
    expect(editorIndexSource).not.toContain("header.className = 'pmd-route-header';");
    expect(editorIndexSource).not.toContain("saveBtn.innerHTML = '<strong>Save</strong><br><span>");
  });

  it('opens Search Everything near the editor caret instead of centered on the screen', () => {
    const qcs = ruleBody('.pmd-qcs');
    expect(qcs).not.toContain('left: 50%;');
    expect(qcs).not.toContain('top: 42%;');
    expect(qcs).toContain('transform: none;');
    expect(quickCardSearchSource).toContain('this.view.coordsAtPos(this.view.state.selection.head)');
    expect(quickCardSearchSource).toContain('this.root.style.left =');
    expect(quickCardSearchSource).toContain('this.root.style.top =');
  });
});
