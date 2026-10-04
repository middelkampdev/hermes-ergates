import { CONTRAST_PAIRS } from '@/theme/contrast'
import { resolvePalette } from '@/theme/resolve'

import { DESIGN_SYSTEM_SECTIONS, sectionById, sectionSummary } from './sections'

const nousLight = resolvePalette({ themeName: 'nous', appearance: 'light', systemDark: false }).colors

describe('design system sections', () => {
  it('lists the foundations, then the components', () => {
    expect(DESIGN_SYSTEM_SECTIONS.map(s => s.id)).toEqual([
      'colors',
      'contrast',
      'type',
      'shape',
      'button',
      'icon-button',
      'field',
      'list-row',
      'group',
      'avatar',
      'row-body',
      'bubble'
    ])
    expect(DESIGN_SYSTEM_SECTIONS.filter(s => s.group === 'foundations').map(s => s.id)).toEqual(['colors', 'contrast', 'type', 'shape'])
  })

  it('finds a section by id and nothing for an unknown id', () => {
    expect(sectionById('list-row')).toMatchObject({ id: 'list-row', title: 'List row', group: 'components' })
    expect(sectionById('nope')).toBeUndefined()
    expect(sectionById(undefined)).toBeUndefined()
  })

  it('counts the colors and the type styles', () => {
    expect(sectionSummary('colors', nousLight)).toBe(`${Object.keys(nousLight).length} tokens`)
    expect(sectionSummary('type', nousLight)).toBe('11 styles')
  })

  it('says when every pair passes AA', () => {
    const allBlack = Object.fromEntries(Object.keys(nousLight).map(k => [k, k.toLowerCase().includes('foreground') ? '#000000' : '#ffffff'])) as unknown as typeof nousLight
    expect(sectionSummary('contrast', allBlack)).toBe(`${CONTRAST_PAIRS.length} pairs · all pass AA`)
  })

  it('counts the pairs below AA, unparseable colors included', () => {
    const colors = { ...nousLight, foreground: '#ffffff', background: '#ffffff', primary: 'color-mix(in srgb, red, blue)' }
    const summary = sectionSummary('contrast', colors)
    expect(summary).toMatch(new RegExp(`^${CONTRAST_PAIRS.length} pairs · \\d+ below AA$`))
    expect(Number(summary?.split('· ')[1]?.split(' ')[0])).toBeGreaterThanOrEqual(2)
  })

  it('describes the shape tokens', () => {
    expect(sectionSummary('shape', nousLight)).toBe('8 space · 7 radius · 8 size')
  })

  it('gives every component a short description', () => {
    for (const section of DESIGN_SYSTEM_SECTIONS.filter(s => s.group === 'components')) {
      expect(sectionSummary(section.id, nousLight)).toBeTruthy()
    }
  })
})
