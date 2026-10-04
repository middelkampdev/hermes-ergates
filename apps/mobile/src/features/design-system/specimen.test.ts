import { resolvePalette } from '@/theme/resolve'
import { CONTRAST_PAIRS } from '@/theme/contrast'

import { colorSwatches, contrastRows, typeRows } from './specimen'

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
})
