import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
  HerdrClient,
  Snapshot,
  HARNESS_KINDS,
  HARNESS_LABELS,
  HarnessKind
} from './herdrClient';
import { AgentResolver, Conversation, compareByStatus } from './resolver';
import { AgentAttender } from './notifier';
import { formatReference, referencePath } from './mentions';
import { FolderState, FolderNode, ConversationNode, HerdrTreeProvider } from './tree';

interface Config {
  focusOnBlocked: boolean;
  session: string;
  autoStart: boolean;
  defaultHarness: HarnessKind;
}

let client: HerdrClient;
let resolver: AgentResolver;
let attender: AgentAttender;
let tree: HerdrTreeProvider;
let statusBarItem: vscode.StatusBarItem;
let herdrTerminal: vscode.Terminal | undefined;
let unsubscribeEvents: (() => void) | undefined;

let snapshot: Snapshot | undefined;
let convByTab = new Map<string, Conversation>();
let currentActiveTabId: string | undefined;
let connectionError: string | undefined;

let refreshRunning: Promise<void> = Promise.resolve();
let refreshQueued: Promise<void> | null = null;

function getCfg(): Config {
  const conf = vscode.workspace.getConfiguration('herdr');
  const session = conf.get<string>('session', 'vscode');
  const configured = conf.get<string>('defaultHarness', 'claude');
  const defaultHarness = (HARNESS_KINDS as readonly string[]).includes(configured)
    ? (configured as HarnessKind)
    : 'claude';
  return {
    focusOnBlocked: conf.get('focusOnBlocked', true),
    session,
    autoStart: conf.get('autoStart', false),
    defaultHarness
  };
}

function folderForActiveEditor(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  const owner = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri);
  return owner?.uri.fsPath;
}

function currentFolder(): string {
  return folderForActiveEditor() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
}

function folders(): string[] {
  const roots = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath);
  return roots && roots.length > 0 ? roots : [os.homedir()];
}

function folderFrom(arg?: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof FolderNode) return arg.state.folder;
  return currentFolder();
}

function folderStates(): FolderState[] {
  return folders().map((folder) => ({
    folder,
    conversations: snapshot ? resolver.buildConversations(snapshot, folder) : []
  }));
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function showError(message: string) {
  void vscode.window.showErrorMessage(`Herdr: ${message}`);
}

function statusTooltip(convs: Conversation[]): string {
  if (convs.length === 0) return 'No agent conversations in this folder. Click to start one.';
  const lines = convs.map((c) => `${c.label}: ${c.status}`);
  return `${lines.join('\n')}\n\nClick to switch agent conversation.`;
}

function updateStatusBar(convs: Conversation[]) {
  if (!statusBarItem) return;
  statusBarItem.backgroundColor = undefined;

  if (connectionError) {
    statusBarItem.text = '$(circle-slash) Herdr (offline)';
    statusBarItem.tooltip = `${connectionError}\n\nRun herdr, or enable "herdr.autoStart".`;
    statusBarItem.show();
    return;
  }

  if (convs.length === 0) {
    statusBarItem.text = '$(terminal) Herdr (+)';
    statusBarItem.tooltip = statusTooltip(convs);
    statusBarItem.show();
    return;
  }

  const blocked = convs.filter((c) => c.status === 'blocked');
  const working = convs.filter((c) => c.status === 'working');

  if (blocked.length > 0) {
    statusBarItem.text = `$(bell-dot) Herdr: ${blocked.length} blocked`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else if (working.length > 0) {
    statusBarItem.text = `$(sync~spin) Herdr: ${working.length} working`;
  } else {
    statusBarItem.text = `$(terminal) Herdr (${convs.length})`;
  }
  statusBarItem.tooltip = statusTooltip(convs);
  statusBarItem.show();
}

function setOffline(message: string) {
  connectionError = message;
  updateStatusBar([]);
  tree?.refresh();
}

/** Re-render the current folder from the last snapshot (cheap; no IPC). */
function render() {
  if (!snapshot) {
    updateStatusBar([]);
    tree?.refresh();
    return;
  }
  const convs = resolver.buildConversations(snapshot, currentFolder());
  convByTab = new Map(convs.map((c) => [c.tab_id, c]));
  if (snapshot.focused_tab_id && convByTab.has(snapshot.focused_tab_id)) {
    currentActiveTabId = snapshot.focused_tab_id;
  }
  attender.setConversations(convs);
  updateStatusBar(convs);
  tree?.refresh();
}

function applySnapshot(snap: Snapshot) {
  snapshot = snap;
  connectionError = undefined;
  render();
  for (const c of convByTab.values()) attender.handleStatusChange(c.pane_id, c.status);
}

async function fetchSnapshot(): Promise<void> {
  if (!client.isAvailable()) {
    setOffline(
      `No herdr socket at ${client.getSocketPath()}. Start herdr, or enable "herdr.autoStart".`
    );
    return;
  }
  try {
    applySnapshot(await client.snapshot());
  } catch (e) {
    setOffline(`Could not read herdr state: ${errorMessage(e)}`);
  }
}

/** One snapshot request at a time; calls made meanwhile share one follow-up. */
function refreshState(): Promise<void> {
  if (refreshQueued === null) {
    refreshQueued = refreshRunning.then(() => {
      refreshQueued = null;
      return (refreshRunning = fetchSnapshot());
    });
  }
  return refreshQueued;
}

function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function ensureHerdrTerminal(): vscode.Terminal {
  if (herdrTerminal && herdrTerminal.exitStatus === undefined) return herdrTerminal;

  const cfg = getCfg();
  herdrTerminal = vscode.window.createTerminal({
    name: 'Herdr',
    cwd: currentFolder(),
    iconPath: new vscode.ThemeIcon('beaker'),
    color: new vscode.ThemeColor('terminal.ansiCyan'),
    message: 'Herdr AI coding agents (isolated session)',
    env: {
      HERDR_ENV: null,
      HERDR_PANE_ID: null,
      HERDR_TAB_ID: null
    }
  });

  const sessionArg = cfg.session ? ` --session ${posixQuote(cfg.session)}` : '';
  const configPath = cfg.session
    ? path.join(os.homedir(), '.config', 'herdr', 'sessions', cfg.session, 'config.toml')
    : path.join(os.homedir(), '.config', 'herdr', 'config.toml');
  const configEnv = fs.existsSync(configPath)
    ? `HERDR_CONFIG_PATH=${posixQuote(configPath)} `
    : '';
  herdrTerminal.sendText(
    `env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID ${configEnv}herdr${sessionArg}`,
    true
  );
  return herdrTerminal;
}

function revealConversation(conv: Conversation, preserveFocus = false) {
  currentActiveTabId = conv.tab_id;
  try {
    ensureHerdrTerminal().show(preserveFocus);
  } catch (e) {
    showError(`could not open the terminal: ${errorMessage(e)}`);
    return;
  }
  client.focusWorkspace(conv.workspace_id).catch(() => {
    // Best effort: the terminal still shows the current herdr tab.
  });
  client.focusTab(conv.tab_id).catch(() => {
    // Best effort.
  });
}

function conversationFrom(arg?: unknown): Conversation | undefined {
  if (arg instanceof ConversationNode) return arg.conv;
  if (typeof arg === 'string') return convByTab.get(arg);
  if (arg && typeof arg === 'object' && 'tab_id' in arg) return arg as Conversation;
  return currentActiveTabId ? convByTab.get(currentActiveTabId) : undefined;
}

function isLightTheme(): boolean {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
}

function tabEnv(): Record<string, string> {
  // TUIs read COLORFGBG before their first render; OSC 11 detection is too late.
  return { COLORFGBG: isLightTheme() ? '0;15' : '15;0' };
}

async function pickHarness(): Promise<HarnessKind | undefined> {
  const preferred = getCfg().defaultHarness;
  const items = HARNESS_KINDS.map((harness) => ({
    label: HARNESS_LABELS[harness],
    description: harness,
    harness
  })).sort((a, b) => Number(b.harness === preferred) - Number(a.harness === preferred));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select the agent to start',
    matchOnDescription: true
  });
  return picked?.harness;
}

async function newConversation(folder?: unknown) {
  const target = folderFrom(folder);
  if (!client.isAvailable()) {
    showError('herdr is not running. Start it in a terminal (`herdr`).');
    return;
  }
  const kind = await pickHarness();
  if (!kind) return;

  let createdTab: string | undefined;
  try {
    const snap = await client.snapshot();
    const workspaceId = await resolver.ensureWorkspace(target, snap);
    const created = await client.createTab(workspaceId, null, false, tabEnv());
    const paneId = created.root_pane?.pane_id;
    const tabId = created.tab?.tab_id;
    if (!paneId || !tabId) throw new Error('could not create a conversation pane');
    createdTab = tabId;

    const name = `${kind}_${Date.now().toString(36)}`;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Starting ${HARNESS_LABELS[kind]}…`,
        cancellable: false
      },
      () => client.agentStart(name, kind, paneId, [], 45000)
    );

    currentActiveTabId = tabId;
    ensureHerdrTerminal().show(false);
    await client.focusWorkspace(workspaceId);
    await client.focusTab(tabId);
    await refreshState();
  } catch (e) {
    if (createdTab) await client.closeTab(createdTab).catch(() => {});
    showError(`could not start ${HARNESS_LABELS[kind]}: ${errorMessage(e)}`);
  }
}

async function newShellTab(folder?: unknown) {
  const target = folderFrom(folder);
  if (!client.isAvailable()) {
    showError('herdr is not running. Start it in a terminal (`herdr`).');
    return;
  }
  try {
    const snap = await client.snapshot();
    const workspaceId = await resolver.ensureWorkspace(target, snap);
    const created = await client.createTab(workspaceId, 'shell', false, tabEnv());
    const tabId = created.tab?.tab_id;
    if (tabId) currentActiveTabId = tabId;
    ensureHerdrTerminal().show(false);
    await client.focusWorkspace(workspaceId);
    if (tabId) await client.focusTab(tabId);
    await refreshState();
  } catch (e) {
    showError(`could not create a shell tab: ${errorMessage(e)}`);
  }
}

async function focusWorkspace(folder?: unknown) {
  const target = folderFrom(folder);
  if (!client.isAvailable()) {
    showError('herdr is not running. Start it in a terminal (`herdr`).');
    return;
  }
  try {
    const snap = await client.snapshot();
    const workspaceId = await resolver.ensureWorkspace(target, snap);
    await client.focusWorkspace(workspaceId);
    ensureHerdrTerminal().show(false);
    await refreshState();
  } catch (e) {
    showError(`could not focus the workspace: ${errorMessage(e)}`);
  }
}

async function closeTab(conv: Conversation) {
  try {
    const snap = await client.snapshot();
    const workspaceTabs = (snap.tabs || []).filter((t) => t.workspace_id === conv.workspace_id);
    // Closing the last tab would destroy the workspace and drop the user into
    // another project: leave a clean shell behind, like herdr-obsidian.
    if (workspaceTabs.length <= 1) {
      await client.createTab(conv.workspace_id, 'shell', false, tabEnv());
    }
    await client.closeTab(conv.tab_id);
    if (currentActiveTabId === conv.tab_id) currentActiveTabId = undefined;
    await refreshState();
  } catch (e) {
    showError(`could not close the tab: ${errorMessage(e)}`);
  }
}

function openConversation(arg?: unknown) {
  if (arg === undefined) {
    void pickConversation('Open');
    return;
  }
  const conv = conversationFrom(arg);
  if (conv) revealConversation(conv);
}

async function renameConversation(arg?: unknown) {
  let conv = conversationFrom(arg);
  if (!conv) {
    const items = [...convByTab.values()]
      .sort(compareByStatus)
      .map((c) => ({ label: c.label, description: c.status, conv: c }));
    conv = (await vscode.window.showQuickPick(items, { placeHolder: 'Rename which tab?' }))?.conv;
  }
  if (!conv) return;

  const name = await vscode.window.showInputBox({
    prompt: 'New herdr tab name',
    value: conv.label
  });
  if (!name?.trim()) return;
  try {
    await client.renameTab(conv.tab_id, name.trim());
    await refreshState();
  } catch (e) {
    showError(`could not rename the tab: ${errorMessage(e)}`);
  }
}

async function sendSelection() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    showError('open a file first.');
    return;
  }
  const conv = conversationFrom();
  if (!conv) {
    showError('no active conversation. Open one from the Herdr view first.');
    return;
  }
  if (!herdrTerminal || herdrTerminal.exitStatus !== undefined) {
    showError('open a conversation first: the Herdr terminal is not running.');
    return;
  }

  const owner =
    folders().find((folder) =>
      snapshot ? resolver.buildConversations(snapshot, folder).some((c) => c.tab_id === conv.tab_id) : false
    ) ?? folderForActiveEditor() ?? currentFolder();
  const file = referencePath(owner, editor.document.uri.fsPath);
  const sel = editor.selection;
  let start: number | undefined;
  let end: number | undefined;
  if (!sel.isEmpty) {
    start = sel.start.line + 1;
    end = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
  } else {
    start = sel.active.line + 1;
    end = start;
  }

  const payload = formatReference(conv.agent, file, start, end);
  try {
    await client.focusWorkspace(conv.workspace_id);
    await client.focusTab(conv.tab_id);
  } catch (e) {
    showError(`could not focus the conversation: ${errorMessage(e)}`);
    return;
  }
  try {
    const term = ensureHerdrTerminal();
    term.show(false);
    term.sendText(payload, false);
  } catch (e) {
    showError(`could not send the reference: ${errorMessage(e)}`);
  }
}

function statusCodicon(status: string): string {
  switch (status) {
    case 'blocked':
      return '$(bell-dot)';
    case 'working':
      return '$(sync~spin)';
    case 'done':
      return '$(pass-filled)';
    case 'idle':
      return '$(circle-outline)';
    default:
      return '$(terminal)';
  }
}

async function pickConversation(action: 'Open' | 'Close' | 'Switch') {
  const convs = [...convByTab.values()];
  if (convs.length === 0 && action !== 'Close') {
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(home) Focus / Restore Workspace', id: '__focus__' },
        { label: '$(terminal) New Shell Tab', id: '__shell__' },
        { label: '$(plus) New Agent Conversation…', id: '__new__' },
        { label: '$(refresh) Refresh Herdr Status', id: '__refresh__' }
      ],
      { placeHolder: 'No agent conversations in this folder' }
    );
    if (pick?.id === '__focus__') await focusWorkspace();
    if (pick?.id === '__shell__') await newShellTab();
    if (pick?.id === '__new__') await newConversation();
    if (pick?.id === '__refresh__') await refreshState();
    return;
  }

  const items: (vscode.QuickPickItem & { id: string })[] = convs
    .sort(compareByStatus)
    .map((c) => ({
      label: `${statusCodicon(c.status)} ${c.label}`,
      description: `${c.status.toUpperCase()}${c.agent ? ` · ${c.agent}` : ''}`,
      detail: c.status === 'blocked' ? 'Waiting for your input' : undefined,
      id: c.tab_id
    }));

  if (action !== 'Close') {
    items.push(
      { label: '$(plus) New Agent Conversation…', description: 'Start an agent in a new tab', id: '__new__' },
      { label: '$(terminal) New Shell Tab…', description: 'Open a plain shell in this folder', id: '__shell__' },
      { label: '$(home) Focus Current Workspace', description: 'Bring the herdr view back here', id: '__focus__' }
    );
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder:
      action === 'Close' ? 'Select a conversation to close' : 'Switch to an agent conversation',
    matchOnDescription: true
  });
  if (!picked) return;

  if (picked.id === '__new__') return newConversation();
  if (picked.id === '__shell__') return newShellTab();
  if (picked.id === '__focus__') return focusWorkspace();

  const conv = convByTab.get(picked.id);
  if (!conv) return;
  if (action === 'Close') return closeTab(conv);
  revealConversation(conv);
}

function switchNext() {
  const convs = [...convByTab.values()];
  if (convs.length === 0) return;
  const curr = convs.findIndex((c) => c.tab_id === currentActiveTabId);
  revealConversation(convs[(curr + 1) % convs.length]);
}

function switchPrev() {
  const convs = [...convByTab.values()];
  if (convs.length === 0) return;
  const curr = convs.findIndex((c) => c.tab_id === currentActiveTabId);
  revealConversation(convs[(curr - 1 + convs.length) % convs.length]);
}

/** Status-bar click: straight to a blocked agent, else the switcher. */
function attend() {
  const blocked = [...convByTab.values()].find((c) => c.status === 'blocked');
  if (blocked) return revealConversation(blocked);
  return pickConversation('Switch');
}

async function diagnose() {
  const lines = [
    `session: ${client.session || '(default)'}`,
    `socket: ${client.getSocketPath()} (${client.isAvailable() ? 'found' : 'missing'})`,
    `autoStart: ${getCfg().autoStart}`,
    `last error: ${connectionError ?? '(none)'}`,
    `folders: ${folders().join(', ')}`
  ];
  try {
    const snap = await client.snapshot();
    lines.push(
      `snapshot: ${snap.workspaces?.length ?? 0} workspaces, ${snap.tabs?.length ?? 0} tabs, ${snap.agents?.length ?? 0} agents`
    );
    for (const folder of folders()) {
      const ws = resolver.findWorkspaceForFolder(snap, folder);
      const convs = resolver.buildConversations(snap, folder);
      lines.push(`${folder}: ${ws ? `${ws.label} (${ws.workspace_id})` : 'no workspace'}, ${convs.length} tabs`);
      for (const c of convs.slice(0, 10)) lines.push(`  - ${c.label}: ${c.status}`);
      if (convs.length > 10) lines.push(`  … and ${convs.length - 10} more`);
    }
  } catch (e) {
    lines.push(`snapshot failed: ${errorMessage(e)}`);
  }
  void vscode.window.showInformationMessage(lines.join('\n'), { modal: true });
}

function subscribeEvents() {
  unsubscribeEvents?.();
  unsubscribeEvents = client.subscribeEvents(
    () => void refreshState(),
    (up) => {
      if (up) void refreshState();
      else setOffline('Herdr event stream disconnected. Is herdr still running?');
    }
  );
}

function wireAttender(cfg: Config) {
  attender = new AgentAttender(cfg);
  attender.setOnNotify((message) => void vscode.window.showInformationMessage(message));
  attender.setOnFocus((conv) => revealConversation(conv, true));
}

export function activate(context: vscode.ExtensionContext) {
  const cfg = getCfg();
  client = new HerdrClient(cfg.session);
  resolver = new AgentResolver(client);
  wireAttender(cfg);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  statusBarItem.name = 'Herdr';
  statusBarItem.command = 'herdr.attend';
  statusBarItem.text = '$(terminal) Herdr';
  statusBarItem.tooltip = 'Herdr agent switcher';
  statusBarItem.show();

  tree = new HerdrTreeProvider(folderStates);
  context.subscriptions.push(vscode.window.registerTreeDataProvider('herdr.agents', tree));

  context.subscriptions.push(
    statusBarItem,
    vscode.window.onDidCloseTerminal((term) => {
      if (term === herdrTerminal) herdrTerminal = undefined;
    }),
    vscode.window.onDidChangeActiveTextEditor(() => render()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refreshState()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('herdr.session')) {
        unsubscribeEvents?.();
        unsubscribeEvents = undefined;
        herdrTerminal?.dispose();
        herdrTerminal = undefined;
        const next = getCfg();
        client = new HerdrClient(next.session);
        resolver = new AgentResolver(client);
        wireAttender(next);
        snapshot = undefined;
        convByTab.clear();
        currentActiveTabId = undefined;
        subscribeEvents();
        void refreshState();
      }
      if (e.affectsConfiguration('herdr')) {
        attender.updateConfig(getCfg());
        render();
      }
    }),
    { dispose: () => unsubscribeEvents?.() }
  );

  const command = (id: string, handler: (...args: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  command('herdr.openMasterTerminal', () => {
    try {
      ensureHerdrTerminal().show(false);
    } catch (e) {
      showError(`could not open the terminal: ${errorMessage(e)}`);
    }
  });
  command('herdr.focusWorkspace', (folder?: unknown) => focusWorkspace(folder));
  command('herdr.newShellTab', (folder?: unknown) => newShellTab(folder));
  command('herdr.newConversation', (folder?: unknown) => newConversation(folder));
  command('herdr.switchConversation', () => pickConversation('Switch'));
  command('herdr.attend', () => attend());
  command('herdr.switchNext', () => switchNext());
  command('herdr.switchPrev', () => switchPrev());
  command('herdr.openConversation', (arg?: unknown) => openConversation(arg));
  command('herdr.closeConversation', (arg?: unknown) => {
    if (arg === undefined) return pickConversation('Close');
    const conv = conversationFrom(arg);
    if (conv) return closeTab(conv);
  });
  command('herdr.renameConversation', (arg?: unknown) => renameConversation(arg));
  command('herdr.sendSelection', () => sendSelection());
  command('herdr.refresh', () => refreshState());
  command('herdr.diagnose', () => diagnose());

  subscribeEvents();
  if (cfg.autoStart) {
    void client.ensureServerRunning().then((running) => {
      if (!running) {
        setOffline(`No herdr socket at ${client.getSocketPath()}. Is herdr installed?`);
        return;
      }
      return refreshState();
    });
  }
  void refreshState();
}

export function deactivate() {
  unsubscribeEvents?.();
  unsubscribeEvents = undefined;
  statusBarItem?.dispose();
}
