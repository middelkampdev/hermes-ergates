import { describe, expect, it } from 'vitest'

import { PRIVACY_POLICY_URL, PRIVACY_SUBTITLE } from './privacy'

describe('the Privacy row in Settings', () => {
  it('opens the privacy policy on middelkamp.dev, which both stores ask the app to link to', () => {
    expect(PRIVACY_POLICY_URL).toBe('https://middelkamp.dev/ergates/privacy/')
  })

  it('says where the chats live and leaves what this phone keeps to the policy', () => {
    expect(PRIVACY_SUBTITLE).toBe('Chats live on your server. Read what this phone keeps in the privacy policy.')
  })
})
