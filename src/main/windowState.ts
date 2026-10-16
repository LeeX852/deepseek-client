import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type Bounds = { x: number; y: number; width: number; height: number; maximized: boolean };

type DisplayLike = { workArea: { x: number; y: number; width: number; height: number } };

const MIN_WIDTH = 480;
const MIN_HEIGHT = 360;
const TITLEBAR_GRACE = 80;

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function sanitizeBounds(raw: unknown, displays: DisplayLike[]): Bounds | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isInt(r.x) || !isInt(r.y) || !isInt(r.width) || !isInt(r.height)) return null;
  if (r.width < MIN_WIDTH || r.height < MIN_HEIGHT) return null;
  const b: Bounds = { x: r.x, y: r.y, width: r.width, height: r.height, maximized: r.maximized === true };

  const probeRight = b.x + Math.min(TITLEBAR_GRACE, b.width);
  // 标题栏命中区 [b.x, b.x+grace] 必须与某屏工作区横向相交：
  // probeRight >= workArea.x 挡住窗口整体偏左，
  // b.x <= workArea.x + width - 1 挡住窗口整体偏右（brief 原稿缺了这条，
  // 导致 x=4000 这类屏幕外坐标在单屏下被放行）。
  const onScreen = displays.some(d =>
    b.y >= d.workArea.y && b.y <= d.workArea.y + d.workArea.height - 1 &&
    b.x >= d.workArea.x - b.width + TITLEBAR_GRACE && probeRight >= d.workArea.x &&
    b.x <= d.workArea.x + d.workArea.width - 1);
  return onScreen ? b : null;
}

export function createWindowStateStore(dir: string) {
  const file = path.join(dir, 'window.json');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  return {
    load(): Bounds | null {
      if (!existsSync(file)) return null;
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (typeof parsed !== 'object' || parsed === null) return null;
        const r = parsed as Record<string, unknown>;
        if (!isInt(r.x) || !isInt(r.y) || !isInt(r.width) || !isInt(r.height)) return null;
        if (r.width < MIN_WIDTH || r.height < MIN_HEIGHT) return null;
        return { x: r.x, y: r.y, width: r.width, height: r.height, maximized: r.maximized === true };
      } catch {
        renameSync(file, file + '.corrupt');
        return null;
      }
    },
    save(b: Bounds): void {
      const tmp = file + '.tmp';
      writeFileSync(tmp, JSON.stringify(b));
      renameSync(tmp, file);
    },
  };
}
