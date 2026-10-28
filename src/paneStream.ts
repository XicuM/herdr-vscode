import { spawn, ChildProcess } from 'child_process';

/** One pane's terminal, from `herdr terminal session control`: JSON lines in, server-rendered ANSI frames out. */
export class PaneStream {
  private child: ChildProcess;
  private closed = false;

  constructor(
    session: string,
    readonly paneId: string,
    cols: number,
    rows: number,
    private onData: (bytes: string) => void,
    private onClose: (reason: string) => void
  ) {
    // VS Code launched from a herdr pane inherits its session variables; the TUI must use ours.
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('HERDR_')) delete env[key];
    }
    const args = [
      ...(session ? ['--session', session] : []),
      'terminal', 'session', 'control', paneId,
      '--takeover', '--cols', String(cols), '--rows', String(rows)
    ];
    this.child = spawn('herdr', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });

    let buffer = '';
    this.child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try {
          const frame = JSON.parse(line) as { type?: string; reason?: string; bytes?: string };
          if (frame.type === 'terminal.closed') this.finish(frame.reason || 'terminal closed');
          else if (frame.bytes) this.onData(frame.bytes);
        } catch {
          // Not a frame.
        }
      }
    });
    let stderr = '';
    this.child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    this.child.stdin!.on('error', () => {});
    this.child.on('error', (e) => this.finish(`could not run herdr: ${e.message}`));
    this.child.on('close', () => this.finish(stderr.trim() || 'terminal closed'));
  }

  private send(cmd: object) {
    if (!this.closed) this.child.stdin!.write(`${JSON.stringify(cmd)}\n`);
  }

  input(data: string) {
    this.send({ type: 'terminal.input', bytes: Buffer.from(data, 'utf8').toString('base64') });
  }

  resize(cols: number, rows: number) {
    this.send({ type: 'terminal.resize', cols, rows });
  }

  scroll(direction: 'up' | 'down', lines: number) {
    this.send({ type: 'terminal.scroll', direction, lines });
  }

  /** Hand the pane's size back to the herdr layout and stop. */
  dispose() {
    if (!this.closed) this.send({ type: 'terminal.release' });
    this.closed = true;
    // `terminal.closed` may arrive before herdr exits: stop it either way.
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin!.end();
    const kill = setTimeout(() => this.child.kill(), 2000);
    this.child.on('close', () => clearTimeout(kill));
  }

  private finish(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.onClose(reason);
  }
}
