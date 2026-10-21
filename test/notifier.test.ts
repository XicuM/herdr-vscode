import { describe, expect, it, vi } from 'vitest';
import { AgentAttender } from '../src/notifier';
import type { Conversation } from '../src/resolver';

const conv: Conversation = {
  tab_id: 'w:t1',
  workspace_id: 'w',
  pane_id: 'w:p1',
  agent: 'claude',
  status: 'blocked',
  label: 'claude',
  running: true
};

describe('AgentAttender', () => {
  it('records the first sighting without notifying, even when blocked', () => {
    const attender = new AgentAttender({ focusOnBlocked: true });
    const focus = vi.fn();
    const notify = vi.fn();
    attender.setOnFocus(focus);
    attender.setOnNotify(notify);
    attender.setConversations([conv]);

    attender.handleStatusChange('w:p1', 'blocked');

    expect(focus).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('focuses and notifies once on a transition into blocked', () => {
    const attender = new AgentAttender({ focusOnBlocked: true });
    const focus = vi.fn();
    const notify = vi.fn();
    attender.setOnFocus(focus);
    attender.setOnNotify(notify);
    attender.setConversations([conv]);

    attender.handleStatusChange('w:p1', 'working');
    attender.handleStatusChange('w:p1', 'blocked');
    attender.handleStatusChange('w:p1', 'blocked');

    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledWith(conv);
    expect(notify).toHaveBeenCalledWith('Herdr: claude is blocked and waiting for your input');
  });

  it('ignores transitions into other states', () => {
    const attender = new AgentAttender({ focusOnBlocked: true });
    const focus = vi.fn();
    attender.setOnFocus(focus);
    attender.setConversations([conv]);

    attender.handleStatusChange('w:p1', 'blocked');
    attender.handleStatusChange('w:p1', 'working');
    attender.handleStatusChange('w:p1', 'done');

    expect(focus).not.toHaveBeenCalled();
  });

  it('does not focus when focusOnBlocked is off', () => {
    const attender = new AgentAttender({ focusOnBlocked: false });
    const focus = vi.fn();
    attender.setOnFocus(focus);
    attender.setConversations([conv]);

    attender.handleStatusChange('w:p1', 'working');
    attender.handleStatusChange('w:p1', 'blocked');

    expect(focus).not.toHaveBeenCalled();
  });
});
