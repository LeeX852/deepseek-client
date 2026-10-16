import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';

rmSync('out', { recursive: true, force: true });
mkdirSync('out/renderer', { recursive: true });

// 主进程打成 ESM：package.json 里 "type": "module" 会让 Electron 把
// out/main/index.js 当 ES 模块加载，CJS 产物在这种入口下会直接
// 抛 "require is not defined in ES module scope"。
// preload 仍必须是 CJS：沙箱预加载脚本由 Electron 自己包装执行，不看 type 字段。
await build({
  entryPoints: ['src/main/index.ts'],
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  external: ['electron'], outfile: 'out/main/index.js', sourcemap: true,
});

await build({
  entryPoints: ['src/preload/deepseek.ts'],
  bundle: true, platform: 'browser', format: 'cjs', target: 'es2022',
  outfile: 'out/preload/deepseek.js', sourcemap: true,
});

if (existsSync('src/renderer')) cpSync('src/renderer', 'out/renderer', { recursive: true });
cpSync('resources', 'out/resources', { recursive: true });
console.log('[build] ok');
