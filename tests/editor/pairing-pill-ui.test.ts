// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { settings } from '../../src/editor/settings.js';
import { SendPillController } from '../../src/editor/pairing/send-pill-ui.js';
import { ReceivePillController } from '../../src/editor/pairing/receive-pill-ui.js';
import { inboxStore } from '../../src/editor/pairing/inbox-store.js';

describe('pairing pill empty-state UX', () => {
  let mounted: { unmount(): void }[] = [];

  beforeEach(async () => {
    document.body.innerHTML = '';
    localStorage.clear();
    settings.replaceAll({ pairingEnabled: true, pairingPartners: [], pairingGroups: [] });
    await inboxStore.clear();
    mounted = [];
  });

  afterEach(async () => {
    for (const controller of mounted.splice(0)) controller.unmount();
    settings.replaceAll({});
    await inboxStore.clear();
    document.body.innerHTML = '';
    localStorage.clear();
  });

  it('opens Send on click and explains that no recipient is configured', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const send = new SendPillController();
    mounted.push(send);
    send.mount({ parent });

    parent.querySelector<HTMLElement>('.pmd-send-bar')!.click();

    expect(parent.querySelector<HTMLElement>('.pmd-send-pill')?.dataset['open']).toBe('true');
    expect(parent.querySelector<HTMLElement>('.pmd-send-empty')?.textContent).toMatch(
      /Add a recipient/i,
    );
  });

  it('keeps Send clickable when sharing is not configured yet', () => {
    settings.replaceAll({ pairingEnabled: false, pairingPartners: [], pairingGroups: [] });
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const send = new SendPillController();
    mounted.push(send);
    send.mount({ parent });

    expect(parent.querySelector<HTMLElement>('.pmd-send-pill')?.hidden).toBe(false);

    parent.querySelector<HTMLElement>('.pmd-send-bar')!.click();

    expect(parent.querySelector<HTMLElement>('.pmd-send-pill')?.dataset['open']).toBe('true');
    expect(parent.querySelector<HTMLElement>('.pmd-send-empty')?.textContent).toMatch(
      /Turn on sharing/i,
    );
  });

  it('opens Receive on click even when the inbox is empty', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const receive = new ReceivePillController();
    mounted.push(receive);
    receive.mount({ parent, getFocusedView: () => null });
    await Promise.resolve();

    parent.querySelector<HTMLElement>('.pmd-receive-bar')!.click();

    expect(parent.querySelector<HTMLElement>('.pmd-receive-pill')?.dataset['open']).toBe('true');
    expect(parent.querySelector<HTMLElement>('.pmd-receive-empty')?.textContent).toMatch(
      /haven't received/i,
    );
  });

  it('keeps Receive clickable when sharing is not configured yet', async () => {
    settings.replaceAll({ pairingEnabled: false, pairingPartners: [], pairingGroups: [] });
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const receive = new ReceivePillController();
    mounted.push(receive);
    receive.mount({ parent, getFocusedView: () => null });
    await Promise.resolve();

    expect(parent.querySelector<HTMLElement>('.pmd-receive-pill')?.hidden).toBe(false);

    parent.querySelector<HTMLElement>('.pmd-receive-bar')!.click();

    expect(parent.querySelector<HTMLElement>('.pmd-receive-pill')?.dataset['open']).toBe('true');
    expect(parent.querySelector<HTMLElement>('.pmd-receive-empty')?.textContent).toMatch(
      /Turn on sharing/i,
    );
  });
});
