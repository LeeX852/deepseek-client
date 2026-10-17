import { describe, expect, it, vi } from 'vitest';
import { performQuickAsk } from '../../src/main/quickAsk';

describe('performQuickAsk', () => {
  it('剪贴板有内容时投递注入', () => {
    const send = vi.fn();
    performQuickAsk({ readClipboardText: () => '  选中的文字\n', sendInject: send, notifyEmpty: () => {} });
    expect(send).toHaveBeenCalledWith('选中的文字');
  });
  it('剪贴板为空时不投递，改为提示', () => {
    const send = vi.fn(); const empty = vi.fn();
    performQuickAsk({ readClipboardText: () => '   ', sendInject: send, notifyEmpty: empty });
    expect(send).not.toHaveBeenCalled(); expect(empty).toHaveBeenCalled();
  });
});
