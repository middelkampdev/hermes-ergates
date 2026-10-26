import { describe, expect, it } from 'vitest'

import { PROMPT_METHODS } from '@/gateway/types'

import { canSend, promptStateLabel, promptValue, promptView } from './prompt-view'

describe('promptView', () => {
  it('gives every prompt method a title, a send and a decline label, and at least one field', () => {
    for (const method of PROMPT_METHODS) {
      const view = promptView(method, {})
      expect(view.title.length, method).toBeGreaterThan(0)
      expect(view.body.length, method).toBeGreaterThan(0)
      expect(view.entries.length, method).toBeGreaterThan(0)
      expect(view.send, method).not.toBe(view.decline)
    }
  })

  it('shows the sudo command to check, and says so when Hermes left it out', () => {
    expect(promptView('sudo', { command: 'apt install ripgrep' })).toMatchObject({ command: 'apt install ripgrep', entries: [{ masked: true, autofill: 'off' }] })
    const without = promptView('sudo', {})
    expect(without.command).toBeNull()
    expect(without.body[0]).toContain('did not say for which command')
  })

  it('names the secret by its variable, and offers no autofill for it', () => {
    expect(promptView('secret', { envVar: 'GITHUB_TOKEN', prompt: 'For the GitHub skill' })).toMatchObject({
      title: 'GITHUB_TOKEN',
      body: ['For the GitHub skill'],
      entries: [{ key: 'value', masked: true, autofill: 'off' }]
    })
  })

  it('names the password manager and the site, with fallbacks when Hermes left them out', () => {
    expect(promptView('vault.unlock_prompt', { manager: 'Bitwarden' }).title).toBe('Unlock Bitwarden')
    expect(promptView('vault.unlock_prompt', {}).title).toBe('Unlock your password manager')
    expect(promptView('vault.save_login', { origin: 'https://example.com/login' }).title).toBe('Save your example.com login?')
    expect(promptView('vault.save_login', { origin: 'not a url' }).title).toBe('Save your not a url login?')
    expect(promptView('vault.save_login', {}).title).toBe('Save this login?')
    expect(promptView('vault.save_login', { site: 'Example', origin: 'https://example.com/login' }).body[0]).toContain('at https://example.com/login')
    expect(promptView('vault.code', { site: 'Example', hint: 'From your authenticator app' })).toMatchObject({ title: 'Code for Example', body: [expect.stringContaining('Example asks'), 'From your authenticator app'] })
    expect(promptView('vault.code', {}).title).toBe('Verification code')
  })
})

describe('canSend and promptValue', () => {
  it('needs every field, and sends a value as typed', () => {
    const sudo = promptView('sudo', {})
    expect(canSend(sudo, {})).toBe(false)
    expect(canSend(sudo, { value: ' pass ' })).toBe(true)
    expect(promptValue('sudo', { value: ' pass ' })).toBe(' pass ')
  })

  it('sends a login as the JSON Hermes reads, and only once both fields have text', () => {
    const login = promptView('vault.save_login', { site: 'Example' })
    expect(canSend(login, { identifier: 'me@example.com' })).toBe(false)
    expect(canSend(login, { identifier: 'me@example.com', password: 'pw' })).toBe(true)
    expect(JSON.parse(promptValue('vault.save_login', { identifier: 'me@example.com', password: 'p"w' }))).toEqual({ identifier: 'me@example.com', password: 'p"w' })
  })
})

describe('promptStateLabel', () => {
  const card = (method: (typeof PROMPT_METHODS)[number], state: 'pending' | 'sent' | 'declined' | 'expired') =>
    ({ kind: 'prompt', id: 'p', requestId: 'srq-000000000001', method, fields: {}, state }) as const

  it('says how a card ended, with the decline in the words of its button', () => {
    expect(promptStateLabel(card('sudo', 'pending'))).toBeNull()
    expect(promptStateLabel(card('sudo', 'sent'))).toBe('Sent')
    expect(promptStateLabel(card('sudo', 'declined'))).toBe('Cancelled')
    expect(promptStateLabel(card('vault.unlock_prompt', 'declined'))).toBe('Kept locked')
    expect(promptStateLabel(card('vault.save_login', 'declined'))).toBe('Not saved')
    expect(promptStateLabel(card('vault.code', 'declined'))).toBe('Skipped')
    expect(promptStateLabel(card('secret', 'expired'))).toBe('Expired')
  })
})
