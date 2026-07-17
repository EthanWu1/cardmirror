import { describe, expect, it } from 'vitest';
import { CATEGORY_TABS } from '../../src/editor/settings-categories.js';
import { defaultSettings, SETTING_METADATA, SettingsStore } from '../../src/editor/settings.js';

describe('flow settings', () => {
  it('has a Flow category and default values', () => {
    expect(CATEGORY_TABS.map((tab) => tab.id)).toContain('flow');
    expect(defaultSettings.defaultFlowFormat).toBe('ld');
    expect(defaultSettings.flowAffColor).toBe('#dff3ff');
    expect(defaultSettings.flowNegColor).toBe('#ffe8e1');
    expect(defaultSettings.flowSelectionColor).toBe('#7db9e8');
    expect(defaultSettings.flowZoomDefault).toBe(1);
  });

  it('moves the legacy Excel Flow warm-host option into the Flow category', () => {
    const row = SETTING_METADATA.find((item) => item.key === 'flowHostOnLaunch');
    expect(row?.category).toBe('flow');
    expect(row?.label).toMatch(/Excel|Verbatim|Flow/);
  });

  it('exposes native Flow settings rows in the Flow category', () => {
    const flowRows = SETTING_METADATA.filter((row) => row.category === 'flow').map((row) => row.key);
    expect(flowRows).toEqual(
      expect.arrayContaining([
        'defaultFlowFormat',
        'flowZoomDefault',
        'flowAffColor',
        'flowNegColor',
        'flowSelectionColor',
        'flowHostOnLaunch',
      ]),
    );
  });

  it('sanitizes native Flow settings', () => {
    const store = new SettingsStore();
    store.replaceAll({
      defaultFlowFormat: 'pf',
      flowAffColor: '#ABCDEF',
      flowNegColor: 'tomato',
      flowSelectionColor: 123,
      flowZoomDefault: 99,
    });

    expect(store.get('defaultFlowFormat')).toBe('pf');
    expect(store.get('flowAffColor')).toBe('#abcdef');
    expect(store.get('flowNegColor')).toBe('#ffe8e1');
    expect(store.get('flowSelectionColor')).toBe('#7db9e8');
    expect(store.get('flowZoomDefault')).toBe(5);

    store.replaceAll({
      defaultFlowFormat: 'policy',
      flowZoomDefault: 0.1,
    });
    expect(store.get('defaultFlowFormat')).toBe('policy');
    expect(store.get('flowZoomDefault')).toBe(0.5);

    store.replaceAll({
      defaultFlowFormat: 'worlds',
    });
    expect(store.get('defaultFlowFormat')).toBe('ld');
  });
});
