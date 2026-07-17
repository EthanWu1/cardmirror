// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderTopPresenceForTests } from '../../src/editor/collab/collab-ui.js';

describe('top collaboration presence strip', () => {
  it('hides while alone and renders only avatars when a partner is present', () => {
    document.body.innerHTML = '<div id="collab-top-presence" hidden></div>';

    renderTopPresenceForTests(
      [{ peer: 'self', name: 'Ethan', color: 'rgb(10, 20, 30)', self: true }],
      { connected: true, queuedUpdates: 0 },
    );

    const strip = document.getElementById('collab-top-presence')!;
    expect(strip.hidden).toBe(true);
    expect(strip.querySelector('.pmd-collab-live-chip')).toBeNull();
    expect(strip.querySelectorAll('.pmd-collab-avatar')).toHaveLength(0);

    renderTopPresenceForTests(
      [
        { peer: 'self', name: 'Ethan', color: 'rgb(10, 20, 30)', self: true },
        { peer: 'peer-priya', name: 'Priya Shah', color: 'rgb(40, 50, 60)', self: false },
      ],
      { connected: false, queuedUpdates: 1 },
    );

    expect(strip.hidden).toBe(false);
    expect(strip.querySelector('.pmd-collab-live-chip')).toBeNull();
    expect(strip.querySelectorAll('.pmd-collab-avatar')).toHaveLength(2);
    expect(strip.textContent).toContain('E');
    expect(strip.textContent).toContain('PS');
    expect(strip.title).toContain('Priya Shah');
    expect(strip.title).toContain('colored cursors');
  });

  it('uses Anonymous when a peer has no display name', () => {
    document.body.innerHTML = '<div id="collab-top-presence" hidden></div>';

    renderTopPresenceForTests(
      [
        { peer: 'self', name: 'Ethan', color: 'rgb(10, 20, 30)', self: true },
        { peer: 'peer-anon', name: '', color: 'rgb(40, 50, 60)', self: false },
      ],
      { connected: true, queuedUpdates: 0 },
    );

    const strip = document.getElementById('collab-top-presence')!;
    const avatars = strip.querySelectorAll('.pmd-collab-avatar');
    expect(avatars).toHaveLength(2);
    expect(avatars[1]!.textContent).toBe('A');
    expect(avatars[1]!.getAttribute('title')).toBe('Anonymous');
    expect(strip.title).toContain('Anonymous');
  });

  it('clicking a partner avatar asks the session to jump to that peer cursor', () => {
    document.body.innerHTML = '<div id="collab-top-presence" hidden></div>';
    const jumped: string[] = [];

    renderTopPresenceForTests(
      [
        { peer: 'self', name: 'Ethan', color: 'rgb(10, 20, 30)', self: true },
        { peer: 'peer-priya', name: 'Priya Shah', color: 'rgb(40, 50, 60)', self: false },
      ],
      { connected: true, queuedUpdates: 0 },
      (peer) => jumped.push(peer),
    );

    const avatars = document.querySelectorAll<HTMLElement>('.pmd-collab-avatar');
    expect(avatars[0]!.dataset['peer']).toBe('self');
    expect(avatars[1]!.dataset['peer']).toBe('peer-priya');
    avatars[0]!.click();
    avatars[1]!.click();

    expect(jumped).toEqual(['peer-priya']);
  });
});
