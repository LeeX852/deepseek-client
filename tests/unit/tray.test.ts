import { describe, expect, it, vi, type Mock } from 'vitest';
import { buildMenuActions, buildTooltip, createTray, type TrayState } from '../../src/main/tray';

// R23：图标缺失兜底（new Tray(createEmpty())）是规格关键分支——托盘是唯一唤起入口。
// 此前只被一次性 esbuild 探针覆盖过，无法复跑；这里用 vi.mock('electron') 把它钉成
// 常驻单测。纯函数用例不依赖 mock，同名导入不受影响。
type FakeTrayInstance = {
  image: unknown;
  setToolTip: Mock<(text: string) => void>;
  setContextMenu: Mock<(menu: { items: unknown[] }) => void>;
  on: Mock<(event: string, cb: () => void) => void>;
  destroy: Mock<() => void>;
};

const mocks = vi.hoisted(() => {
  const state = {
    iconEmpty: true,
    instances: [] as FakeTrayInstance[],
    icon: { isEmpty: () => state.iconEmpty },
    empty: { isEmpty: () => false },
  };
  return state;
});

vi.mock('electron', () => {
  class FakeTray {
    readonly image: unknown;
    readonly setToolTip = vi.fn();
    readonly setContextMenu = vi.fn();
    readonly on = vi.fn();
    readonly destroy = vi.fn();
    constructor(image: unknown) {
      this.image = image;
      mocks.instances.push(this);
    }
  }
  return {
    app: { getAppPath: () => 'C:\\fake\\app' },
    nativeImage: {
      createFromPath: () => mocks.icon,
      createEmpty: () => mocks.empty,
    },
    Menu: { buildFromTemplate: (template: unknown[]) => ({ items: template }) },
    Tray: FakeTray,
  };
});

describe('buildTooltip', () => {
  it('空闲态', () => {
    expect(buildTooltip({ unread: 0, degraded: false })).toBe('DeepSeek');
  });

  it('有未读时带上条数', () => {
    expect(buildTooltip({ unread: 3, degraded: false })).toBe('DeepSeek · 3 条新回复');
  });

  it('降级态必须可见地告知增强功能失效，而不是静默失灵', () => {
    expect(buildTooltip({ unread: 0, degraded: true })).toBe('DeepSeek · 页面已改版，增强功能暂停');
  });

  it('未读上限截断到 99+', () => {
    expect(buildTooltip({ unread: 140, degraded: false })).toBe('DeepSeek · 99+ 条新回复');
  });
});

describe('buildMenuActions', () => {
  it('三个动作且顺序固定', () => {
    expect(buildMenuActions().map(a => a.id)).toEqual(['show', 'settings', 'quit']);
  });

  it('退出项明确区别于关窗', () => {
    expect(buildMenuActions().find(a => a.id === 'quit')?.label).toContain('退出');
    expect(buildMenuActions().find(a => a.id === 'quit')?.label).toContain('进程');
  });
});

describe('createTray（vi.mock electron，覆盖图标缺失兜底）', () => {
  const deps = () => ({
    onToggle: vi.fn(),
    onShow: vi.fn(),
    onSettings: vi.fn(),
    onQuit: vi.fn(),
  });

  it('图标文件缺失（createFromPath 的 image.isEmpty()）时 Tray 仍被创建，且用 createEmpty() 兜底', () => {
    mocks.iconEmpty = true;
    mocks.instances.length = 0;
    const handle = createTray(deps());

    expect(mocks.instances).toHaveLength(1);
    const tray = mocks.instances[0]!;
    expect(tray.image).toBe(mocks.empty); // 传进去的是 createEmpty() 的结果，不是空探测图标
    expect(tray.setToolTip).toHaveBeenCalledWith('DeepSeek');
    const menu = tray.setContextMenu.mock.calls[0]?.[0];
    expect(menu?.items).toHaveLength(3);
    expect(tray.on).toHaveBeenCalledWith('click', expect.any(Function));
    handle.destroy();
  });

  it('set() 更新 tooltip；destroy() 释放底层 Tray（R22 的契约面）', () => {
    mocks.iconEmpty = true;
    mocks.instances.length = 0;
    const handle = createTray(deps());
    const tray = mocks.instances[0]!;

    const states: TrayState[] = [
      { unread: 3, degraded: false },
      { unread: 0, degraded: true },
    ];
    for (const s of states) handle.set(s);
    expect(tray.setToolTip).toHaveBeenLastCalledWith('DeepSeek · 页面已改版，增强功能暂停');

    handle.destroy();
    expect(tray.destroy).toHaveBeenCalledTimes(1);
  });

  it('图标存在时不使用兜底空图像', () => {
    mocks.iconEmpty = false;
    mocks.instances.length = 0;
    const handle = createTray(deps());

    expect(mocks.instances[0]!.image).toBe(mocks.icon);
    handle.destroy();
  });
});
