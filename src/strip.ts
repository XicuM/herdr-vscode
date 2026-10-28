import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { Conversation } from './resolver';

/** What the webview needs to draw one tab. */
export interface StripTab {
  tab_id: string;
  agent: string | null;
  status: string;
  label: string;
}

export interface StripState {
  tabs: StripTab[];
  activeId?: string;
  /** Set while herdr is unreachable. */
  offline?: string;
}

export type StripAction =
  | { cmd: 'open' | 'close'; id: string }
  | { cmd: 'rename'; id: string; label: string }
  | { cmd: 'reorder'; id: string; target: string; before: boolean }
  | { cmd: 'new' }
  | { cmd: 'input'; data: string }
  | { cmd: 'resize'; cols: number; rows: number }
  | { cmd: 'scroll'; direction: 'up' | 'down'; lines: number };

/** Tabs in the order the user dragged them; tabs not yet placed keep herdr's order, after the placed ones. */
export function orderTabs(convs: Conversation[], order: string[]): Conversation[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return convs
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (rank.get(a.c.tab_id) ?? order.length) - (rank.get(b.c.tab_id) ?? order.length) || a.i - b.i)
    .map(({ c }) => c);
}

/** Move [id] next to [target]; unknown ids leave the order as it was. */
export function moveTab(ids: string[], id: string, target: string, before: boolean): string[] {
  if (id === target || !ids.includes(id) || !ids.includes(target)) return ids;
  const rest = ids.filter((t) => t !== id);
  rest.splice(rest.indexOf(target) + (before ? 0 : 1), 0, id);
  return rest;
}

/** Obsidian-style Herdr view: herdr's tabs on top, the active pane's terminal (xterm.js) below. */
export class TabStrip implements vscode.WebviewViewProvider {
  static readonly viewType = 'herdr.tabs';
  private view?: vscode.WebviewView;

  constructor(
    private extensionUri: vscode.Uri,
    private state: () => StripState,
    private onAction: (action: StripAction) => void,
    /** The view's terminal was (re)created or is gone. */
    private onDetach: () => void
  ) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const asset = (file: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(media, file));
    const nonce = randomBytes(16).toString('hex');
    view.webview.html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource} 'unsafe-inline'; font-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset('vendor/xterm.css')}">
<link rel="stylesheet" href="${asset('strip.css')}">
</head>
<body>
<div id="bar">
  <div id="tabs" role="tablist" aria-label="Herdr tabs"></div>
</div>
<div id="term"></div>
<script nonce="${nonce}" src="${asset('vendor/xterm.js')}"></script>
<script nonce="${nonce}" src="${asset('vendor/addon-fit.js')}"></script>
<script nonce="${nonce}" src="${asset('agentLogos.js')}"></script>
<script nonce="${nonce}" src="${asset('strip.js')}"></script>
</body>
</html>`;
    view.webview.onDidReceiveMessage((m: StripAction | { cmd: 'ready' }) => {
      if (m.cmd === 'ready') {
        this.refresh();
        this.onDetach();
      } else this.onAction(m);
    });
    view.onDidDispose(() => {
      if (this.view !== view) return;
      this.view = undefined;
      this.onDetach();
    });
  }

  refresh() {
    void this.view?.webview.postMessage({ type: 'state', state: this.state() });
  }

  /** Terminal output (base64), a cleared screen, or the reason the stream ended. */
  write(bytes: string) {
    void this.view?.webview.postMessage({ type: 'data', bytes });
  }

  reset() {
    void this.view?.webview.postMessage({ type: 'reset' });
  }

  closed(reason: string) {
    void this.view?.webview.postMessage({ type: 'closed', reason });
  }

  reveal(preserveFocus: boolean) {
    if (this.view) this.view.show(preserveFocus);
    else void vscode.commands.executeCommand(`${TabStrip.viewType}.focus`);
  }
}
