import { describe, expect, it } from 'vitest';
function luminance(hex: string) {
  const parts = [1, 3, 5]
    .map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return parts[0] * 0.2126 + parts[1] * 0.7152 + parts[2] * 0.0722;
}
function contrast(a: string, b: string) {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
describe('provisional accessible theme pairs', () => {
  for (const [foreground, background] of [
    ['#0F172A', '#FFFFFF'],
    ['#526078', '#FFFFFF'],
    ['#526078', '#F4F6FA'],
    ['#FFFFFF', '#1D4ED8'],
    ['#F8FAFC', '#172338'],
    ['#AFBDD1', '#172338'],
    ['#0F172A', '#93C5FD'],
    ['#166534', '#FFFFFF'],
    ['#854D0E', '#FFFFFF'],
    ['#B91C1C', '#FFFFFF'],
  ])
    it(`${foreground} on ${background} meets 4.5:1`, () =>
      expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5));
});
