import { resolvePalette } from '@/theme/resolve'
import { CONTRAST_PAIRS } from '@/theme/contrast'
import { RULE } from '@/theme/tokens'

import { colorSwatches, contrastRows, shapeRows, typeRows } from './specimen'

const nousLight = resolvePalette({ themeName: 'nous', appearance: 'light', systemDark: false }).colors
const nousDark = resolvePalette({ themeName: 'nous', appearance: 'dark', systemDark: false }).colors

describe('specimen data', () => {
  it('lists every theme color once', () => {
    expect(colorSwatches(nousLight).map(s => s.key)).toEqual(Object.keys(nousLight).sort())
  })

  it('rates each pair', () => {
    const rows = contrastRows(nousDark)
    const row = rows.find(r => r.fg === 'primaryForeground' && r.bg === 'primary')

    expect(rows).toHaveLength(CONTRAST_PAIRS.length)
    expect(row?.ratio).toBeGreaterThanOrEqual(4.5)
    expect(['AA', 'AAA']).toContain(row?.rating)
  })

  it('rates an unparseable pair as null', () => {
    const raw = 'color-mix(in srgb, red, blue)'
    const row = contrastRows({ ...nousLight, primary: raw }).find(r => r.bg === 'primary')

    expect(row).toMatchObject({ ratio: null, rating: null, bgValue: raw })
  })

  it('lists the type scale in order', () => {
    expect(typeRows()[0]).toEqual({ role: 'largeTitle', fontSize: 28, fontWeight: '600', label: '28 / 600' })
    expect(typeRows()).toHaveLength(11)
  })

  it('lists every step of each scale in declaration order', () => {
    const shapes = shapeRows()

    expect(shapes.space).toHaveLength(8)
    expect(shapes.space[0]).toEqual(['hairline', 2])
    expect(shapes.radius).toHaveLength(7)
    expect(shapes.radius.at(-1)).toEqual(['full', 9999])
    expect(shapes.size).toHaveLength(8)
    expect(shapes.size[0]).toEqual(['tiny', 8])
    expect(shapes.iconSize).toEqual([
      ['small', 16],
      ['medium', 20],
      ['large', 24]
    ])
    expect(shapes.opacity).toEqual([
      ['strong', 0.65],
      ['medium', 0.45],
      ['faint', 0.25]
    ])
    expect(shapes.rules).toEqual(Object.entries(RULE))
    expect(Object.keys(shapes).sort()).toEqual(['iconSize', 'opacity', 'radius', 'rules', 'size', 'space'])
  })
})
