import { describe, expect, it, vi } from 'vitest';
import type { Conversation } from '../src/resolver';

vi.mock('vscode', () => ({}));

const conv = (tab_id: string): Conversation => ({
  tab_id, workspace_id: 'w', pane_id: `p${tab_id}`, agent: null, status: 'idle', label: tab_id, running: true
});

describe('tab strip order', () => {
  it('keeps herdr order for tabs the user has not placed, after the placed ones', async () => {
    const { orderTabs } = await import('../src/strip');
    const ordered = orderTabs(['a', 'b', 'c', 'd'].map(conv), ['c', 'a']);
    expect(ordered.map((c) => c.tab_id)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('moves a tab before or after its target', async () => {
    const { moveTab } = await import('../src/strip');
    expect(moveTab(['a', 'b', 'c'], 'c', 'a', true)).toEqual(['c', 'a', 'b']);
    expect(moveTab(['a', 'b', 'c'], 'a', 'b', false)).toEqual(['b', 'a', 'c']);
  });

  it('ignores unknown ids and self-drops', async () => {
    const { moveTab } = await import('../src/strip');
    const ids = ['a', 'b'];
    expect(moveTab(ids, 'a', 'a', true)).toBe(ids);
    expect(moveTab(ids, 'x', 'a', true)).toBe(ids);
    expect(moveTab(ids, 'a', 'x', true)).toBe(ids);
  });
});
