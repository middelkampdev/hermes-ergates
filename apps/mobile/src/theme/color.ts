export type Rgb = [number, number, number]

/** Accepts `#rgb`, `#rrggbb` and `#rrggbbaa` (with or without the `#`); the alpha byte, if any, is dropped. */
export function parseRgb(hex: string): Rgb | null {
  const clean = hex.trim().replace(/^#/, '')
  const full = clean.length === 3 || clean.length === 4 ? clean.replace(/./g, c => c + c) : clean

  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(full)) {
    return null
  }

  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16)) as Rgb
}

/** True when React Native can paint `value` as-is: a `#` hex color, no surrounding whitespace, that `parseRgb` accepts. */
export function isRenderableHex(value: string): boolean {
  return value.startsWith('#') && value === value.trim() && parseRgb(value) !== null
}
