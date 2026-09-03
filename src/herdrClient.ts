import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export const HARNESS_KINDS = [
  'opencode',
  'claude',
  'codex',
  'copilot',
  'gemini',
  'agy',
  'grok',
  'kimi',
  'kiro',
  'qwen',
  'cursor',
  'devin',
  'maki',
  'pi',
  'amp'
] as const;
export type HarnessKind = (typeof HARNESS_KINDS)[number];

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
  agent_status?: string;
  pane_count?: number;
  tab_count?: number;
}

export interface Tab {
  tab_id: string;
  workspace_id: string;
  label?: string;
  agent_status?: string;
  pane_count?: number;
}

export interface Snapshot {
  agents: Agent[];
  panes: any[];
  tabs: Tab[];
  workspaces: Workspace[];
  focused_workspace_id?: string;
  focused_tab_id?: string;
  version?: string;
}

export class HerdrClient {
  private socketPath: string;
  public readonly session: string;

  constructor(session = 'vscode') {
    this.session = session;
    // Match Herdr's socket resolution: default config dir, or named session subdir.
    const base = path.join(os.homedir(), '.config', 'herdr');
    const sockPath = session
      ? path.join(base, 'sessions', session, 'herdr.sock')
      : path.join(base, 'herdr.sock');
    this.socketPath = process.env.HERDR_SOCKET_PATH || sockPath;
  }

  getSocketPath(): string {
    if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
    return this.socketPath;
  }

  isAvailable(): boolean {
    try {
      return fs.existsSync(this.getSocketPath()) && fs.existsSync('/usr/bin/herdr');
    } catch {
      return false;
    }
  }

  async ensureServerRunning(): Promise<boolean> {
    if (this.isAvailable()) return true;
    const sockPath = this.getSocketPath();
    if (fs.existsSync(sockPath)) return true;

    if (this.session) {
      const sessionDir = path.join(os.homedir(), '.config', 'herdr', 'sessions', this.session);
      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
      }
      const configPath = path.join(sessionDir, 'config.toml');
      const env = {
        ...process.env,
        ...(fs.existsSync(configPath) ? { HERDR_CONFIG_PATH: configPath } : {})
      };
      const child = spawn('herdr', ['--session', this.session, 'server'], {
        detached: true,
        stdio: 'ignore',
        env
      });
      child.unref();

      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (fs.existsSync(sockPath)) return true;
      }
    }
    return this.isAvailable();
  }

  private async rawRequest(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const sockPath = this.getSocketPath();
    if (!fs.existsSync(sockPath)) {
      await this.ensureServerRunning();
    }
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(sockPath)) {
        return reject(new Error(`Herdr socket not found: ${sockPath}. Is the Herdr server running?`));
      }
      const socket = net.createConnection(sockPath);
      const id = `vscode:${Math.random().toString(36).slice(2)}`;
      let buf = '';
      let settled = false;

      const done = (err: Error | null, data?: any) => {
        if (settled) return;
        settled = true;
        socket.end();
        if (err) reject(err);
        else resolve(data);
      };

      socket.setTimeout(15000);
      socket.on('timeout', () => done(new Error(`Herdr socket request timed out: ${method}`)));
      socket.on('error', (e) => done(e));
      socket.on('data', (d) => {
        buf += d.toString('utf8');
        // NDJSON: look for a line matching our id.
        const lines = buf.split('\n');
        const full = buf;
        if (full.includes(`"${id}"`)) {
          try {
            const last = lines
              .filter((l) => l.includes(`"${id}"`))
              .pop();
            const parsed = JSON.parse(last!);
            done(null, parsed);
          } catch {
            /* keep buffering until a full line appears */
          }
        }
      });

      const req = JSON.stringify({ id, method, params });
      socket.write(req + '\n');
    });
  }

  private async call(method: string, params: Record<string, unknown> = {}, errorMsg?: string): Promise<any> {
    const resp = await this.rawRequest(method, params);
    if (resp.error) {
      throw new Error(errorMsg || `${method} failed: ${resp.error.message || JSON.stringify(resp.error)}`);
    }
    return resp.result;
  }

  async ping(): Promise<boolean> {
    try {
      const r = await this.call('ping', {});
      return r?.type === 'pong';
    } catch {
      return false;
    }
  }

  async snapshot(): Promise<Snapshot> {
    const r = await this.call('session.snapshot', {});
    return r.snapshot as Snapshot;
  }

  async listWorkspaces(): Promise<Workspace[]> {
    const r = await this.call('workspace.list', {});
    return r.workspaces as Workspace[];
  }

  async createWorkspace(cwd: string, label: string, focus = false): Promise<{ workspace: Workspace }> {
    const r = await this.call('workspace.create', { cwd, label, focus });
    return r;
  }

  async listTabs(workspaceId: string): Promise<Tab[]> {
    const r = await this.call('tab.list', { workspace_id: workspaceId });
    return r.tabs as Tab[];
  }

  async listPanes(workspaceId?: string): Promise<any[]> {
    const r = await this.call('pane.list', { workspace_id: workspaceId || null });
    return r.panes as any[];
  }

  async createTab(workspaceId: string, label?: string | null, focus = false): Promise<{ tab: Tab; root_pane: any }> {
    const r = await this.call('tab.create', { workspace_id: workspaceId, label, focus });
    return r;
  }

  async focusTab(tabId: string): Promise<void> {
    await this.call('tab.focus', { tab_id: tabId });
  }

  async focusWorkspace(workspaceId: string): Promise<void> {
    await this.call('workspace.focus', { workspace_id: workspaceId });
  }

  async listAgents(): Promise<Agent[]> {
    const r = await this.call('agent.list', {});
    return r.agents as Agent[];
  }

  async getAgent(target: string): Promise<any> {
    const r = await this.call('agent.get', { target });
    return r;
  }

  async closeTab(tabId: string): Promise<void> {
    try {
      await this.call('tab.close', { tab_id: tabId });
    } catch {
      // best effort
    }
  }

  async renameTab(tabId: string, label: string): Promise<any> {
    try {
      return await this.call('tab.rename', { tab_id: tabId, label });
    } catch {
      // best effort
    }
  }

  async focusPane(paneId: string): Promise<any> {
    try {
      return await this.call('pane.focus', { pane_id: paneId });
    } catch {
      // best effort
    }
  }

  async agentStart(
    name: string,
    kind: string,
    paneId: string,
    args: string[] = [],
    timeoutMs = 60000
  ): Promise<any> {
    const start = Date.now();
    const maxWaitMs = 15000;
    while (true) {
      try {
        return await this.rawRequestWithTimeout(
          'agent.start',
          { name, kind, pane_id: paneId, timeout_ms: timeoutMs, ...(args.length ? { args } : {}) },
          timeoutMs + 10000
        );
      } catch (err: any) {
        const msg = String(err?.message || err || '');
        if (msg.includes('is not an available shell') && Date.now() - start < maxWaitMs) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        throw err;
      }
    }
  }

  private async rawRequestWithTimeout(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<any> {
    const sockPath = this.getSocketPath();
    if (!fs.existsSync(sockPath)) {
      await this.ensureServerRunning();
    }
    const resp = await new Promise<any>((resolve, reject) => {
      if (!fs.existsSync(sockPath)) {
        return reject(new Error(`Herdr socket not found: ${sockPath}. Is the Herdr server running?`));
      }
      const socket = net.createConnection(sockPath);
      const id = `vscode:${Math.random().toString(36).slice(2)}`;
      let buf = '';
      let settled = false;
      const done = (err: Error | null, data?: any) => {
        if (settled) return;
        settled = true;
        socket.end();
        if (err) reject(err);
        else resolve(data);
      };
      socket.setTimeout(timeoutMs);
      socket.on('timeout', () => done(new Error(`Herdr socket request timed out: ${method}`)));
      socket.on('error', (e) => done(e));
      socket.on('data', (d) => {
        buf += d.toString('utf8');
        const lines = buf.split('\n');
        const full = buf;
        if (full.includes(`"${id}"`)) {
          try {
            const last = lines.filter((l) => l.includes(`"${id}"`)).pop();
            done(null, JSON.parse(last!));
          } catch {
            /* keep buffering */
          }
        }
      });
      socket.write(JSON.stringify({ id, method, params }) + '\n');
    });
    if (resp.error) {
      throw new Error(resp.error.message || `${method} failed`);
    }
    return resp.result;
  }

  async subscribeEvents(cb: (evt: any) => void): Promise<() => void> {
    const sockPath = this.getSocketPath();
    if (!fs.existsSync(sockPath)) {
      await this.ensureServerRunning();
    }
    if (!fs.existsSync(sockPath)) {
      throw new Error(`Herdr socket not found: ${sockPath}`);
    }
    const socket = net.createConnection(sockPath);
    const id = `vscode-sub:${Math.random().toString(36).slice(2)}`;
    let buf = '';
    let acknowledged = false;

    const req = JSON.stringify({
      id,
      method: 'events.subscribe',
      params: {
        subscriptions: [
          { type: 'pane.agent_status_changed' },
          { type: 'pane.created' },
          { type: 'pane.closed' },
          { type: 'pane.agent_detected' },
          { type: 'tab.created' },
          { type: 'tab.closed' },
          { type: 'workspace.created' },
          { type: 'workspace.closed' }
        ]
      }
    });

    return new Promise<() => void>((resolve, reject) => {
      socket.on('error', (e) => reject(e));
      socket.on('data', (d) => {
        buf += d.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.id && parsed.id === id) {
              acknowledged = true;
              resolve(() => {
                try {
                  socket.end();
                } catch {}
              });
              continue;
            }
            if (parsed.event || parsed.type) {
              try {
                cb(parsed);
              } catch {}
            }
          } catch {
            /* partial line */
          }
        }
      });
      socket.write(req + '\n');
      setTimeout(() => {
        if (!acknowledged) {
          reject(new Error('Herdr event subscription not acknowledged'));
        }
      }, 15000);
    });
  }
}

// ---- Subprocess helpers for one-shot CLI actions not covered by raw methods ----

export function runHerdr(args: string[], cwd?: string, session = 'vscode'): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const sessionArgs = session ? ['--session', session, ...args] : args;
    const sessionDir = session ? path.join(os.homedir(), '.config', 'herdr', 'sessions', session) : '';
    const configPath = sessionDir ? path.join(sessionDir, 'config.toml') : '';
    const env = {
      ...process.env,
      HERDR_ENV: '1',
      ...(configPath && fs.existsSync(configPath) ? { HERDR_CONFIG_PATH: configPath } : {})
    };
    const child = spawn('herdr', sessionArgs, {
      cwd: cwd || process.cwd(),
      env
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}
