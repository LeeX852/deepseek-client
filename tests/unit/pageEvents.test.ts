import { describe, expect, it, vi } from 'vitest';
import { buildPageEventHandler } from '../../src/main/pageEvents';

const mkEvent = (senderId: number, payload: unknown) =>
  ({ sender: { id: senderId }, payload } as never);

describe('buildPageEventHandler', () => {
  it('接受合法事件并分发', () => {
    const onEvent = vi.fn();
    const h = buildPageEventHandler({ expectedId: () => 7, onEvent, onDegraded: () => {} });
    h(mkEvent(7, { type: 'auth-state-changed', signedIn: true }));
    expect(onEvent).toHaveBeenCalledWith({ type: 'auth-state-changed', signedIn: true });
  });
  it('拒绝非预期发送方', () => {
    const onEvent = vi.fn();
    const h = buildPageEventHandler({ expectedId: () => 7, onEvent, onDegraded: () => {} });
    h(mkEvent(999, { type: 'auth-state-changed', signedIn: true }));
    expect(onEvent).not.toHaveBeenCalled();
  });
  it('拒绝不合 schema 的负载（超长标题）', () => {
    const onEvent = vi.fn();
    const h = buildPageEventHandler({ expectedId: () => 7, onEvent, onDegraded: () => {} });
    h(mkEvent(7, { type: 'session-list-changed', sessions: [{ id: 'a', title: 'x'.repeat(201) }] }));
    expect(onEvent).not.toHaveBeenCalled();
  });
});
