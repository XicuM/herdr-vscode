import * as path from 'path';
import type { AgentStatus, HerdrClient, Snapshot, Workspace } from './herdrClient';

/**
 * Conversation model.
 *
 * A "conversation" is one Herdr tab (and one pane) in a folder's workspace.
 * Several conversations may run the same harness (e.g. two opencode agents).
 */

export interface Conversation {
  /** The Herdr tab (one per conversation). */
  tab_id: string;
  workspace_id: string;
  /** Pane shown for this tab: the agent pane when a tab is split, else its first pane. */
  pane_id: string;
  /** Harness kind detected by Herdr, or null while it's a plain shell. */
  agent: string | null;
  /** Live agent status. */
  status: AgentStatus;
  /** Display label: harness, else the tab's own name. */
  label: string;
  running: boolean;
}

export const STATUS_PRIORITY: Record<string, number> = {
  blocked: 0,
  working: 1,
  done: 2,
  idle: 3,
  unknown: 4
};

export function compareByStatus(a: Conversation, b: Conversation): number {
  const prioDiff = (STATUS_PRIORITY[a.status] ?? 5) - (STATUS_PRIORITY[b.status] ?? 5);
  if (prioDiff !== 0) return prioDiff;
  return a.label.localeCompare(b.label);
}

function normPath(p: string): string {
  const n = path.resolve(p);
  return n.length > 1 ? n.replace(/[\\/]+$/, '') : n;
}

export class AgentResolver {
  constructor(private client: HerdrClient) {}

  /** Find the Herdr workspace for a folder path. */
  findWorkspaceForFolder(snapshot: Snapshot, folderPath: string): Workspace | null {
    const folder = normPath(folderPath);
    const folderBase = path.basename(folder);
    const workspaces = snapshot.workspaces || [];
    const panes = snapshot.panes || [];

    const inFolder = (workspaceId: string) =>
      panes.some((p) => {
        const cwd = p.cwd || p.foreground_cwd;
        return p.workspace_id === workspaceId && !!cwd && normPath(cwd) === folder;
      });

    // 1. A workspace labelled after the folder whose panes really are there.
    const matchingByLabel = workspaces.filter((w) => w.label === folderBase);
    for (const w of matchingByLabel) {
      if (inFolder(w.workspace_id)) return w;
    }

    // 2. Any workspace with a pane in this folder.
    for (const w of workspaces) {
      if (inFolder(w.workspace_id)) return w;
    }

    // 3. Label match, even if no pane has reported a cwd yet.
    return matchingByLabel[0] ?? null;
  }

  /** Ensure a folder has a Herdr workspace; create it without stealing focus. */
  async ensureWorkspace(folderPath: string, snapshot: Snapshot): Promise<string> {
    const existing = this.findWorkspaceForFolder(snapshot, folderPath);
    if (existing) return existing.workspace_id;
    const folder = normPath(folderPath);
    const created = await this.client.createWorkspace(folder, path.basename(folder), false);
    return created.workspace.workspace_id;
  }

  /** One conversation per tab, in herdr's own tab order. */
  buildConversations(snapshot: Snapshot, folderPath: string): Conversation[] {
    const ws = this.findWorkspaceForFolder(snapshot, folderPath);
    return ws ? this.conversationsForWorkspace(snapshot, ws.workspace_id) : [];
  }

  /** Conversations for a known herdr workspace (the tree is not folder-bound). */
  conversationsForWorkspace(snapshot: Snapshot, workspaceId: string): Conversation[] {
    const panes = (snapshot.panes || []).filter((p) => p.workspace_id === workspaceId);
    return (snapshot.tabs || [])
      .filter((t) => t.workspace_id === workspaceId)
      .map((t) => {
        const tabPanes = panes.filter((p) => p.tab_id === t.tab_id);
        const pane =
          tabPanes.find((p) => p.focused && p.agent) ||
          tabPanes.find((p) => p.agent) ||
          tabPanes.find((p) => p.focused) ||
          tabPanes[0] ||
          null;
        const agent = pane?.agent || null;
        const status = (pane?.agent_status || t.agent_status || 'unknown') as AgentStatus;
        // Herdr auto-labels tabs "1", "2" (the `number` field is global, not the
        // per-workspace index), so a non-numeric label is a user rename and wins.
        const customLabel = t.label && !/^\d+$/.test(t.label) ? t.label : null;
        return {
          tab_id: t.tab_id,
          workspace_id: workspaceId,
          pane_id: pane?.pane_id || t.tab_id.replace(/:t([^:]*)$/, ':p$1'),
          agent,
          status,
          label: customLabel || agent || t.label || 'shell',
          running: !!agent || (t.pane_count ?? 0) > 0
        };
      });
  }
}
