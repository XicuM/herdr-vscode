import { describe, expect, it, vi } from 'vitest';
import { AgentResolver, compareByStatus } from '../src/resolver';
import type { HerdrClient, Snapshot } from '../src/herdrClient';

function snapshot(partial: Partial<Snapshot>): Snapshot {
  return { agents: [], panes: [], tabs: [], workspaces: [], ...partial };
}

describe('findWorkspaceForFolder', () => {
  it('prefers a label match that also has a pane in the folder', () => {
    const snap = snapshot({
      workspaces: [
        { workspace_id: 'w1', label: 'other' },
        { workspace_id: 'w2', label: 'proj' }
      ],
      panes: [
        { pane_id: 'p1', tab_id: 't1', workspace_id: 'w1', cwd: '/work/other' },
        { pane_id: 'p2', tab_id: 't2', workspace_id: 'w2', cwd: '/work/proj' }
      ]
    });
    const resolver = new AgentResolver({} as HerdrClient);
    expect(resolver.findWorkspaceForFolder(snap, '/work/proj')?.workspace_id).toBe('w2');
  });

  it('matches by pane cwd when the label differs', () => {
    const snap = snapshot({
      workspaces: [{ workspace_id: 'w1', label: 'renamed' }],
      panes: [{ pane_id: 'p1', tab_id: 't1', workspace_id: 'w1', cwd: '/work/proj' }]
    });
    const resolver = new AgentResolver({} as HerdrClient);
    expect(resolver.findWorkspaceForFolder(snap, '/work/proj')?.workspace_id).toBe('w1');
  });

  it('normalises trailing slashes', () => {
    const snap = snapshot({
      workspaces: [{ workspace_id: 'w1', label: 'elsewhere' }],
      panes: [{ pane_id: 'p1', tab_id: 't1', workspace_id: 'w1', cwd: '/work/proj/' }]
    });
    const resolver = new AgentResolver({} as HerdrClient);
    expect(resolver.findWorkspaceForFolder(snap, '/work/proj')?.workspace_id).toBe('w1');
  });

  it('does not match a pane with no cwd against the process cwd', () => {
    const snap = snapshot({
      workspaces: [{ workspace_id: 'w1', label: 'elsewhere' }],
      panes: [{ pane_id: 'p1', tab_id: 't1', workspace_id: 'w1' }]
    });
    const resolver = new AgentResolver({} as HerdrClient);
    expect(resolver.findWorkspaceForFolder(snap, process.cwd())).toBeNull();
  });

  it('falls back to a bare label match', () => {
    const snap = snapshot({ workspaces: [{ workspace_id: 'w1', label: 'proj' }] });
    const resolver = new AgentResolver({} as HerdrClient);
    expect(resolver.findWorkspaceForFolder(snap, '/work/proj')?.workspace_id).toBe('w1');
  });

  it('returns null when nothing matches', () => {
    const resolver = new AgentResolver({} as HerdrClient);
    expect(resolver.findWorkspaceForFolder(snapshot({}), '/work/proj')).toBeNull();
  });
});

describe('ensureWorkspace', () => {
  it('returns the existing workspace without creating one', async () => {
    const createWorkspace = vi.fn();
    const resolver = new AgentResolver({ createWorkspace } as unknown as HerdrClient);
    const snap = snapshot({
      workspaces: [{ workspace_id: 'w1', label: 'proj' }],
      panes: [{ pane_id: 'p1', tab_id: 't1', workspace_id: 'w1', cwd: '/work/proj' }]
    });
    expect(await resolver.ensureWorkspace('/work/proj', snap)).toEqual({ workspaceId: 'w1' });
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('creates a workspace labelled after the folder, without focusing it, and hands back its first tab', async () => {
    const createWorkspace = vi.fn().mockResolvedValue({
      workspace: { workspace_id: 'w2', label: 'proj' },
      tab: { tab_id: 'w2:t1', workspace_id: 'w2' },
      root_pane: { pane_id: 'w2:p1' }
    });
    const resolver = new AgentResolver({ createWorkspace } as unknown as HerdrClient);
    const env = { COLORFGBG: '15;0' };
    expect(await resolver.ensureWorkspace('/work/proj/', snapshot({}), env)).toEqual({
      workspaceId: 'w2',
      root: { tab_id: 'w2:t1', pane_id: 'w2:p1' }
    });
    expect(createWorkspace).toHaveBeenCalledWith('/work/proj', 'proj', false, env);
  });
});

describe('buildConversations', () => {
  it('builds one conversation per tab in herdr order, preferring the agent pane', () => {
    const snap = snapshot({
      workspaces: [{ workspace_id: 'w1', label: 'proj' }],
      panes: [
        { pane_id: 'p1', tab_id: 't1', workspace_id: 'w1', cwd: '/work/proj' },
        { pane_id: 'p2', tab_id: 't1', workspace_id: 'w1', cwd: '/work/proj', agent: 'claude', agent_status: 'blocked' },
        { pane_id: 'p3', tab_id: 't2', workspace_id: 'w1', cwd: '/work/proj' }
      ],
      tabs: [
        { tab_id: 't2', workspace_id: 'w1', label: 'notes' },
        { tab_id: 't1', workspace_id: 'w1', agent_status: 'working', pane_count: 2 }
      ]
    });
    const resolver = new AgentResolver({} as HerdrClient);
    const convs = resolver.buildConversations(snap, '/work/proj');
    expect(convs.map((c) => c.tab_id)).toEqual(['t2', 't1']);
    expect(convs[0]).toMatchObject({ label: 'notes', status: 'unknown', pane_id: 'p3' });
    expect(convs[1]).toMatchObject({ label: 'claude', status: 'blocked', pane_id: 'p2', running: true });
  });

  it('falls back to the tab id when a tab has no panes', () => {
    const snap = snapshot({
      workspaces: [{ workspace_id: 'w1', label: 'proj' }],
      tabs: [{ tab_id: 'x:t7', workspace_id: 'w1', label: 'shell' }]
    });
    const resolver = new AgentResolver({} as HerdrClient);
    expect(resolver.buildConversations(snap, '/work/proj')[0]).toMatchObject({
      pane_id: 'x:p7',
      label: 'shell',
      status: 'unknown'
    });
  });

  it('prefers a user-renamed tab label over the harness name', () => {
    const snap = snapshot({
      workspaces: [{ workspace_id: 'w1', label: 'proj' }],
      panes: [{ pane_id: 'p1', tab_id: 't1', workspace_id: 'w1', agent: 'claude', agent_status: 'idle' }],
      tabs: [{ tab_id: 't1', workspace_id: 'w1', number: 1, label: 'reviewer' }]
    });
    const resolver = new AgentResolver({} as HerdrClient);
    expect(resolver.buildConversations(snap, '/work/proj')[0].label).toBe('reviewer');
  });

  it('uses the harness name for auto-numbered agent tabs', () => {
    const snap = snapshot({
      workspaces: [{ workspace_id: 'w1', label: 'proj' }],
      panes: [{ pane_id: 'p1', tab_id: 't1', workspace_id: 'w1', agent: 'claude', agent_status: 'idle' }],
      tabs: [{ tab_id: 't1', workspace_id: 'w1', number: 1, label: '1' }]
    });
    const resolver = new AgentResolver({} as HerdrClient);
    expect(resolver.buildConversations(snap, '/work/proj')[0].label).toBe('claude');
  });

  it('returns [] when there is no workspace', () => {
    const resolver = new AgentResolver({} as HerdrClient);
    expect(resolver.buildConversations(snapshot({}), '/work/proj')).toEqual([]);
  });
});

describe('compareByStatus', () => {
  it('orders blocked > working > done > idle > unknown, then by label', () => {
    const c = (status: string, label: string) =>
      ({ status, label, tab_id: label, workspace_id: 'w', pane_id: label, agent: null, running: true }) as any;
    const list = [c('unknown', 'a'), c('idle', 'b'), c('done', 'c'), c('working', 'd'), c('blocked', 'e'), c('blocked', 'f')];
    expect(list.sort(compareByStatus).map((x) => x.label)).toEqual(['e', 'f', 'd', 'c', 'b', 'a']);
  });
});
