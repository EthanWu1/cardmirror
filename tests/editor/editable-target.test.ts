// @vitest-environment jsdom
/**
 * Mod+A must select the focused text box's contents (editor, settings field) but
 * never the whole GUI when nothing editable is focused — e.g. right after
 * alt-tabbing back without clicking in.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isEditableTarget,
  suppressGuiSelectAll,
} from '../../src/editor/editable-target.js';

describe('isEditableTarget', () => {
  it('is true for input / textarea / select / contenteditable', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const select = document.createElement('select');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true'); // jsdom doesn't reflect the property
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(textarea)).toBe(true);
    expect(isEditableTarget(select)).toBe(true);
    expect(isEditableTarget(editable)).toBe(true);
  });

  it('is false for the body, a button, and null', () => {
    expect(isEditableTarget(document.body)).toBe(false);
    expect(isEditableTarget(document.createElement('button'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('suppressGuiSelectAll', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.addEventListener('keydown', suppressGuiSelectAll, true);
  });
  afterEach(() => {
    document.removeEventListener('keydown', suppressGuiSelectAll, true);
  });

  function fire(target: HTMLElement, init: KeyboardEventInit): boolean {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e.defaultPrevented;
  }

  it('prevents Mod+A when nothing editable is focused (body)', () => {
    expect(fire(document.body, { key: 'a', metaKey: true })).toBe(true);
    // Ctrl+A (Windows/Linux) on the chrome too.
    expect(fire(document.body, { key: 'a', ctrlKey: true })).toBe(true);
  });

  it('does NOT prevent Mod+A inside a text box', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    expect(fire(input, { key: 'a', metaKey: true })).toBe(false);

    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true'); // jsdom doesn't reflect the property
    document.body.appendChild(editable);
    expect(fire(editable, { key: 'a', metaKey: true })).toBe(false);
  });

  it('ignores plain "a", Mod+Shift+A, and Mod+Alt+A', () => {
    expect(fire(document.body, { key: 'a' })).toBe(false);
    expect(fire(document.body, { key: 'a', metaKey: true, shiftKey: true })).toBe(false);
    expect(fire(document.body, { key: 'a', metaKey: true, altKey: true })).toBe(false);
  });
});
