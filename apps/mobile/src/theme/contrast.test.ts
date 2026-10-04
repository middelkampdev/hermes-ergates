import { CONTRAST_PAIRS, contrastRatio, rate } from './contrast'
import { resolvePalette } from './resolve'

describe('contrastRatio', () => {
  it('black on white is 21', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5)
  })

  it('equal colors are 1', () => {
    expect(contrastRatio('#4a84fe', '#4a84fe')).toBe(1)
  })

  it('Nous dark primary button', () => {
    expect(contrastRatio('#161616', '#4a84fe')).toBeCloseTo(5.19, 2)
  })

  it('rates an unparseable pair as null', () => {
    expect(contrastRatio('color-mix(in srgb, red, blue)', '#fff')).toBeNull()
    expect(contrastRatio('#fff', '')).toBeNull()
  })

  it('accepts short and alpha hex', () => {
    expect(contrastRatio('#000', '#ffffffff')).toBeCloseTo(21, 5)
  })
})

describe('rate', () => {
  it('rates by WCAG thresholds', () => {
    expect(rate(7)).toBe('AAA')
    expect(rate(6.99)).toBe('AA')
    expect(rate(4.5)).toBe('AA')
    expect(rate(3)).toBe('AA large')
    expect(rate(2.99)).toBe('Fail')
  })
})

describe('CONTRAST_PAIRS', () => {
  it('pairs name real colors', () => {
    const { colors } = resolvePalette({ themeName: 'nous', appearance: 'light', systemDark: false })

    for (const { fg, bg } of CONTRAST_PAIRS) {
      expect(colors).toHaveProperty(fg)
      expect(colors).toHaveProperty(bg)
    }
  })
})
