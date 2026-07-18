import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const styleCss = (await fs.readFile(path.join(process.cwd(), 'src', 'editor', 'style.css'), 'utf8')).replace(/\r\n/g, '\n');
const indexTs = (await fs.readFile(path.join(process.cwd(), 'src', 'editor', 'index.ts'), 'utf8')).replace(/\r\n/g, '\n');

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(styleCss);
  return match?.[1] ?? '';
}

describe('ribbon button chrome', () => {
  it('keeps ribbon buttons flat until hover fills them without drawing an outline', () => {
    const base = ruleBody('#ribbon button');
    const hover = ruleBody('#ribbon button:hover:not(:disabled)');

    expect(base).toContain('background: transparent;');
    expect(base).toContain('border: 1px solid transparent;');
    expect(hover).toContain('background: var(--pmd-c-ribbon-hover);');
    expect(hover).not.toContain('border-color:');
    expect(hover).not.toContain('outline:');
  });

  it('keeps split color controls flat until hover fills them without drawing an outline', () => {
    const base = ruleBody('.ribbon-color-control');
    const hover = ruleBody('.ribbon-color-control:hover');

    expect(base).toContain('background: transparent;');
    expect(base).toContain('border: 1px solid transparent;');
    expect(hover).toContain('background: var(--pmd-c-ribbon-hover);');
    expect(hover).not.toContain('border-color:');
    expect(hover).not.toContain('outline:');
  });

  it('uses ribbon-specific colors for smaller controls so icons stay visible', () => {
    expect(ruleBody('#ribbon .ribbon-color-control button.ribbon-color-arrow'))
      .toContain('color: var(--pmd-c-ribbon-text-secondary);');
    expect(ruleBody('#ribbon .ribbon-font-size-input'))
      .toContain('color: var(--pmd-c-ribbon-text);');
    expect(ruleBody('#ribbon .ribbon-doc-ops-btn'))
      .toContain('color: var(--pmd-c-ribbon-text);');
    expect(ruleBody('.ribbon-doc-menu-arrow'))
      .toContain('color: var(--pmd-c-ribbon-text-secondary);');
    expect(ruleBody('#ribbon .pmd-timer-panel button'))
      .toContain('color: var(--pmd-c-ribbon-text);');
    expect(ruleBody('#ribbon .pmd-timer-panel button:hover:not(:disabled)'))
      .toContain('background: var(--pmd-c-ribbon-hover);');
    expect(ruleBody('.pmd-timer-display'))
      .toContain('background: var(--pmd-c-doc-paper);');
    expect(ruleBody('.pmd-timer-display'))
      .toContain('color: var(--pmd-c-ribbon-text);');
  });

  it('uses dark gray ribbon borders for toolbar group dividers', () => {
    expect(ruleBody('.ribbon-speech-stack')).toContain('border-left: 1px solid var(--pmd-c-ribbon-border);');
    expect(ruleBody('.ribbon-quickcards-stack')).toContain('border-left: 1px solid var(--pmd-c-ribbon-border);');
    expect(ruleBody('.ribbon-formatting-panel')).toContain('border-left: 1px solid var(--pmd-c-ribbon-border);');
    expect(ruleBody('.ribbon-cite-panel')).toContain('border-left: 1px solid var(--pmd-c-ribbon-border);');
    expect(ruleBody('.ribbon-color-panel')).toContain('border-left: 1px solid var(--pmd-c-ribbon-border);');
    expect(ruleBody('.ribbon-doc-ops-panel')).toContain('border-left: 1px solid var(--pmd-c-ribbon-border);');
    expect(ruleBody('.ribbon-numbering-panel')).toContain('border-left: 1px solid var(--pmd-c-ribbon-border);');
  });

  it('keeps formatting style previews on in the top toolbar', () => {
    expect(indexTs).toContain('const stylePreview = true;');
    expect(indexTs).toMatch(/applyFormattingPanel\(\s*s\.formattingPanelMode,\s*stylePreview,/);
    expect(indexTs).toMatch(/applyFormattingPanel\(\s*settings\.get\('formattingPanelMode'\),\s*stylePreview,/);
    expect(ruleBody('#ribbon .ribbon-formatting-panel.style-preview .formatting-panel-pocket'))
      .toContain('border-color: var(--pmd-c-emphasis-box);');
    expect(ruleBody('#ribbon .ribbon-cite-panel.style-preview .formatting-panel-emphasis'))
      .toContain('text-decoration: underline;');
  });
});
