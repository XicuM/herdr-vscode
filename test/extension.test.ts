import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const state = vi.hoisted(() => ({
  commands: new Map<string, (...args: any[]) => any>(),
  roots: [{ uri: { fsPath: '/work/project', scheme: 'file', authority: '' } }],
  remoteName: undefined as string | undefined,
  error: vi.fn(),
  client: {
    session: 'vscode',
    isAvailable: () => true,
    ensureServerRunning: async () => true,
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
    createTerminal: () => ({ show() {}, sendText() {} }),
    registerWebviewViewProvider: () => ({}),
    onDidChangeActiveTerminal: () => ({}),
    onDidCloseTerminal: () => ({}),
    onDidChangeActiveTextEditor: () => ({}),
    onDidChangeActiveColorTheme: () => ({}),
    showInformationMessage: vi.fn(),
    showErrorMessage: state.error
  },
  commands: { executeCommand: vi.fn(), registerCommand: (id: string, handler: (...args: any[]) => any) => {
    state.commands.set(id, handler);
    return {};
  } }
}));

vi.mock('../src/herdrClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/herdrClient')>(),
  HerdrClient: vi.fn(function () { return state.client; })
}));

let extension: typeof import('../src/extension');
let scratch: string | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  state.roots = [{ uri: { fsPath: '/work/project', scheme: 'file', authority: '' } }];
  state.remoteName = undefined;
  extension = await import('../src/extension');
  extension.activate({ subscriptions: [], extensionUri: {},
    workspaceState: { get: (_key: string, fallback: unknown) => fallback, update: vi.fn() },
    asAbsolutePath: (file: string) => path.resolve(file)
  } as any);
});

afterEach(async () => {
  extension.deactivate();
  if (scratch) await fs.rm(scratch, { recursive: true, force: true });
  scratch = undefined;
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

it('locks OpenCode to the VS Code theme only when asked, keeping its other state', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-vscode-kv-'));
  const kv = path.join(stateDir, 'opencode', 'kv.json');
  const ctx = { subscriptions: [], extensionUri: {},
    workspaceState: { get: (_key: string, fallback: unknown) => fallback, update: vi.fn() },
    asAbsolutePath: (file: string) => path.resolve(file)
  } as any;
  vi.stubEnv('XDG_STATE_HOME', stateDir);
  extension.activate(ctx);
  await expect(fs.access(kv)).rejects.toThrow();

  await fs.mkdir(path.dirname(kv), { recursive: true });
  await fs.writeFile(kv, JSON.stringify({ theme: 'system' }));
  vi.stubEnv('HERDR_SYNC_OPENCODE_THEME', '1');
  extension.activate(ctx);
  // The mocked VS Code theme is dark (kind 2).
  expect(JSON.parse(await fs.readFile(kv, 'utf8'))).toEqual({ theme: 'system', theme_mode_lock: 'dark' });
  vi.unstubAllEnvs();
  await fs.rm(stateDir, { recursive: true, force: true });
});
