/**
 * Signing in again keeps the saved connection. Sign out is the only other way
 * back from "Sign-in required", and it deletes the connection with its drafts,
 * outbox, agent setups and local organization.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GatewayError } from '@/gateway/errors'
import type { ConnectedGateway } from '@/gateway/port'
import type { GatewayRegistry } from '@/gateway/registry'
import type { Credentials } from '@/gateway/types'
import { draftKey, useDeviceStore, type Connection } from '@/state/device-store'
import type { OutboxItem } from '@/state/outbox'

import { connectionToSignIn, signInAgain } from './connections'

const saved: Connection = { id: 'c-1', label: 'Home server', baseUrl: 'http://100.64.0.1:9119', authMode: 'password', primary: true, createdAt: 1 }
const queued: OutboxItem = { localId: 'o-1', connectionId: 'c-1', profile: 'alice', text: 'ask about the invoice', createdAt: 2, status: 'queued_unsent' }
const creds: Credentials = { mode: 'password', provider: 'basic', username: 'jop', password: 'hunter2' }

/** A registry whose one gateway only knows `login`. */
function registryWith(login: ConnectedGateway['login']) {
  const gateway = { login } as unknown as ConnectedGateway
  return { get: vi.fn(() => gateway), probe: vi.fn(), forget: vi.fn() } satisfies GatewayRegistry
}

beforeEach(() => {
  useDeviceStore.setState({ connections: [saved], drafts: { [draftKey('c-1', 'alice')]: 'half a reply' }, outbox: [queued] })
})

describe('signInAgain', () => {
  it('signs in to the saved connection without touching its device data', async () => {
    const login = vi.fn(async () => null)
    const registry = registryWith(login)
    const before = useDeviceStore.getState()

    await signInAgain(registry, saved, creds)

    expect(registry.get).toHaveBeenCalledWith(saved)
    expect(login).toHaveBeenCalledWith(creds)
    expect(registry.forget).not.toHaveBeenCalled()
    const after = useDeviceStore.getState()
    expect(after.connections).toBe(before.connections)
    expect(after.drafts).toBe(before.drafts)
    expect(after.outbox).toBe(before.outbox)
    expect(after.connections).toEqual([saved])
  })

  it('keeps the connection when the server rejects the sign-in', async () => {
    const registry = registryWith(vi.fn(async () => {
      throw new GatewayError('unauthorized', 'x')
    }))

    const attempt = signInAgain(registry, saved, creds)

    await expect(attempt).rejects.toThrow(Error)
    await expect(attempt).rejects.toThrow('Sign-in required.')
    expect(registry.forget).not.toHaveBeenCalled()
    expect(useDeviceStore.getState().connections).toEqual([saved])
    expect(useDeviceStore.getState().drafts).toEqual({ [draftKey('c-1', 'alice')]: 'half a reply' })
    expect(useDeviceStore.getState().outbox).toEqual([queued])
  })

  it('drops the spaces a pasted session token picks up, as Connect does', async () => {
    const login = vi.fn(async () => null)

    await signInAgain(registryWith(login), { ...saved, authMode: 'token' }, { mode: 'token', token: '  abc123\n' })

    expect(login).toHaveBeenCalledWith({ mode: 'token', token: 'abc123' })
  })
})

describe('connectionToSignIn', () => {
  const other: Connection = { ...saved, id: 'c-2', label: 'Office', primary: false }

  it('is the connection the link names', () => {
    expect(connectionToSignIn([saved, other], 'c-2')).toBe(other)
  })

  it('is the primary connection without a name, or for a name this phone does not know', () => {
    expect(connectionToSignIn([other, saved], undefined)).toBe(saved)
    expect(connectionToSignIn([other, saved], 'c-gone')).toBe(saved)
  })

  it('is the first connection when none is primary, and none without connections', () => {
    expect(connectionToSignIn([other], undefined)).toBe(other)
    expect(connectionToSignIn([], 'c-1')).toBeNull()
  })
})
