import type { AgentStatus } from './herdrClient';
import type { Conversation } from './resolver';

/**
 * Herdr already plays its own notification sounds for background agents. This
 * only brings a conversation into view when it *transitions* into blocked.
 */
export class AgentAttender {
  private last = new Map<string, AgentStatus>();
  private convByPane = new Map<string, Conversation>();
  private onFocus?: (conv: Conversation) => void;
  private onNotify?: (message: string) => void;

  constructor(private cfg: { focusOnBlocked: boolean }) {}

  updateConfig(cfg: { focusOnBlocked: boolean }) {
    this.cfg = cfg;
  }

  setOnFocus(fn: (conv: Conversation) => void) {
    this.onFocus = fn;
  }

  setOnNotify(fn: (message: string) => void) {
    this.onNotify = fn;
  }

  setConversations(convs: Conversation[]) {
    this.convByPane.clear();
    for (const c of convs) this.convByPane.set(c.pane_id, c);
  }

  handleStatusChange(paneId: string, status: AgentStatus) {
    const prev = this.last.get(paneId);
    // First sighting: record the baseline. Already-blocked agents at startup
    // must not steal focus or notify.
    if (prev === undefined) {
      this.last.set(paneId, status);
      return;
    }
    if (prev === status) return;
    this.last.set(paneId, status);

    // Only a transition into blocked.
    if (status === 'blocked' && prev !== 'blocked' && this.cfg.focusOnBlocked) {
      this.focusConversation(paneId);
    }
  }

  private focusConversation(paneId: string) {
    const conv = this.convByPane.get(paneId);
    if (!conv) return;
    this.onFocus?.(conv);
    this.onNotify?.(`Herdr: ${conv.label} is blocked and waiting for your input`);
  }
}
