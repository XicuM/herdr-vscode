import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { HerdrClient, Snapshot, HARNESS_KINDS } from './herdrClient';
import { AgentResolver, Conversation } from './resolver';
import { AgentAttender, statusEmoji } from './notifier';

let client: HerdrClient;
let resolver: AgentResolver;
let attender: AgentAttender;
let refreshTimer: NodeJS.Timeout | undefined;
let convByTab = new Map<string, Conversation>();
let statusBarItem: vscode.StatusBarItem;
let currentActiveTabId: string | undefined;

function getCfg(): { focusOnBlocked: boolean; session: string } {
  const conf = vscode.workspace.getConfiguration('herdr');
  return {
    focusOnBlocked: conf.get('focusOnBlocked', true),
    session: conf.get('session', 'vscode')
  };
}

function currentFolder(): string {
  const ws = vscode.workspace.workspaceFolders;
  // Prefer the active workspace folder; with no folder open, fall back to a
  // stable per-user base so commands always have a workspace to use.
  if (ws && ws.length > 0) return ws[0].uri.fsPath;
  return os.homedir();
}

function updateStatusBar(convs: Conversation[]) {
  if (!statusBarItem) return;
  if (!client.isAvailable()) {
    statusBarItem.text = '$(circle-slash) Herdr (offline)';
    statusBarItem.tooltip = 'Herdr daemon is not running';
    statusBarItem.backgroundColor = undefined;
    statusBarItem.show();
    return;
  }

  if (convs.length === 0) {
    statusBarItem.text = '$(terminal) Herdr (+)';
    statusBarItem.tooltip = 'Click to start a new Herdr agent conversation';
    statusBarItem.backgroundColor = undefined;
    statusBarItem.show();
    return;
  }

  const blocked = convs.filter((c) => c.status === 'blocked');
  const working = convs.filter((c) => c.status === 'working');

  if (blocked.length > 0) {
    statusBarItem.text = `$(bell-dot) Herdr: ${blocked.map((b) => b.label).join(', ')} blocked`;
    statusBarItem.tooltip = `Herdr: ${blocked.length} agent(s) waiting for input. Click to switch.`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else if (working.length > 0) {
    const labels = convs
      .map((c) => {
        const emoji = statusEmoji(c.status);
        return emoji ? `${emoji} ${c.label}` : c.label;
      })
      .join(' ');
    statusBarItem.text = `$(sync~spin) Herdr: ${labels}`;
    statusBarItem.tooltip = `Herdr: ${working.length} agent(s) working. Click to switch.`;
    statusBarItem.backgroundColor = undefined;
  } else {
    const labels = convs
      .map((c) => {
        const emoji = statusEmoji(c.status);
        return emoji ? `${emoji} ${c.label}` : c.label;
      })
      .join(' ');
    statusBarItem.text = `$(terminal) Herdr: ${labels}`;
    statusBarItem.tooltip = `Herdr: ${convs.length} agent(s) active. Click to switch.`;
    statusBarItem.backgroundColor = undefined;
  }
  statusBarItem.show();
}

async function syncHerdrTabLabels(convs: Conversation[], snapshot: Snapshot) {
  for (const c of convs) {
    const emoji = statusEmoji(c.status);
    const desiredLabel = emoji ? `${emoji} ${c.label}` : c.label;
    const snapTab = snapshot.tabs.find((t) => t.tab_id === c.tab_id);
    if (snapTab && snapTab.label !== desiredLabel) {
      await client.renameTab(c.tab_id, desiredLabel);
    }
  }
}

async function refreshState() {
  if (!client.isAvailable()) {
    updateStatusBar([]);
    return;
  }
  let snapshot: Snapshot;
  try {
    snapshot = await client.snapshot();
  } catch {
    updateStatusBar([]);
    return;
  }
  const folder = currentFolder();
  const convs = resolver.buildConversations(snapshot, folder);
  convByTab = new Map(convs.map((c) => [c.tab_id, c]));
  attender.setConversations(convs);
  updateStatusBar(convs);

  // Continuously synchronize Herdr's top tab labels with live agent status & names
  await syncHerdrTabLabels(convs, snapshot);

  for (const c of convs) attender.handleStatusChange(c.pane_id, c.status);
}

const HERDR_TERMINAL_NAME = 'Herdr';

function ensureHerdrTerminal(): vscode.Terminal {
  let term = vscode.window.terminals.find((t) => t.name === HERDR_TERMINAL_NAME);
  if (!term) {
    term = vscode.window.createTerminal({
      name: HERDR_TERMINAL_NAME,
      iconPath: new vscode.ThemeIcon('beaker'),
      color: new vscode.ThemeColor('terminal.ansiCyan'),
      message: 'Herdr AI Coding Agent Workspace (Isolated Session)',
      env: {
        HERDR_ENV: null,
        HERDR_PANE_ID: null,
        HERDR_TAB_ID: null
      }
    });
    const folder = currentFolder();
    const cfg = getCfg();
    const sessionArg = cfg.session ? `--session "${cfg.session}"` : '';
    const configPath = cfg.session
      ? path.join(os.homedir(), '.config', 'herdr', 'sessions', cfg.session, 'config.toml')
      : path.join(os.homedir(), '.config', 'herdr', 'config.toml');
    const configEnv = fs.existsSync(configPath) ? `HERDR_CONFIG_PATH="${configPath}" ` : '';
    term.sendText(
      `cd "${folder}" && env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID ${configEnv}herdr ${sessionArg}`.trim(),
      true
    );
  }
  return term;
}

function cleanupSubTerminals() {
  for (const term of vscode.window.terminals) {
    if (term.name !== HERDR_TERMINAL_NAME && (term.name.startsWith('herdr:') || term.name.includes('(t'))) {
      term.dispose();
    }
  }
}

function attachTerminal(conv: Conversation) {
  currentActiveTabId = conv.tab_id;
  const term = ensureHerdrTerminal();
  term.show(true);
  client.focusWorkspace(conv.workspace_id).catch(() => {});
  client.focusTab(conv.tab_id).catch(() => {});
}

async function focusWorkspace() {
  if (!client.isAvailable()) return;
  const folder = currentFolder();
  let snap: Snapshot;
  try {
    snap = await client.snapshot();
  } catch {
    return;
  }
  let ws = resolver.findWorkspaceForFolder(snap, folder);
  let wsId = ws?.workspace_id;
  if (!wsId) {
    wsId = await resolver.ensureWorkspace(folder, snap);
  }
  if (wsId) {
    await client.focusWorkspace(wsId);
    ensureHerdrTerminal().show(true);
    refreshState();
  }
}

async function newShellTab() {
  if (!client.isAvailable()) {
    vscode.window.showErrorMessage('Herdr is not running. Start it in a terminal (`herdr`).');
    return;
  }
  const folder = currentFolder();
  const snap = await client.snapshot();
  const workspaceId = await resolver.ensureWorkspace(folder, snap);
  ensureHerdrTerminal().show(true);
  await client.focusWorkspace(workspaceId);
  const tabRes = await client.createTab(workspaceId, 'shell', true);
  if (tabRes?.tab?.tab_id) {
    currentActiveTabId = tabRes.tab.tab_id;
    await client.focusTab(tabRes.tab.tab_id);
  }
  refreshState();
}

async function newConversation() {
  if (!client.isAvailable()) {
    vscode.window.showErrorMessage('Herdr is not running. Start it in a terminal (`herdr`).');
    return;
  }
  const kind = await vscode.window.showQuickPick(HARNESS_KINDS.map((k) => ({ label: k })), {
    placeHolder: 'Which coding harness should this conversation run? (opencode, claude, codex, ...)'
  });
  if (!kind) return;

  const folder = currentFolder();
  const snapshot = await client.snapshot();
  const workspaceId = await resolver.ensureWorkspace(folder, snapshot);

  // Ensure the single Herdr master terminal is visible and focused on this workspace
  ensureHerdrTerminal().show(true);
  await client.focusWorkspace(workspaceId);

  // Focus the new tab so its shell becomes an "available shell" for agent.start.
  const tabRes = await client.createTab(workspaceId, null, true);
  const paneId = tabRes.root_pane?.pane_id;
  const tabId = tabRes.tab?.tab_id;
  if (!paneId || !tabId) {
    vscode.window.showErrorMessage('Could not create a conversation pane.');
    return;
  }

  currentActiveTabId = tabId;
  client.focusTab(tabId);

  const name = `${kind.label.replace(/[^a-z0-9_]/g, '_')}_${Date.now().toString(36)}`;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Starting ${kind.label}…`, cancellable: false },
      () => client.agentStart(name, kind.label, paneId, [], 45000)
    );
  } catch (e: any) {
    vscode.window.showErrorMessage(`Could not start ${kind.label} in the new pane: ${e.message}`);
    try {
      await client.closeTab(tabId);
    } catch {}
    return;
  }

  refreshState();
}

async function openConversation(tabId?: string) {
  const conv = tabId ? convByTab.get(tabId) : undefined;
  if (!conv) return refreshState();
  attachTerminal(conv);
}

async function closeConversation(tabId?: string) {
  const conv = tabId ? convByTab.get(tabId) : undefined;
  if (!conv) return;

  try {
    const snap = await client.snapshot();
    const wsTabs = snap.tabs.filter((t) => t.workspace_id === conv.workspace_id);
    // If closing this tab would leave the workspace empty (<= 1 tab),
    // spawn a clean shell tab first so Herdr doesn't destroy the workspace
    // and kick the user out to a different project workspace.
    if (wsTabs.length <= 1) {
      const tabRes = await client.createTab(conv.workspace_id, 'shell', true);
      if (tabRes?.tab?.tab_id) {
        currentActiveTabId = tabRes.tab.tab_id;
      }
    }
  } catch {}

  await client.closeTab(conv.tab_id);
  refreshState();
}

async function pickConversation(action: 'Open' | 'Close' | 'Switch') {
  const convs = [...convByTab.values()];
  if (convs.length === 0 && action !== 'Close') {
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(home) Focus / Restore Workspace', id: '__focus__', description: 'Switch Herdr terminal view back to this workspace' },
        { label: '$(terminal) New Shell Tab', id: '__shell__', description: 'Open a plain shell in this workspace' },
        { label: '$(plus) New Agent Conversation...', id: '__new__', description: 'Start an agent in a new tab' },
        { label: '$(refresh) Refresh Herdr Status', id: '__refresh__' }
      ],
      { placeHolder: 'No active agent conversations in this workspace' }
    );
    if (pick?.id === '__focus__') focusWorkspace();
    if (pick?.id === '__shell__') newShellTab();
    if (pick?.id === '__new__') newConversation();
    if (pick?.id === '__refresh__') refreshState();
    return;
  }

  const statusPriority: Record<string, number> = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };
  const sortedConvs = [...convs].sort((a, b) => {
    const prioDiff = (statusPriority[a.status] ?? 5) - (statusPriority[b.status] ?? 5);
    if (prioDiff !== 0) return prioDiff;
    return a.label.localeCompare(b.label);
  });

  const items: (vscode.QuickPickItem & { id: string })[] = sortedConvs.map((c) => {
    const emoji = statusEmoji(c.status);
    const prefix = emoji ? `${emoji} ` : '';
    const shortTab = c.tab_id.includes(':t') ? c.tab_id.replace(/^.*:t/, 't') : c.tab_id;
    return {
      label: `${prefix}${c.label}`,
      description: c.status === 'unknown' ? `Tab ${shortTab}` : `[${c.status.toUpperCase()}] Tab ${shortTab}`,
      detail: `Pane: ${c.pane_id}${c.status === 'blocked' ? ' • (Waiting for your input!)' : ''}`,
      id: c.tab_id
    };
  });

  if (action !== 'Close') {
    items.push(
      {
        label: '$(plus) New Agent Conversation...',
        description: 'Start an agent in a new tab',
        id: '__new__'
      },
      {
        label: '$(terminal) New Shell Tab...',
        description: 'Open a plain shell in this workspace',
        id: '__shell__'
      },
      {
        label: '$(home) Focus Current Workspace',
        description: 'Switch Herdr view back to this workspace',
        id: '__focus__'
      }
    );
  }

  const sel = await vscode.window.showQuickPick(items, {
    placeHolder: `${action === 'Switch' ? 'Select agent terminal to switch to' : action + ' conversation'}`
  });

  if (!sel) return;
  if (sel.id === '__new__') {
    newConversation();
  } else if (sel.id === '__shell__') {
    newShellTab();
  } else if (sel.id === '__focus__') {
    focusWorkspace();
  } else if (action === 'Close') {
    closeConversation(sel.id);
  } else {
    openConversation(sel.id);
  }
}

async function diagnose() {
  const lines: string[] = [];
  const folder = currentFolder();
  lines.push(`workspaceFolders: ${vscode.workspace.workspaceFolders?.length ?? 0}`);
  lines.push(`folder: ${folder || '(none)'}`);
  lines.push(`isAvailable: ${client.isAvailable()}`);
  try {
    const snap = await client.snapshot();
    lines.push(`snapshot OK, agents=${snap.agents.length}, workspaces=${snap.workspaces.length}`);
    const convs = folder ? resolver.buildConversations(snap, folder) : [];
    lines.push(`conversations for folder: ${convs.length}`);
    lines.push(`single terminal: ${HERDR_TERMINAL_NAME}`);
  } catch (e: any) {
    lines.push(`snapshot FAILED: ${e.message}`);
  }
  vscode.window.showInformationMessage(lines.join('\n'), { modal: true });
}

function getOrderedConvs(): Conversation[] {
  const convs = [...convByTab.values()];
  const statusPriority: Record<string, number> = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };
  return convs.sort((a, b) => {
    const prioDiff = (statusPriority[a.status] ?? 5) - (statusPriority[b.status] ?? 5);
    if (prioDiff !== 0) return prioDiff;
    return a.label.localeCompare(b.label);
  });
}

function switchNext() {
  const convs = getOrderedConvs();
  if (convs.length === 0) return;
  const currIdx = convs.findIndex((c) => c.tab_id === currentActiveTabId);
  const nextIdx = currIdx === -1 ? 0 : (currIdx + 1) % convs.length;
  attachTerminal(convs[nextIdx]);
}

function switchPrev() {
  const convs = getOrderedConvs();
  if (convs.length === 0) return;
  const currIdx = convs.findIndex((c) => c.tab_id === currentActiveTabId);
  const prevIdx = currIdx === -1 ? 0 : (currIdx - 1 + convs.length) % convs.length;
  attachTerminal(convs[prevIdx]);
}

function setupRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    refreshState();
  }, 2000);
}

function registerCommandSafe(
  context: vscode.ExtensionContext,
  command: string,
  callback: (...args: any[]) => any
) {
  try {
    context.subscriptions.push(vscode.commands.registerCommand(command, callback));
  } catch (err: any) {
    console.warn(`[Herdr] Command '${command}' could not be registered: ${err?.message || err}`);
  }
}

export function activate(context: vscode.ExtensionContext) {
  const cfg = getCfg();
  client = new HerdrClient(cfg.session);
  resolver = new AgentResolver(client);
  attender = new AgentAttender(cfg);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  statusBarItem.command = 'herdr.switchConversation';
  statusBarItem.text = '$(terminal) Herdr';
  statusBarItem.tooltip = 'Herdr Agent Switcher';
  statusBarItem.show();

  attender.setOnFocus((conv) => {
    ensureHerdrTerminal().show(true);
    client.focusWorkspace(conv.workspace_id).catch(() => {});
    client.focusTab(conv.tab_id).catch(() => {});
  });

  cleanupSubTerminals();
  ensureHerdrTerminal().show(true);

  context.subscriptions.push(
    statusBarItem,
    vscode.window.onDidCloseTerminal((term) => {
      if (term.name === HERDR_TERMINAL_NAME) {
        currentActiveTabId = undefined;
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('herdr.session')) {
        const newCfg = getCfg();
        client = new HerdrClient(newCfg.session);
        resolver = new AgentResolver(client);
        refreshState();
      }
      if (e.affectsConfiguration('herdr')) {
        attender.updateConfig(getCfg());
        refreshState();
      }
    })
  );

  registerCommandSafe(context, 'herdr.openMasterTerminal', () => ensureHerdrTerminal().show(true));
  registerCommandSafe(context, 'herdr.focusWorkspace', () => focusWorkspace());
  registerCommandSafe(context, 'herdr.newShellTab', () => newShellTab());
  registerCommandSafe(context, 'herdr.newConversation', () => newConversation());
  registerCommandSafe(context, 'herdr.switchConversation', () => pickConversation('Switch'));
  registerCommandSafe(context, 'herdr.switchNext', () => switchNext());
  registerCommandSafe(context, 'herdr.switchPrev', () => switchPrev());
  registerCommandSafe(context, 'herdr.openConversation', () => pickConversation('Open'));
  registerCommandSafe(context, 'herdr.closeConversation', () => pickConversation('Close'));
  registerCommandSafe(context, 'herdr.refresh', () => refreshState());
  registerCommandSafe(context, 'herdr.diagnose', () => diagnose());

  setupRefresh();
  refreshState();
  focusWorkspace().catch(() => {});

  client
    .subscribeEvents((evt) => {
      const type = evt.type || evt.event;
      if (
        type === 'pane.agent_status_changed' ||
        type === 'pane.agent_detected' ||
        type === 'tab.created' ||
        type === 'tab.closed' ||
        type === 'tab.renamed'
      ) {
        refreshState();
      }
    })
    .catch(() => {});
}

export function deactivate() {
  clearInterval(refreshTimer);
  if (statusBarItem) {
    statusBarItem.dispose();
  }
}
