import { describe, expect, it, vi } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { schema } from '../../src/schema/index.js';
import {
  getRibbonCommand,
  RIBBON_COMMAND_IDS,
  RIBBON_COMMAND_LABELS,
  type RibbonContext,
} from '../../src/editor/ribbon-commands.js';
import { RIBBON_GROUPS } from '../../src/editor/ribbon-groups.js';

describe('startDragSelection command registry', () => {
  it('is available to keybindings and custom ribbon buttons', () => {
    expect(RIBBON_COMMAND_IDS).toContain('startDragSelection');
    expect(RIBBON_COMMAND_LABELS['startDragSelection']).toBe('Start Drag Selection');
    expect(RIBBON_GROUPS.some((group) => group.commands.includes('startDragSelection'))).toBe(true);
  });

  it('runs the context action through the ribbon command path', () => {
    const startDragSelection = vi.fn();
    const command = getRibbonCommand(
      'startDragSelection',
      { startDragSelection } as unknown as RibbonContext,
    );
    const state = EditorState.create({
      schema,
      doc: schema.nodes['doc']!.createAndFill()!,
    });

    expect(command(state)).toBe(true);
    expect(startDragSelection).not.toHaveBeenCalled();

    expect(command(state, vi.fn())).toBe(true);
    expect(startDragSelection).toHaveBeenCalledTimes(1);
  });
});
