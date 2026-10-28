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
import { PaneStream } from './paneStream';
import { TabStrip, StripAction, StripState, orderTabs, moveTab } from './strip';

interface Config {
  focusOnBlocked: boolean;
  session: string;
  autoStart: boolean;
  defaultHarness: HarnessKind;
}

let client: HerdrClient;
let resolver: AgentResolver;
let attender: AgentAttender;
let strip: TabStrip;
/** The active tab's pane, streamed into the view's terminal. */
let stream: PaneStream | undefined;
let streamPane: string | undefined;
let termSize: { cols: number; rows: number } | undefined;
let store: vscode.Memento;
/** Tab ids in the order the user dragged them in the strip; herdr has no move-tab call. */
let tabOrder: string[] = [];
const TAB_ORDER_KEY = 'herdr.tabOrder';
let statusBarItem: vscode.StatusBarItem;
let unsubscribeEvents: (() => void) | undefined;

let snapshot: Snapshot | undefined;
let convByTab = new Map<string, Conversation>();
let currentActiveTabId: string | undefined;
let connectionError: string | undefined;
let subscribedPaneKey: string | undefined;

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
    autoStart: conf.get('autoStart', true),
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

/** A folder passed by another command, else the active editor's. */
function folderFrom(arg?: unknown): string {
  return typeof arg === 'string' ? arg : currentFolder();
}

/** The cwd of a workspace's first pane; used for references and new tabs. */
function folderForWorkspace(workspaceId: string): string | undefined {
  const pane = snapshot?.panes.find(
    (p) => p.workspace_id === workspaceId && (p.cwd || p.foreground_cwd)
  );
  return pane?.cwd || pane?.foreground_cwd;
}

function folderForConversation(conv: Conversation): string | undefined {
  const pane = snapshot?.panes.find((p) => p.pane_id === conv.pane_id);
  return pane?.cwd || pane?.foreground_cwd || folderForWorkspace(conv.workspace_id);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function showError(message: string) {
  void vscode.window.showErrorMessage(`Herdr: ${message}`);
}

async function showOffline() {
  const pick = await vscode.window.showErrorMessage(
    `Herdr is not running for session "${getCfg().session || 'default'}". Make sure the herdr command is installed and on PATH in this environment.`,
    'Open Herdr Terminal'
  );
  if (pick) {
    try {
      strip.reveal(false);
    } catch (e) {
      showError(`could not open the terminal: ${errorMessage(e)}`);
    }
  }
}

function statusTooltip(convs: Conversation[]): string {
  if (convs.length === 0) return 'No agent conversations in this session. Click to start one.';
  const lines = convs.map((c) => `${c.label}: ${c.status}`);
  return `${lines.join('\n')}\n\nClick to switch agent conversation.`;
}

function updateStatusBar(convs: Conversation[]) {
  if (!statusBarItem) return;
  statusBarItem.backgroundColor = undefined;

  if (connectionError) {
    statusBarItem.text = '$(circle-slash) Herdr (offline)';
    statusBarItem.tooltip = `${connectionError}\n\nMake sure herdr is installed and on PATH.`;
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
  strip?.refresh();
}

/** This folder's herdr workspace, in the strip's order. */
function stripTabs(): Conversation[] {
  if (!snapshot) return [];
  return orderTabs(resolver.buildConversations(snapshot, currentFolder()), tabOrder);
}

function stripState(): StripState {
  return {
    tabs: stripTabs().map(({ tab_id, agent, status, label }) => ({ tab_id, agent, status, label })),
    activeId: currentActiveTabId,
    offline: connectionError
  };
}

function allConversations(): Conversation[] {
  if (!snapshot) return [];
  return (snapshot.workspaces || []).flatMap((w) =>
    resolver.conversationsForWorkspace(snapshot!, w.workspace_id)
  );
}

function stopStream() {
  stream?.dispose();
  stream = undefined;
  streamPane = undefined;
}

/** Point the view's terminal at the active tab's pane. */
function syncStream() {
  const pane = currentActiveTabId ? convByTab.get(currentActiveTabId)?.pane_id : undefined;
  if (pane === streamPane || !termSize) return;
  stream?.dispose();
  stream = undefined;
  streamPane = pane;
  strip.reset();
  if (pane) {
    const s: PaneStream = new PaneStream(getCfg().session, pane, termSize.cols, termSize.rows,
      (bytes) => strip.write(bytes), (reason) => {
        strip.closed(reason);
        s.dispose();
        // Forget the dead stream so the next snapshot or tab click reattaches. Another client
        // took the pane over (e.g. a stale extension host after a reload): stay detached
        // instead of taking it back, or the two hosts fight over it forever.
        if (stream === s) {
          stream = undefined;
          if (!/taken over/i.test(reason)) streamPane = undefined;
        }
      });
    stream = s;
  }
}

/** Re-render from the last snapshot (cheap; no IPC). */
function render() {
  if (!snapshot) {
    updateStatusBar([]);
    strip?.refresh();
    return;
  }
  const convs = allConversations();
  convByTab = new Map(convs.map((c) => [c.tab_id, c]));
  if (snapshot.focused_tab_id && convByTab.has(snapshot.focused_tab_id)) {
    currentActiveTabId = snapshot.focused_tab_id;
  }
  attender.setConversations(convs);
  updateStatusBar(convs);
  strip?.refresh();
  syncStream();
}

function applySnapshot(snap: Snapshot) {
  snapshot = snap;
  connectionError = undefined;
  syncSubscription();
  render();
  for (const c of convByTab.values()) attender.handleStatusChange(c.pane_id, c.status);
}

async function fetchSnapshot(): Promise<void> {
  if (!client.isAvailable()) {
    setOffline(
      `No herdr socket at ${client.getSocketPath()}. Is herdr installed and on PATH?`
    );
    return;
  }
  const from = client;
  try {
    const snap = await from.snapshot();
    // A `herdr.session` change meanwhile: this snapshot belongs to the old session.
    if (from === client) applySnapshot(snap);
  } catch (e) {
    if (from === client) setOffline(`Could not read herdr state: ${errorMessage(e)}`);
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

function revealConversation(conv: Conversation, preserveFocus = false) {
  currentActiveTabId = conv.tab_id;
  strip?.refresh();
  syncStream();
  strip.reveal(preserveFocus);
  client.focusWorkspace(conv.workspace_id).catch(() => {
    // Best effort: the terminal still shows the current herdr tab.
  });
  client.focusTab(conv.tab_id).catch(() => {
    // Best effort.
  });
}

function conversationFrom(arg?: unknown): Conversation | undefined {
  if (typeof arg === 'string') return convByTab.get(arg);
  // Right-click on a strip tab: the webview context carries the tab id.
  if (arg && typeof arg === 'object' && typeof (arg as { tabId?: unknown }).tabId === 'string') {
    return convByTab.get((arg as { tabId: string }).tabId);
  }
  if (arg && typeof arg === 'object' && 'tab_id' in arg) return arg as Conversation;
  return currentActiveTabId ? convByTab.get(currentActiveTabId) : undefined;
}

function isLightTheme(): boolean {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
}

/**
 * Mirrors VS Code's light/dark into OpenCode by locking its theme mode in its state file. OpenCode learns
 * light/dark only from the terminal's answer to a colour query, and herdr's server-rendered frames never
 * carry that exchange, so without a lock it falls back to dark. Opt-in (HERDR_SYNC_OPENCODE_THEME=1, set
 * by PodarcisNest containers) because it overrides the user's own OpenCode theme setting. A running
 * OpenCode keeps the mode it started with; the next one picks up the new lock.
 */
function syncOpencodeTheme(): void {
  if (process.env.HERDR_SYNC_OPENCODE_THEME !== '1') return;
  const file = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'opencode', 'kv.json');
  try {
    const kv = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    const mode = isLightTheme() ? 'light' : 'dark';
    if (kv.theme_mode_lock === mode) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Rename into place so a concurrently starting OpenCode never reads a half-written file.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...kv, theme_mode_lock: mode }));
    fs.renameSync(tmp, file);
  } catch {
    // Unreadable or read-only: OpenCode keeps its own theme.
  }
}

function tabEnv(): Record<string, string> {
  // TUIs read COLORFGBG before their first render; OSC 11 detection is too late.
  return {
    COLORFGBG: isLightTheme() ? '0;15' : '15;0',
    // Route agents' `code --goto` requests back to this VS Code window.
    ...(process.env.VSCODE_IPC_HOOK_CLI
      ? { VSCODE_IPC_HOOK_CLI: process.env.VSCODE_IPC_HOOK_CLI }
      : {})
  };
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

/** A new tab in the folder's workspace. A workspace made for it brings a first tab: use that one. */
async function openTab(folder: string, label: string | null) {
  const { workspaceId, root } = await resolver.ensureWorkspace(folder, await client.snapshot(), tabEnv());
  if (root) {
    if (label) await client.renameTab(root.tab_id, label);
    return { workspaceId, tabId: root.tab_id, paneId: root.pane_id };
  }
  const created = await client.createTab(workspaceId, label, false, tabEnv());
  return { workspaceId, tabId: created.tab?.tab_id, paneId: created.root_pane?.pane_id };
}

async function newConversation(arg?: unknown) {
  const folder = folderFrom(arg);
  if (!client.isAvailable()) {
    void showOffline();
    return;
  }
  const kind = await pickHarness();
  if (!kind) return;

  let createdTab: string | undefined;
  try {
    const { workspaceId, tabId, paneId } = await openTab(folder, null);
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
    // The agent runs: a failing focus call below must not close it.
    createdTab = undefined;

    currentActiveTabId = tabId;
    strip.reveal(false);
    await client.focusWorkspace(workspaceId);
    await client.focusTab(tabId);
    await refreshState();
  } catch (e) {
    if (createdTab) await client.closeTab(createdTab).catch(() => {});
    showError(`could not start ${HARNESS_LABELS[kind]}: ${errorMessage(e)}`);
  }
}

async function newShellTab(arg?: unknown) {
  const folder = folderFrom(arg);
  if (!client.isAvailable()) {
    void showOffline();
    return;
  }
  try {
    const { workspaceId, tabId } = await openTab(folder, 'shell');
    if (tabId) currentActiveTabId = tabId;
    strip.reveal(false);
    await client.focusWorkspace(workspaceId);
    if (tabId) await client.focusTab(tabId);
    await refreshState();
  } catch (e) {
    showError(`could not create a shell tab: ${errorMessage(e)}`);
  }
}

async function focusWorkspace(arg?: unknown) {
  const folder = folderFrom(arg);
  if (!client.isAvailable()) {
    void showOffline();
    return;
  }
  try {
    const { workspaceId } = await resolver.ensureWorkspace(folder, await client.snapshot(), tabEnv());
    await client.focusWorkspace(workspaceId);
    strip.reveal(false);
    await refreshState();
  } catch (e) {
    showError(`could not focus the workspace: ${errorMessage(e)}`);
  }
}

async function closeTab(conv: Conversation) {
  // Delete and middle-click close in one keystroke; an agent's conversation is not cheap to lose.
  if (conv.agent) {
    const ok = await vscode.window.showWarningMessage(
      `Close ${conv.label}? The ${conv.agent} agent in it stops.`,
      { modal: true },
      'Close'
    );
    if (ok !== 'Close') return;
  }
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

async function sendSelection(arg?: unknown) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    showError('open a file first.');
    return;
  }
  const conv = conversationFrom(arg);
  if (!conv) {
    showError('no active conversation. Open one from the Herdr view first.');
    return;
  }
  if (!conv.agent) {
    showError('the active tab is a shell, not an agent. Open an agent tab first.');
    return;
  }
  const owner =
    folderForConversation(conv) ?? folderForActiveEditor() ?? currentFolder();
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
    await client.sendText(conv.pane_id, payload);
    revealConversation(conv);
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
      { placeHolder: 'No agent conversations in this session' }
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

/** The strip's tabs, else every tab (a folder with no herdr workspace yet). */
function navigableTabs(): Conversation[] {
  const own = stripTabs();
  return own.length ? own : [...convByTab.values()];
}

function switchNext() {
  const convs = navigableTabs();
  if (convs.length === 0) return;
  const curr = convs.findIndex((c) => c.tab_id === currentActiveTabId);
  revealConversation(convs[(curr + 1) % convs.length]);
}

function switchPrev() {
  const convs = navigableTabs();
  if (convs.length === 0) return;
  // No active tab: wrap to the last one.
  const curr = Math.max(0, convs.findIndex((c) => c.tab_id === currentActiveTabId));
  revealConversation(convs[(curr - 1 + convs.length) % convs.length]);
}

async function onStripAction(action: StripAction) {
  if (action.cmd === 'new') return newShellTab();
  if (action.cmd === 'input') return stream?.input(String(action.data));
  if (action.cmd === 'scroll') return stream?.scroll(action.direction === 'up' ? 'up' : 'down', Number(action.lines) || 3);
  if (action.cmd === 'resize') {
    termSize = { cols: Math.max(10, Number(action.cols) || 80), rows: Math.max(5, Number(action.rows) || 24) };
    if (stream) stream.resize(termSize.cols, termSize.rows);
    else syncStream();
    return;
  }
  if (typeof action.id !== 'string') return;
  const conv = convByTab.get(action.id);
  if (!conv) return;
  if (action.cmd === 'open') return revealConversation(conv);
  if (action.cmd === 'close') return closeTab(conv);
  if (action.cmd === 'rename') {
    const label = typeof action.label === 'string' ? action.label.trim() : '';
    if (!label) return;
    try {
      await client.renameTab(conv.tab_id, label);
      await refreshState();
    } catch (e) {
      showError(`could not rename the tab: ${errorMessage(e)}`);
    }
    return;
  }
  if (action.cmd === 'reorder') {
    const moved = moveTab(stripTabs().map((c) => c.tab_id), action.id, action.target, !!action.before);
    // Keep other folders' order; forget tabs herdr no longer has.
    tabOrder = [...moved, ...tabOrder.filter((id) => !moved.includes(id) && convByTab.has(id))];
    void store.update(TAB_ORDER_KEY, tabOrder);
    strip.refresh();
  }
}

/** Status-bar click: start the session if needed, else straight to a blocked agent. */
function attend() {
  if (!client.isAvailable()) {
    strip.reveal(false);
    return;
  }
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

function subscribeEvents(paneIds: string[]) {
  unsubscribeEvents?.();
  unsubscribeEvents = client.subscribeEvents(
    paneIds,
    () => void refreshState(),
    (up) => {
      if (up) void refreshState();
      else setOffline('Herdr event stream disconnected. Is herdr still running?');
    }
  );
}

/** Re-subscribe only when the pane set changes: status events are per pane. */
function syncSubscription() {
  const ids = [...new Set((snapshot?.panes ?? []).map((p) => p.pane_id))].sort();
  const key = ids.join('\n');
  if (key === subscribedPaneKey) return;
  subscribedPaneKey = key;
  subscribeEvents(ids);
}

/** Subscribe and read state for the current client, starting its server first when asked. */
function connect(cfg: Config) {
  syncSubscription();
  if (cfg.autoStart) {
    const from = client;
    void client.ensureServerRunning().then((running) => {
      if (from !== client) return;
      if (!running) {
        setOffline(`No herdr socket at ${client.getSocketPath()}. Is herdr installed?`);
        return;
      }
      return refreshState();
    });
  }
  void refreshState();
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

  store = context.workspaceState;
  tabOrder = store.get<string[]>(TAB_ORDER_KEY, []);
  // A reloaded or closed view: drop the stream until the view reports its size again.
  strip = new TabStrip(context.extensionUri, stripState, (action) => void onStripAction(action), () => {
    stopStream();
    termSize = undefined;
  });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(TabStrip.viewType, strip, {
    webviewOptions: { retainContextWhenHidden: true }
  }));

  syncOpencodeTheme();
  context.subscriptions.push(
    statusBarItem,
    vscode.window.onDidChangeActiveColorTheme(() => syncOpencodeTheme()),
    vscode.window.onDidChangeActiveTextEditor(() => render()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refreshState()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('herdr.session')) {
        unsubscribeEvents?.();
        unsubscribeEvents = undefined;
        stopStream();
        const next = getCfg();
        client = new HerdrClient(next.session);
        resolver = new AgentResolver(client);
        wireAttender(next);
        snapshot = undefined;
        convByTab.clear();
        currentActiveTabId = undefined;
        subscribedPaneKey = undefined;
        connect(next);
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

  command('herdr.openMasterTerminal', () => strip.reveal(false));
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
  command('herdr.sendSelection', (arg?: unknown) => sendSelection(arg));
  command('herdr.installAgentSkill', async () => {
    const folder = vscode.workspace.workspaceFolders?.length === 1
      ? vscode.workspace.workspaceFolders[0]
      : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Install the VS Code file-opening skill in this folder' });
    if (!folder) return;
    try {
      const directory = path.join(folder.uri.fsPath, '.agents', 'skills', 'herdr-open-vscode');
      await fs.promises.mkdir(directory, { recursive: true });
      // Exclusive creation preserves any skill the user has already customized.
      await fs.promises.copyFile(
        context.asAbsolutePath('skills/herdr-open-vscode/SKILL.md'),
        path.join(directory, 'SKILL.md'),
        fs.constants.COPYFILE_EXCL
      ).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
      const claudeSkills = path.join(folder.uri.fsPath, '.claude', 'skills');
      await fs.promises.mkdir(claudeSkills, { recursive: true });
      await fs.promises.symlink('../../.agents/skills/herdr-open-vscode', path.join(claudeSkills, 'herdr-open-vscode'))
        .catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
      void vscode.window.showInformationMessage('Herdr: VS Code file-opening skill installed. Restart existing agents to discover it.');
    } catch (e) {
      showError(`could not install the agent skill: ${errorMessage(e)}`);
    }
  });
  command('herdr.refresh', () => refreshState());
  command('herdr.diagnose', () => diagnose());

  connect(cfg);
}

export function deactivate() {
  stopStream();
  unsubscribeEvents?.();
  unsubscribeEvents = undefined;
  statusBarItem?.dispose();
}
