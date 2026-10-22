import * as vscode from 'vscode';
import type { AgentStatus } from './herdrClient';
import type { Conversation } from './resolver';

export interface WorkspaceState {
  workspaceId: string;
  label: string;
  /** A cwd for new tabs in this workspace (from its first pane, or the active folder). */
  folder: string;
  conversations: Conversation[];
}

function statusIcon(status: AgentStatus): vscode.ThemeIcon {
  switch (status) {
    case 'blocked':
      return new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('terminal.ansiRed'));
    case 'working':
      return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('terminal.ansiYellow'));
    case 'done':
      return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('terminal.ansiGreen'));
    case 'idle':
      return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('terminal.ansiBrightBlack'));
    default:
      return new vscode.ThemeIcon('terminal');
  }
}

export class WorkspaceNode extends vscode.TreeItem {
  constructor(readonly state: WorkspaceState) {
    super(state.label, vscode.TreeItemCollapsibleState.Expanded);
    const agents = state.conversations.filter((c) => c.agent).length;
    const shells = state.conversations.length - agents;
    const blocked = state.conversations.filter((c) => c.status === 'blocked').length;
    this.id = `workspace:${state.workspaceId}`;
    this.contextValue = 'herdrWorkspace';
    this.iconPath = new vscode.ThemeIcon('beaker');
    const parts: string[] = [];
    if (agents) parts.push(`${agents} agent${agents === 1 ? '' : 's'}`);
    if (shells) parts.push(`${shells} shell${shells === 1 ? '' : 's'}`);
    if (blocked) parts.push(`${blocked} blocked`);
    this.description = parts.join(', ') || 'no tabs';
    this.tooltip = `${state.label}\n${state.folder}\n${state.workspaceId}`;
  }
}

export class ConversationNode extends vscode.TreeItem {
  constructor(readonly conv: Conversation) {
    super(conv.label, vscode.TreeItemCollapsibleState.None);
    this.id = `tab:${conv.tab_id}`;
    this.contextValue = 'herdrConversation';
    this.iconPath = statusIcon(conv.status);
    this.description = `${conv.agent ?? 'shell'} · ${conv.status}`;
    this.tooltip = `${conv.label} (${conv.agent ?? 'shell'}, ${conv.status})\nTab ${conv.tab_id}`;
    this.command = {
      command: 'herdr.openConversation',
      title: 'Open conversation',
      arguments: [this]
    };
  }
}

class EmptyNode extends vscode.TreeItem {
  constructor(folder?: string) {
    super('No agents — start one', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('plus');
    this.command = {
      command: 'herdr.newConversation',
      title: 'New agent conversation',
      arguments: folder ? [folder] : []
    };
  }
}

export type HerdrNode = WorkspaceNode | ConversationNode | EmptyNode;

export class HerdrTreeProvider implements vscode.TreeDataProvider<HerdrNode> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private workspaces: () => WorkspaceState[]) {}

  refresh() {
    this.emitter.fire();
  }

  getTreeItem(element: HerdrNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: HerdrNode): HerdrNode[] {
    if (!element) {
      const states = this.workspaces();
      return states.length ? states.map((s) => new WorkspaceNode(s)) : [new EmptyNode()];
    }
    if (element instanceof WorkspaceNode) {
      return element.state.conversations.length
        ? element.state.conversations.map((c) => new ConversationNode(c))
        : [new EmptyNode(element.state.folder)];
    }
    return [];
  }
}
