import {
  AVATAR,
  ICON,
  ICON_SIZE,
  LEADING,
  LEGACY_OPACITY,
  LEGACY_RADIUS,
  LEGACY_SIZE,
  OPACITY,
  RADIUS,
  RULE,
  SCRIM,
  SIZE,
  SPACE,
  TYPE,
  TYPE_ROLES
} from './tokens'

/** The whole words of a camelCase key, lower-cased. */
function words(key: string): string[] {
  return key.split(/(?=[A-Z])/).map(word => word.toLowerCase())
}

const COMPONENT_WORDS = new Set([
  'bubble',
  'composer',
  'group',
  'sheet',
  'button',
  'field',
  'chip',
  'badge',
  'row',
  'chat',
  'header',
  'avatar',
  'list',
  'menu',
  'chevron'
])

function componentWords(key: string): string[] {
  return words(key).filter(word => COMPONENT_WORDS.has(word))
}

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
  it('pins leading and the scrim', () => {
    expect(LEADING).toEqual({ body: 24, callout: 22, footnote: 18 })
    expect(SCRIM).toBe('rgba(0,0,0,0.25)')
  })
})

describe('step scales', () => {
  it('pins the space steps', () => {
    expect(SPACE).toEqual({ hairline: 2, extraSmall: 4, small: 8, medium: 12, large: 16, extraLarge: 20, huge: 24, giant: 32 })
  })
  it('pins the radius steps', () => {
    expect(RADIUS).toEqual({ small: 8, medium: 12, large: 16, extraLarge: 20, huge: 24, giant: 28, full: 9999 })
  })
  it('pins the icon size steps', () => {
    expect(ICON_SIZE).toEqual({ small: 16, medium: 20, large: 24 })
  })
  it('pins the size steps', () => {
    expect(SIZE).toEqual({ tiny: 8, extraSmall: 20, small: 28, medium: 40, large: 48, extraLarge: 56, huge: 64, giant: 88 })
  })
  it('pins the opacity steps', () => {
    expect(OPACITY).toEqual({ strong: 0.65, medium: 0.45, faint: 0.25 })
  })
  it('pins the named rules', () => {
    expect(RULE).toEqual({ touch: 44, narrowScreen: 360, maxFontScale: 1.4, panelWidth: 240, textAreaMinHeight: 128 })
  })
  it('lists each scale from small to large', () => {
    for (const scale of [SPACE, RADIUS, ICON_SIZE, SIZE]) {
      const values = Object.values(scale)
      expect(values).toEqual([...values].sort((a, b) => a - b))
    }
    expect(Object.values(OPACITY)).toEqual([...Object.values(OPACITY)].sort((a, b) => b - a))
  })
  it('names no key after a component', () => {
    for (const scale of [SPACE, RADIUS, ICON_SIZE, SIZE, OPACITY, RULE]) {
      for (const key of Object.keys(scale)) expect(componentWords(key), key).toEqual([])
    }
  })
  it('compares whole words, so narrowScreen is not a row', () => {
    expect(componentWords('narrowScreen')).toEqual([])
    expect(componentWords('chatHeader')).toEqual(['chat', 'header'])
    expect(componentWords('chevron')).toEqual(['chevron'])
    expect(componentWords('fieldMultiline')).toEqual(['field'])
  })
})

describe('legacy tokens', () => {
  it('keeps the component-named values until each component points to a step', () => {
    expect(LEGACY_RADIUS).toEqual({ bubble: 22, composer: 24, group: 20, sheet: 28, button: 16, field: 14, chip: 14, small: 12, badge: 6 })
    expect(LEGACY_SIZE).toEqual({ hit: 44, row: 56, button: 50, field: 50, fieldMultiline: 128 })
    expect(LEGACY_OPACITY).toEqual({ pressed: 0.65, disabled: 0.45 })
    expect(ICON).toEqual({ row: 22, chevron: 17, small: 18 })
    expect(AVATAR.list).toBe(48)
  })
})
