// 从 resources/icon-master.png（透明、去水印、居中的蓝色肥鱼）降采样出
// 各尺寸图标。降采样用盒式滤波并按 alpha 预乘，避免透明边缘发暗。
// master 是一次性清理脚本的产物（已入库），本脚本只负责缩放，保证可复现。
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const master = PNG.sync.read(readFileSync('resources/icon-master.png'));

function downscale(src, size) {
  const out = new PNG({ width: size, height: size });
  const ratio = src.width / size;
  for (let oy = 0; oy < size; oy++) {
    for (let ox = 0; ox < size; ox++) {
      const x0 = Math.floor(ox * ratio), x1 = Math.max(x0 + 1, Math.ceil((ox + 1) * ratio));
      const y0 = Math.floor(oy * ratio), y1 = Math.max(y0 + 1, Math.ceil((oy + 1) * ratio));
      let sumA = 0, sumR = 0, sumG = 0, sumB = 0, area = 0;
      for (let sy = y0; sy < y1 && sy < src.height; sy++) {
        for (let sx = x0; sx < x1 && sx < src.width; sx++) {
          const i = (src.width * sy + sx) << 2;
          const a = src.data[i + 3] / 255;
          sumA += a; sumR += src.data[i] * a; sumG += src.data[i + 1] * a; sumB += src.data[i + 2] * a;
          area++;
        }
      }
      const o = (size * oy + ox) << 2;
      const a = sumA / area;
      out.data[o + 3] = Math.round(a * 255);
      if (sumA > 0) {
        out.data[o] = Math.round(sumR / sumA);
        out.data[o + 1] = Math.round(sumG / sumA);
        out.data[o + 2] = Math.round(sumB / sumA);
      }
    }
  }
  return out;
}

mkdirSync('resources', { recursive: true });
writeFileSync('resources/icon.png', PNG.sync.write(downscale(master, 256)));   // exe / 窗口图标（electron-builder 要求 >=256）
writeFileSync('resources/icon-32.png', PNG.sync.write(downscale(master, 32))); // 托盘图标
console.log('[icon] resources/icon.png (256) + resources/icon-32.png (32)');
