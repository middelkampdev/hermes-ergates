import { describe, expect, it } from 'vitest'

import { bleed, pagePadding } from './page-padding'

describe('pagePadding', () => {
  it('is 20 on an ordinary phone', () => {
    expect(pagePadding(390)).toBe(20)
    expect(pagePadding(360)).toBe(20)
    expect(pagePadding(430)).toBe(20)
  })

  it('is 16 on a phone narrower than 360 points', () => {
    expect(pagePadding(359)).toBe(16)
    expect(pagePadding(320)).toBe(16)
  })
})

describe('bleed', () => {
  it('cancels the page padding on both sides, so a list spans the screen width', () => {
    expect(bleed(20)).toEqual({ marginHorizontal: -20 })
    expect(bleed(16)).toEqual({ marginHorizontal: -16 })
  })
})
