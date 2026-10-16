export function browserLikeUA(defaultUA: string): string {
  return defaultUA
    .replace(/\s*Electron\/[\d.]+/g, '')
    .replace(/\s*ds-shell\/[\d.]+/g, '')
    .trim();
}
