import { describe, expect, it } from 'vitest'

import type { ProfileSummary, ProfilesListResult } from '@/gateway/types'
import profilesList from '@test/fixtures/profiles-list.json'

import { nameOfRoster, summaryOfRoster, toBot, type Bot } from './roster'

const recorded = (profilesList as ProfilesListResult).profiles

function withMeta(meta: Record<string, unknown> | undefined, revision?: number): ProfileSummary {
  return { name: 'mia', is_default: false, ...(meta ? { ui_meta: { 'hermes-bots': meta } } : {}), ...(revision === undefined ? {} : { ui_meta_revisions: { 'hermes-bots': revision } }) }
}

describe('reading pins and sections from Hermes metadata', () => {
  it('reads pinned and the metadata revision from a recorded roster', () => {
    expect(recorded.map(toBot).map(bot => [bot.profile, bot.pinned, bot.revision])).toEqual([
      ['default', true, 7],
      ['kevin', false, 2],
      ['thijs', false, 1]
    ])
  })

  it('reads the section id and name, and a null or empty section as No section', () => {
    expect(toBot(withMeta({ sectionId: 'sec-1', sectionName: ' Clients ' }, 4))).toMatchObject({ sectionId: 'sec-1', sectionName: 'Clients', revision: 4 })
    expect(toBot(withMeta({ sectionId: null, sectionName: null }))).toMatchObject({ sectionId: null, sectionName: null })
    expect(toBot(withMeta({ sectionId: '', sectionName: 7 }))).toMatchObject({ sectionId: null, sectionName: null })
  })

  it('tells a missing value apart from a set one, so the first sync writes only where Hermes has none', () => {
    const bot = toBot(withMeta(undefined))
    expect(bot.pinned).toBeUndefined()
    expect(bot.sectionId).toBeUndefined()
    expect(bot.sectionName).toBeUndefined()
    expect(bot.revision).toBe(0)
    expect(toBot(withMeta({ pinned: 'yes' })).pinned).toBeUndefined()
  })

  it('reads a section id the way Desktop does: a number becomes its string form, a spaced string is kept untrimmed, and empty is No section', () => {
    expect(toBot(withMeta({ sectionId: 42 })).sectionId).toBe('42')
    expect(toBot(withMeta({ sectionId: '  sec 1  ' })).sectionId).toBe('  sec 1  ')
    expect(toBot(withMeta({ sectionId: '' })).sectionId).toBeNull()
  })
})

describe('looking an agent up in a roster', () => {
  const bots: Bot[] = [
    { profile: 'linh', name: 'Linh', role: '', description: '', hidden: false, hasAvatar: false, isDefault: false, lastActivityAt: 0, preview: '', canonicalSessionId: null, summary: { name: 'linh', is_default: false } }
  ]

  it('finds the agent current summary and name, and falls back when the roster does not have it', () => {
    expect(summaryOfRoster(bots, 'linh')).toBe(bots[0].summary)
    expect(summaryOfRoster(bots, 'ghost')).toBeUndefined()
    expect(summaryOfRoster(undefined, 'linh')).toBeUndefined()
    expect(nameOfRoster(bots, 'linh')).toBe('Linh')
    expect(nameOfRoster(bots, 'ghost')).toBe('ghost')
    expect(nameOfRoster(undefined, 'linh')).toBe('linh')
  })
})

describe('the Home row preview', () => {
  const withPreview = (preview: string): ProfileSummary => ({ name: 'mia', is_default: false, canonical_session: { id: 's1', title: 'Chat', preview } })

  it('shows plain text, as Desktop does (stripPreviewMarkdown in hermes-bots/labels.ts)', () => {
    expect(toBot(withPreview('**Day 1: Canals & Culture** - Morning: _Canal_ cruise')).preview).toBe('Day 1: Canals & Culture - Morning: Canal cruise')
    expect(toBot(withPreview('## Plan\n> Note: see [the map](https://example.com) and `route`')).preview).toBe('Plan Note: see the map and route')
    expect(toBot(withPreview('Code:\n```\nls -la\n```\ndone ~~not~~')).preview).toBe('Code: done not')
  })

  it('keeps snake_case words and lone stars', () => {
    expect(toBot(withPreview('use snake_case_name and 2 * 3')).preview).toBe('use snake_case_name and 2 * 3')
  })
})
