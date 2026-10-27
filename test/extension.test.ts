import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const state = vi.hoisted(() => ({
  view: undefined as any,
  commands: new Map<string, (...args: any[]) => any>(),
  roots: [{ uri: { fsPath: '/work/project', scheme: 'file', authority: '' } }],
  remoteName: undefined as string | undefined,
  error: vi.fn(),
  client: {
    session: 'vscode',
    isAvailable: () => true,
    subscribeEvents: () => () => {},
    snapshot: async () => ({
      workspaces: [{ workspace_id: 'w', label: 'project' }],
      tabs: [{ tab_id: 't', workspace_id: 'w' }],
      panes: [{ pane_id: 'p', tab_id: 't', workspace_id: 'w', cwd: '/work/project' }],
      agents: [],
      focused_tab_id: 't'
    }),
    sendText: vi.fn().mockResolvedValue(undefined),
    focusTab: vi.fn().mockResolvedValue(undefined),
    focusWorkspace: vi.fn().mockResolvedValue(undefined)
  }
}));

vi.mock('vscode', () => ({
  TreeItem: class {},
  ThemeIcon: class {},
  ThemeColor: class {},
  EventEmitter: class { event = () => {}; fire() {} },
  TreeItemCollapsibleState: { Expanded: 2, None: 0 },
  StatusBarAlignment: { Left: 1 },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrastLight: 4 },
  Uri: { parse: (value: string) => {
    const uri = new URL(value);
    return { scheme: uri.protocol.slice(0, -1), authority: uri.host,
      fsPath: decodeURIComponent(uri.pathname), fragment: uri.hash.slice(1) };
  } },
  env: { get remoteName() { return state.remoteName; } },
  workspace: {
    get workspaceFolders() { return state.roots; },
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    onDidChangeWorkspaceFolders: () => ({}),
    onDidChangeConfiguration: () => ({})
  },
  window: {
    activeColorTheme: { kind: 2 },
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
    createTreeView: (_id: string, options: unknown) => { state.view = options; return {}; },
    createTerminal: () => ({ show() {}, sendText() {} }),
    onDidCloseTerminal: () => ({}),
    onDidChangeActiveTextEditor: () => ({}),
    showInformationMessage: vi.fn(),
    showErrorMessage: state.error
  },
  commands: { registerCommand: (id: string, handler: (...args: any[]) => any) => {
    state.commands.set(id, handler);
    return {};
  } }
}));

vi.mock('../src/herdrClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/herdrClient')>(),
  HerdrClient: vi.fn(function () { return state.client; })
}));

let extension: typeof import('../src/extension');
let node: any;
let scratch: string | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  state.roots = [{ uri: { fsPath: '/work/project', scheme: 'file', authority: '' } }];
  state.remoteName = undefined;
  extension = await import('../src/extension');
  const { ConversationNode } = await import('../src/tree');
  node = new ConversationNode({ pane_id: 'p', tab_id: 't', workspace_id: 'w',
    agent: 'claude', status: 'idle', label: 'claude', running: true });
  extension.activate({ subscriptions: [],
    asAbsolutePath: (file: string) => path.resolve(file)
  } as any);
  await vi.waitFor(() => expect(state.view.treeDataProvider.getChildren()).toHaveLength(1));
});

afterEach(async () => {
  extension.deactivate();
  if (scratch) await fs.rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe('conversation drops', () => {
  it('sends multiple decoded file references and a line range directly to the chosen pane', async () => {
    const data = new Map([['text/uri-list', {
      asString: async () => '# files\r\nfile:///work/project/my%20notes.md#L3,2-L5,1\r\nfile:///other/file.ts',
      asFile: () => undefined
    }]]);
    await state.view.dragAndDropController.handleDrop(node, data, { isCancellationRequested: false });
    expect(state.client.sendText).toHaveBeenCalledWith('p', '@"my notes.md#L3-5" @/other/file.ts ');
    expect(state.client.focusTab).toHaveBeenCalledWith('t');
  });

  it('brackets multiline selections without submitting or allowing a nested paste terminator', async () => {
    const data = new Map([['text/plain', {
      asString: async () => 'first\n\x1b[201~second', asFile: () => undefined
    }]]);
    await state.view.dragAndDropController.handleDrop(node, data, { isCancellationRequested: false });
    expect(state.client.sendText).toHaveBeenCalledWith('p', '\x1b[200~first\nsecond\x1b[201~');
  });

  it('accepts file-manager file objects without a URI-list entry', async () => {
    const data = new Map([['application/octet-stream', {
      asFile: () => ({ uri: { scheme: 'file', authority: '', fsPath: '/work/project/a.ts', fragment: '' } })
    }]]);
    await state.view.dragAndDropController.handleDrop(node, data, { isCancellationRequested: false });
    expect(state.client.sendText).toHaveBeenCalledWith('p', '@a.ts ');
  });

  it('does not send a cancelled drop or drop onto a shell', async () => {
    const data = new Map([['text/plain', { asString: async () => 'hello', asFile: () => undefined }]]);
    await state.view.dragAndDropController.handleDrop(node, data, { isCancellationRequested: true });
    node.conv.agent = null;
    await state.view.dragAndDropController.handleDrop(node, data, { isCancellationRequested: false });
    expect(state.client.sendText).not.toHaveBeenCalled();
  });

  it('rejects local file paths in a remote window', async () => {
    state.remoteName = 'ssh-remote';
    state.roots = [{ uri: { fsPath: '/work/project', scheme: 'vscode-remote', authority: 'ssh-remote+host' } }];
    const data = new Map([['text/uri-list', { asString: async () => 'file:///work/project/a.ts' }]]);
    await state.view.dragAndDropController.handleDrop(node, data, { isCancellationRequested: false });
    expect(state.client.sendText).not.toHaveBeenCalled();
    expect(state.error).toHaveBeenCalledWith(expect.stringContaining('machine running the agent'));
  });

  it('accepts files on the connected remote host', async () => {
    state.remoteName = 'ssh-remote';
    state.roots = [{ uri: { fsPath: '/work/project', scheme: 'vscode-remote', authority: 'ssh-remote+host' } }];
    const data = new Map([['text/uri-list', { asString: async () => 'vscode-remote://ssh-remote+host/work/project/a.ts' }]]);
    await state.view.dragAndDropController.handleDrop(node, data, { isCancellationRequested: false });
    expect(state.client.sendText).toHaveBeenCalledWith('p', '@a.ts ');
  });
});

it('installs a discoverable skill and Claude link, preserving customized content on reinstall', async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-vscode-skill-'));
  state.roots = [{ uri: { fsPath: scratch, scheme: 'file', authority: '' } }];
  await state.commands.get('herdr.installAgentSkill')!();
  const skill = path.join(scratch, '.agents/skills/herdr-open-vscode/SKILL.md');
  const link = path.join(scratch, '.claude/skills/herdr-open-vscode/SKILL.md');
  expect(await fs.readFile(link, 'utf8')).toBe(await fs.readFile(skill, 'utf8'));
  await fs.writeFile(skill, 'custom instructions');
  await state.commands.get('herdr.installAgentSkill')!();
  expect(await fs.readFile(link, 'utf8')).toBe('custom instructions');
  expect(state.error).not.toHaveBeenCalled();
});
