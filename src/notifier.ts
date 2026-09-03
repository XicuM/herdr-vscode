import * as vscode from 'vscode';
import { AgentStatus } from './herdrClient';
import { Conversation } from './resolver';

/**
 * Herdr plays notification sounds server-side when a background agent changes
 * state (ui.sound.enabled, request_path for blocked, done_path for done).
 * We do NOT play audio here to avoid double-beeps.
 *
 * This class handles what Herdr cannot: bringing the blocked agent's VS Code
 * terminal to the foreground so the user notices it needs input.
 */

export function statusEmoji(status: AgentStatus): string {
  switch (status) {
    case 'working':
      return '🟡';
    case 'blocked':
      return '🔴';
    case 'done':
      return '🟢';
    case 'idle':
      return '⚪';
    case 'unknown':
    default:
      return '';
  }
}

export function statusThemeIcon(status: AgentStatus): vscode.ThemeIcon {
  switch (status) {
    case 'working':
      return new vscode.ThemeIcon('play');
    case 'blocked':
      return new vscode.ThemeIcon('bell-dot');
    case 'done':
      return new vscode.ThemeIcon('check');
    case 'idle':
      return new vscode.ThemeIcon('circle-outline');
    default:
      return new vscode.ThemeIcon('terminal');
  }
}

export function statusThemeColor(status: AgentStatus): vscode.ThemeColor {
  switch (status) {
    case 'working':
      return new vscode.ThemeColor('terminal.ansiYellow');
    case 'blocked':
      return new vscode.ThemeColor('terminal.ansiRed');
    case 'done':
      return new vscode.ThemeColor('terminal.ansiGreen');
    case 'idle':
    default:
      return new vscode.ThemeColor('terminal.ansiBrightBlack');
  }
}

export function terminalNameFor(tabId: string, label?: string, status?: AgentStatus): string {
  const shortTab = tabId.includes(':t') ? tabId.replace(/^.*:t/, 't') : tabId;
  const agentLabel = label || 'agent';
  const emoji = status ? statusEmoji(status) : '';
  return emoji ? `${emoji} ${agentLabel} (${shortTab})` : `herdr:${agentLabel}:${shortTab}`;
}

export class AgentAttender {
  private last = new Map<string, AgentStatus>();
  /** pane_id -> conversations (populated by the refresh loop). */
  private convByPane = new Map<string, Conversation>();
  private onFocus?: (conv: Conversation) => void;

  constructor(private cfg: { focusOnBlocked: boolean }) {}

  updateConfig(cfg: { focusOnBlocked: boolean }) {
    this.cfg = cfg;
  }

  setOnFocus(fn: (conv: Conversation) => void) {
    this.onFocus = fn;
  }

  setConversations(convs: Conversation[]) {
    this.convByPane.clear();
    for (const c of convs) this.convByPane.set(c.pane_id, c);
  }

  handleStatusChange(paneId: string, status: AgentStatus) {
    const prev = this.last.get(paneId);
    if (prev === status) return;
    this.last.set(paneId, status);

    if (status === 'blocked' && this.cfg.focusOnBlocked) {
      this.focusConversation(paneId);
    }
  }

  private focusConversation(paneId: string) {
    const conv = this.convByPane.get(paneId);
    if (!conv) return;
    if (this.onFocus) {
      this.onFocus(conv);
    }
    const emoji = statusEmoji(conv.status);
    const emojiStr = emoji ? ` (${emoji})` : '';
    vscode.window.showInformationMessage(
      `Herdr: ${conv.label}${emojiStr} is blocked and waiting for your input`
    );
  }
}

