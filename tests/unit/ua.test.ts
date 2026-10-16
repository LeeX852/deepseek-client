import { describe, expect, it } from 'vitest';
import { browserLikeUA } from '../../src/main/ua';

describe('browserLikeUA', () => {
  it('removes the Electron token from a default session UA', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Electron/44.8.0 Chrome/136.0.0.0 Safari/537.36';
    expect(browserLikeUA(ua)).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
    );
  });

  it('removes the app token that Electron appends from package.json name/version', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ds-shell/0.1.0 Chrome/136.0.0.0 Safari/537.36';
    expect(browserLikeUA(ua)).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
    );
  });

  it('leaves an already browser-shaped UA untouched', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
    expect(browserLikeUA(ua)).toBe(ua);
    expect(browserLikeUA(ua)).not.toMatch(/Electron|ds-shell/i);
  });
});
