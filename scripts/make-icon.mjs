import { PNG } from 'pngjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const S = 32;
const png = new PNG({ width: S, height: S });
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (S * y + x) << 2;
    const inside = Math.hypot(x - S / 2 + 0.5, y - S / 2 + 0.5) <= S / 2 - 2;
    png.data[i] = 0x4d; png.data[i + 1] = 0x6b; png.data[i + 2] = 0xfe;
    png.data[i + 3] = inside ? 0xff : 0x00;
  }
}
mkdirSync('resources', { recursive: true });
writeFileSync('resources/icon.png', PNG.sync.write(png));
console.log('[icon] resources/icon.png');
