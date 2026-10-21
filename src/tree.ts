import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentStatus } from './herdrClient';
import type { Conversation } from './resolver';

export interface FolderState {
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

export class FolderNode extends vscode.TreeItem {
  constructor(readonly state: FolderState) {
    const known = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(state.folder));
    super(known?.name ?? path.basename(state.folder) ?? state.folder, vscode.TreeItemCollapsibleState.Expanded);
    const blocked = state.conversations.filter((c) => c.status === 'blocked').length;
    const total = state.conversations.length;
    this.id = `folder:${state.folder}`;
    this.contextValue = 'herdrFolder';
    this.resourceUri = vscode.Uri.file(state.folder);
    this.iconPath = new vscode.ThemeIcon('beaker');
    this.description =
      total === 0
        ? 'no agents'
        : `${total} agent${total === 1 ? '' : 's'}${blocked ? `, ${blocked} blocked` : ''}`;
    this.tooltip = state.folder;
  }
}

export class ConversationNode extends vscode.TreeItem {
  constructor(
    readonly conv: Conversation,
    readonly folder: string
  ) {
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
  constructor(folder: string) {
    super('No agents — start one', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('plus');
    this.command = {
      command: 'herdr.newConversation',
      title: 'New agent conversation',
      arguments: [folder]
    };
  }
}

export type HerdrNode = FolderNode | ConversationNode | EmptyNode;

export class HerdrTreeProvider implements vscode.TreeDataProvider<HerdrNode> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private folders: () => FolderState[]) {}

  refresh() {
    this.emitter.fire();
  }

  getTreeItem(element: HerdrNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: HerdrNode): HerdrNode[] {
    if (!element) return this.folders().map((f) => new FolderNode(f));
    if (element instanceof FolderNode) {
      const { folder, conversations } = element.state;
      return conversations.length
        ? conversations.map((c) => new ConversationNode(c, folder))
        : [new EmptyNode(folder)];
    }
    return [];
  }
}
