import { isRenderableHex } from './color'

describe('isRenderableHex', () => {
  it.each([
    ['#fff', true],
    ['#a1b2c3', true],
    ['#a1b2c3ff', true],
    ['ffffff', false],
    [' #fff', false],
    ['color-mix(in srgb, red, blue)', false],
    ['', false]
  ])('%j is %s', (value, expected) => {
    expect(isRenderableHex(value)).toBe(expected)
  })
})
