import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  // @live 用例要真实网络，默认套件排除它（pnpm test:e2e 保持无网可跑）。
  // CLI 的 --grep/--grep-invert 是在 config 之后叠加的、覆盖不掉这里，所以
  // pnpm test:e2e:live 传 `--grep @live`（argv 里带 @live）时在此反向关掉排除。
  grepInvert: process.argv.includes('@live') ? undefined : /@live/,
});
