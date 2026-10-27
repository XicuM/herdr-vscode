import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export const HARNESS_KINDS = [
  'agy',
  'amp',
  'claude',
  'codex',
  'copilot',
  'cursor',
  'devin',
  'gemini',
  'grok',
  'kimi',
  'kiro',
  'maki',
  'opencode',
  'pi',
  'qwen'
] as const;
export type HarnessKind = (typeof HARNESS_KINDS)[number];

export const HARNESS_LABELS: Record<HarnessKind, string> = {
  agy: 'Antigravity',
  amp: 'Amp',
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'GitHub Copilot',
  cursor: 'Cursor',
  devin: 'Devin',
  gemini: 'Gemini CLI',
  grok: 'Grok',
  kimi: 'Kimi',
  kiro: 'Kiro',
  maki: 'Maki',
  opencode: 'OpenCode',
  pi: 'Pi',
  qwen: 'Qwen Code'
};

export interface Agent {
  agent: string;
  agent_status: AgentStatus;
  cwd?: string;
  pane_id: string;
  tab_id?: string;
  workspace_id?: string;
  terminal_id?: string;
  state_change_seq?: number;
  agent_session?: { kind: string; value: string; source: string };
}

export interface Workspace {
  workspace_id: string;
  label: string;
  active_tab_id?: string;
  agent_status?: AgentStatus;
  pane_count?: number;
  tab_count?: number;
}

export interface Tab {
  tab_id: string;
  workspace_id: string;
  number?: number;
  label?: string;
  agent_status?: AgentStatus;
  pane_count?: number;
}

export interface Pane {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  focused?: boolean;
  cwd?: string;
  foreground_cwd?: string;
  agent?: string;
  agent_status?: AgentStatus;
}

export interface Snapshot {
  agents: Agent[];
  panes: Pane[];
  tabs: Tab[];
  workspaces: Workspace[];
  focused_workspace_id?: string;
  focused_tab_id?: string;
  version?: string;
}

/**
 * Global events carry structure but not agent status: herdr rejects
 * `pane.agent_status_changed` without a `pane_id`, so those are subscribed per
 * pane (see `subscribeEvents`). `pane.updated` is deliberately omitted: it
 * fires on terminal title churn (spinners), which would snapshot constantly.
 */
const EVENT_SUBSCRIPTIONS = [
  'workspace.created',
  'workspace.renamed',
  'workspace.moved',
  'workspace.reordered',
  'workspace.closed',
  'workspace.focused',
  'tab.created',
  'tab.closed',
  'tab.renamed',
  'tab.moved',
  'tab.focused',
  'pane.created',
  'pane.closed',
  'pane.moved',
  'pane.focused',
  'pane.exited',
  'pane.agent_detected'
];

export class HerdrClient {
  private socketPath: string;
  public readonly session: string;

  constructor(session = 'vscode') {
    this.session = session;
    // Match Herdr's socket resolution: default config dir (honouring
    // XDG_CONFIG_HOME), or a named session subdir.
    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    const base = path.join(configHome, 'herdr');
    const sockPath = session
      ? path.join(base, 'sessions', session, 'herdr.sock')
      : path.join(base, 'herdr.sock');
    // Do not honour HERDR_SOCKET_PATH: VS Code launched from inside a herdr pane
    // inherits it, which would silently bypass the isolated `herdr.session`.
    this.socketPath = sockPath;
  }

  getSocketPath(): string {
    return this.socketPath;
  }

  /** Cheap synchronous check. A stale socket still fails later, where errors are surfaced. */
  isAvailable(): boolean {
    try {
      return fs.existsSync(this.getSocketPath());
    } catch {
      return false;
    }
  }

  /**
   * Start `herdr server` for this session. Only called when the user opts into
   * auto-start: every request must stay side-effect free.
   */
  async ensureServerRunning(): Promise<boolean> {
    if (this.isAvailable()) return true;
    try {
      const sessionDir = this.session
        ? path.join(
            process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
            'herdr',
            'sessions',
            this.session
          )
        : '';
      if (sessionDir) fs.mkdirSync(sessionDir, { recursive: true });
      const configPath = sessionDir ? path.join(sessionDir, 'config.toml') : '';
      const env: NodeJS.ProcessEnv = { ...process.env };
      // A VS Code launched from inside a herdr pane inherits its socket and pane
      // variables; a spawned server must not reuse the desktop session.
      for (const key of Object.keys(env)) {
        if (key.startsWith('HERDR_')) delete env[key];
      }
      if (configPath && fs.existsSync(configPath)) env.HERDR_CONFIG_PATH = configPath;
      const args = this.session ? ['--session', this.session, 'server'] : ['server'];

      const child = spawn('herdr', args, { detached: true, stdio: 'ignore', env });
      child.on('error', () => {
        // Not installed, or not on PATH: the caller reports the missing socket.
      });
      child.unref();
    } catch {
      return false;
    }

    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (this.isAvailable()) return true;
    }
    return this.isAvailable();
  }

  private rawRequest(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 15000
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const sockPath = this.getSocketPath();
      if (!fs.existsSync(sockPath)) {
        return reject(
          new Error(`Herdr socket not found: ${sockPath}. Start herdr, or enable "herdr.autoStart".`)
        );
      }

      const socket = net.createConnection(sockPath);
      const id = `vscode:${Math.random().toString(36).slice(2)}`;
      let buf = '';
      let settled = false;

      const done = (err: Error | null, data?: any) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (err) reject(err);
        else resolve(data);
      };

      socket.setTimeout(timeoutMs);
      socket.on('timeout', () => done(new Error(`Herdr socket request timed out: ${method}`)));
      socket.on('error', (e) => done(e));
      socket.on('data', (d) => {
        buf += d.toString('utf8');
        let newline: number;
        while ((newline = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, newline).trim();
          buf = buf.slice(newline + 1);
          if (!line) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.id === id) done(null, parsed);
          } catch {
            // Partial or unrelated line: keep reading.
          }
        }
      });

      socket.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  private async call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const resp = await this.rawRequest(method, params);
    if (resp.error) {
      throw new Error(resp.error.message || `${method} failed: ${JSON.stringify(resp.error)}`);
    }
    return resp.result;
  }

  async snapshot(): Promise<Snapshot> {
    const r = await this.call('session.snapshot', {});
    return r.snapshot as Snapshot;
  }

  async createWorkspace(cwd: string, label: string, focus = false): Promise<{ workspace: Workspace }> {
    return await this.call('workspace.create', { cwd, label, focus });
  }

  async createTab(
    workspaceId: string,
    label?: string | null,
    focus = false,
    env?: Record<string, string>
  ): Promise<{ tab: Tab; root_pane: { pane_id: string } }> {
    return await this.call('tab.create', {
      workspace_id: workspaceId,
      label,
      focus,
      ...(env ? { env } : {})
    });
  }

  async closeTab(tabId: string): Promise<void> {
    await this.call('tab.close', { tab_id: tabId });
  }

  async renameTab(tabId: string, label: string): Promise<void> {
    await this.call('tab.rename', { tab_id: tabId, label });
  }

  async focusTab(tabId: string): Promise<void> {
    await this.call('tab.focus', { tab_id: tabId });
  }

  async focusWorkspace(workspaceId: string): Promise<void> {
    await this.call('workspace.focus', { workspace_id: workspaceId });
  }

  async sendText(paneId: string, text: string): Promise<void> {
    await this.call('pane.send_text', { pane_id: paneId, text });
  }

  /** Retries while the new pane's shell is not ready yet ("is not an available shell"). */
  async agentStart(
    name: string,
    kind: string,
    paneId: string,
    args: string[] = [],
    timeoutMs = 60000
  ): Promise<unknown> {
    const start = Date.now();
    for (;;) {
      try {
        const resp = await this.rawRequest(
          'agent.start',
          { name, kind, pane_id: paneId, timeout_ms: timeoutMs, ...(args.length ? { args } : {}) },
          timeoutMs + 10000
        );
        if (resp.error) throw new Error(resp.error.message || 'agent.start failed');
        return resp.result;
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err);
        if (!msg.includes('is not an available shell') || Date.now() - start > 15000) throw err;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  /**
   * Live herdr events over the socket. Global events cover structure; agent
   * status changes are per pane, so pass the current pane ids from a snapshot.
   * Reconnects with backoff and reports connection changes, so the extension can
   * go offline without polling.
   */
  subscribeEvents(
    paneIds: string[],
    cb: (evt: any) => void,
    onConnection?: (up: boolean) => void
  ): () => void {
    let closed = false;
    let socket: net.Socket | undefined;
    let retry: NodeJS.Timeout | undefined;
    let delay = 1000;

    const subscriptions = [
      ...EVENT_SUBSCRIPTIONS.map((type) => ({ type })),
      ...paneIds.map((pane_id) => ({ type: 'pane.agent_status_changed', pane_id }))
    ];

    const schedule = () => {
      if (closed) return;
      retry = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 5000);
    };

    const connect = () => {
      if (closed) return;
      const sockPath = this.getSocketPath();
      if (!fs.existsSync(sockPath)) {
        onConnection?.(false);
        schedule();
        return;
      }

      const s = net.createConnection(sockPath);
      socket = s;
      const id = `vscode-sub:${Math.random().toString(36).slice(2)}`;
      let buf = '';
      let acked = false;

      s.on('connect', () => {
        delay = 1000;
        s.write(
          JSON.stringify({
            id,
            method: 'events.subscribe',
            params: { subscriptions }
          }) + '\n'
        );
      });
      s.on('data', (d) => {
        buf += d.toString('utf8');
        let newline: number;
        while ((newline = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, newline).trim();
          buf = buf.slice(newline + 1);
          if (!line) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.id === id) {
              // Only report "up" once herdr accepts the subscription; an invalid
              // subscription (e.g. a pane that just closed) used to look online.
              if (parsed.error) {
                // Force a snapshot: it brings the current pane ids, and the
                // extension re-subscribes with them.
                cb({ type: '__subscribe_error', error: parsed.error });
              } else if (!acked) {
                acked = true;
                onConnection?.(true);
              }
              continue;
            }
            if (parsed.event || parsed.type) cb(parsed);
          } catch {
            // Partial line.
          }
        }
      });
      s.on('error', () => {
        // 'close' follows and schedules the retry.
      });
      s.on('close', () => {
        if (socket === s) socket = undefined;
        if (closed) return;
        onConnection?.(false);
        schedule();
      });
    };

    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socket?.destroy();
      socket = undefined;
    };
  }
}
