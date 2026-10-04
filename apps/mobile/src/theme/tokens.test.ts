import { AVATAR, ICON, LEADING, OPACITY, RADIUS, SCRIM, SIZE, TYPE, TYPE_ROLES } from './tokens'

describe('role tokens', () => {
  it('pins the type scale from docs/10', () => {
    expect(TYPE.largeTitle).toEqual({ fontSize: 28, fontWeight: '600' })
    expect(TYPE.title).toEqual({ fontSize: 22, fontWeight: '600' })
    expect(TYPE.title3).toEqual({ fontSize: 20, fontWeight: '600' })
    expect(TYPE.headline).toEqual({ fontSize: 17, fontWeight: '600' })
    expect(TYPE.bodyStrong).toEqual({ fontSize: 17, fontWeight: '500' })
    expect(TYPE.body).toEqual({ fontSize: 17, fontWeight: '400' })
    expect(TYPE.calloutStrong).toEqual({ fontSize: 15, fontWeight: '600' })
    expect(TYPE.callout).toEqual({ fontSize: 15, fontWeight: '400' })
    expect(TYPE.footnote).toEqual({ fontSize: 13, fontWeight: '400' })
    expect(TYPE.footnoteStrong).toEqual({ fontSize: 13, fontWeight: '600' })
    expect(TYPE.caption).toEqual({ fontSize: 12, fontWeight: '400' })
  })
  it('keeps line height out of the type roles', () => {
    for (const role of TYPE_ROLES) expect(Object.keys(TYPE[role]).sort()).toEqual(['fontSize', 'fontWeight'])
  })
  it('lists every type role once', () => {
    expect([...TYPE_ROLES].sort()).toEqual(Object.keys(TYPE).sort())
  })
  it('pins leading, radius, size, icon and opacity', () => {
    expect(LEADING).toEqual({ body: 24, callout: 22, footnote: 18 })
    expect(RADIUS).toEqual({ bubble: 22, composer: 24, group: 20, sheet: 28, button: 16, field: 14, chip: 14, small: 12, badge: 6 })
    expect(SIZE).toEqual({ hit: 44, row: 56, button: 50, field: 50, fieldMultiline: 128 })
    expect(ICON).toEqual({ row: 22, chevron: 17, small: 18 })
    expect(OPACITY).toEqual({ pressed: 0.65, disabled: 0.45 })
    expect(SCRIM).toBe('rgba(0,0,0,0.25)')
    expect(AVATAR.list).toBe(48)
  })
})
