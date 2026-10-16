/**
 * Probing an address, connecting to a server and signing in again to a saved one:
 * the grade of the address and the server decides what the app sends, and what it
 * keeps when it refuses. Signing in again keeps the saved connection. Sign out is
 * the only other way back from "Sign-in required", and it deletes the connection
 * with its drafts, outbox, agent setups and local organization.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FakeGateway } from '@test/fake-gateway/fake-gateway'
import statusGated from '@test/fixtures/status-gated.json'

import { PUBLIC_HTTP_REFUSAL } from '@/gateway/address'
import { GatewayError } from '@/gateway/errors'
import type { ConnectedGateway } from '@/gateway/port'
import { createGatewayRegistry, type GatewayRegistry } from '@/gateway/registry'
import { RealGateway } from '@/gateway/real/real-gateway'
import type { SecretStore } from '@/gateway/secrets'
import type { Credentials } from '@/gateway/types'
import { draftKey, useDeviceStore, type Connection } from '@/state/device-store'
import type { OutboxItem } from '@/state/outbox'

import { PASSWORD_TOO_SHORT } from './connection-grade'
import { connectGateway, connectionToSignIn, probeGateway, signInAgain, SignInRefused, signInFailure, type ConnectInput } from './connections'

const saved: Connection = { id: 'c-1', label: 'Home server', baseUrl: 'http://100.64.0.1:9119', authMode: 'password', primary: true, createdAt: 1 }
const queued: OutboxItem = { localId: 'o-1', connectionId: 'c-1', profile: 'alice', text: 'ask about the invoice', createdAt: 2, status: 'queued_unsent' }
const creds: Credentials = { mode: 'password', provider: 'basic', username: 'jop', password: 'hunter2' }

/** A registry whose one gateway only knows `login` and `logout`. */
function registryWith(login: ConnectedGateway['login']) {
  const gateway = { login, logout: async () => undefined } as unknown as ConnectedGateway
  return { get: vi.fn(() => gateway), probe: vi.fn(), forget: vi.fn() } satisfies GatewayRegistry
}

/** A registry that hands the one fake gateway to every connection, saved or not. */
function registryOver(gateway: FakeGateway) {
  const port = gateway as unknown as ConnectedGateway
  return { get: vi.fn(() => port), probe: vi.fn(() => port), forget: vi.fn() } satisfies GatewayRegistry
}

/** A fake gateway that asks for a username and password, as a public server must. */
function gatedGateway(): FakeGateway {
  const gateway = new FakeGateway()
  gateway.requirePassword()
  return gateway
}

const PUBLIC_HTTPS = 'https://hermes.example.com'
const NO_PASSWORD_PUBLIC = 'This public server signs in without a password. Ergates connects to a public server only with a password.'

/**
 * A registry over real gateways whose server answers every status read with `status` and a session cookie,
 * and the secrets those gateways store, so a test sees what a discarded connection leaves behind.
 */
function realRegistry(status: object = statusGated) {
  const stored = new Map<string, string>()
  const secrets: SecretStore = {
    get: async key => stored.get(key) ?? null,
    set: async (key, value) => {
      stored.set(key, value)
    },
    remove: async key => {
      stored.delete(key)
    }
  }
  const fetchImpl = vi.fn(
    async () => new Response(JSON.stringify(status), { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'hermes_session_at=abc; Path=/' } })
  ) as unknown as typeof fetch
  const registry = createGatewayRegistry(secrets, (id, baseUrl) => new RealGateway({ connectionId: id, baseUrl, secrets, fetchImpl }))
  return { registry, stored, fetchImpl }
}

function passwordInput(baseUrl: string, password: string): ConnectInput {
  return { label: 'Office', baseUrl, mode: 'password', provider: 'basic', username: 'jop', password }
}

function passwordCreds(password: string): Credentials {
  return { mode: 'password', provider: 'basic', username: 'jop', password }
}

beforeEach(() => {
  useDeviceStore.setState({ connections: [saved], drafts: { [draftKey('c-1', 'alice')]: 'half a reply' }, outbox: [queued] })
})

describe('probeGateway', () => {
  it('refuses a public address over http without asking the server', async () => {
    const gateway = new FakeGateway()
    const registry = registryOver(gateway)

    const attempt = probeGateway(registry, 'http://8.8.8.8:9119')

    await expect(attempt).rejects.toThrow(PUBLIC_HTTP_REFUSAL)
    await expect(attempt).rejects.toBeInstanceOf(SignInRefused)
    expect(gateway.statusCalls).toBe(0)
    expect(registry.probe).not.toHaveBeenCalled()
  })

  it('refuses an address typed without a scheme, and a Tailscale name over http', async () => {
    const gateway = new FakeGateway()
    const registry = registryOver(gateway)

    await expect(probeGateway(registry, '8.8.8.8:9119')).rejects.toThrow(PUBLIC_HTTP_REFUSAL)
    await expect(probeGateway(registry, 'http://hermes.tail1234.ts.net')).rejects.toThrow(PUBLIC_HTTP_REFUSAL)

    expect(gateway.statusCalls).toBe(0)
  })

  it('leaves no secret behind for the throwaway gateway that asked', async () => {
    const { registry, stored, fetchImpl } = realRegistry()

    await expect(probeGateway(registry, PUBLIC_HTTPS)).resolves.toMatchObject({ auth_required: true })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect([...stored.keys()]).toEqual([])
  })

  it('asks a private address and a public https address for their status', async () => {
    const gateway = new FakeGateway()
    const registry = registryOver(gateway)

    await expect(probeGateway(registry, 'http://192.168.1.10:9119')).resolves.toMatchObject({ auth_required: false })
    await expect(probeGateway(registry, PUBLIC_HTTPS)).resolves.toMatchObject({ auth_required: false })

    expect(gateway.statusCalls).toBe(2)
  })
})

describe('connectGateway', () => {
  it('refuses a short password on a public server before it signs in, and saves nothing', async () => {
    const gateway = gatedGateway()
    const registry = registryOver(gateway)

    const attempt = connectGateway(registry, passwordInput(PUBLIC_HTTPS, 'a'.repeat(11)))

    await expect(attempt).rejects.toThrow(PASSWORD_TOO_SHORT)
    expect(gateway.loginCalls).toBe(0)
    expect(useDeviceStore.getState().connections).toEqual([saved])
    expect(registry.forget).toHaveBeenCalledTimes(1)
  })

  it('removes the cookie a status read stored for the id it discards, when it refuses a short password', async () => {
    const { registry, stored, fetchImpl } = realRegistry()

    await expect(connectGateway(registry, passwordInput(PUBLIC_HTTPS, 'a'.repeat(11)))).rejects.toThrow(PASSWORD_TOO_SHORT)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect([...stored.keys()]).toEqual([])
    expect(useDeviceStore.getState().connections).toEqual([saved])
  })

  it('removes the cookie a status read stored for the id it discards, when the server signs in without a password', async () => {
    // The recorded gated answer, but a server that no longer asks for a password.
    const { registry, stored, fetchImpl } = realRegistry({ ...statusGated, auth_required: false, auth_providers: [] })

    await expect(connectGateway(registry, { label: 'Office', baseUrl: PUBLIC_HTTPS, mode: 'token', token: 'tok-1' })).rejects.toThrow(NO_PASSWORD_PUBLIC)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect([...stored.keys()]).toEqual([])
  })

  it('tells the screen which grade it refused, so it can offer the guide', async () => {
    const attempt = connectGateway(registryOver(gatedGateway()), passwordInput(PUBLIC_HTTPS, 'short'))

    await expect(attempt).rejects.toMatchObject({ name: 'SignInRefused', grade: { kind: 'public' } })
  })

  it('signs in to a public server with a password of 12 characters', async () => {
    const gateway = gatedGateway()
    const registry = registryOver(gateway)

    const record = await connectGateway(registry, passwordInput(PUBLIC_HTTPS, 'a'.repeat(12)))

    expect(gateway.loginCalls).toBe(1)
    expect(record).toMatchObject({ baseUrl: PUBLIC_HTTPS, authMode: 'password', primary: true })
    const { connections } = useDeviceStore.getState()
    expect(connections.map(c => c.id)).toEqual(['c-1', record.id])
    expect(connections.find(c => c.id === record.id)?.primary).toBe(true)
    expect(registry.forget).not.toHaveBeenCalled()
  })

  it('counts a password in characters, not bytes, so 12 emoji pass and 11 do not', async () => {
    const gateway = gatedGateway()
    const registry = registryOver(gateway)

    await expect(connectGateway(registry, passwordInput(PUBLIC_HTTPS, '😀'.repeat(11)))).rejects.toThrow(PASSWORD_TOO_SHORT)
    await expect(connectGateway(registry, passwordInput(PUBLIC_HTTPS, '😀'.repeat(12)))).resolves.toMatchObject({ baseUrl: PUBLIC_HTTPS })

    expect(gateway.loginCalls).toBe(1)
  })

  it('signs in to a private address with a short password, without asking its status', async () => {
    const gateway = new FakeGateway()

    await connectGateway(registryOver(gateway), passwordInput('http://192.168.1.10:9119', 'x'))

    expect(gateway.loginCalls).toBe(1)
    expect(gateway.statusCalls).toBe(0)
  })

  it('refuses a short password on a Tailscale name over https, since Funnel can publish it', async () => {
    const gateway = gatedGateway()

    const attempt = connectGateway(registryOver(gateway), passwordInput('https://hermes.tail1234.ts.net', 'a'.repeat(11)))

    await expect(attempt).rejects.toThrow(PASSWORD_TOO_SHORT)
    await expect(attempt).rejects.toMatchObject({ grade: { kind: 'public' } })
    expect(gateway.loginCalls).toBe(0)
  })

  it('signs in to a Tailscale name over https with a password of 12 characters', async () => {
    const gateway = gatedGateway()

    await connectGateway(registryOver(gateway), passwordInput('https://hermes.tail1234.ts.net', 'a'.repeat(12)))

    expect(gateway.loginCalls).toBe(1)
  })

  it('signs in to a Tailscale IP address over http with a short password, without asking its status', async () => {
    const gateway = gatedGateway()

    await connectGateway(registryOver(gateway), passwordInput('http://100.101.102.103:9119', 'x'))

    expect(gateway.loginCalls).toBe(1)
    expect(gateway.statusCalls).toBe(0)
  })

  it('refuses a public address over http before any request, and saves nothing', async () => {
    const gateway = gatedGateway()
    const registry = registryOver(gateway)

    const attempt = connectGateway(registry, passwordInput('http://8.8.8.8:9119', 'a'.repeat(40)))

    await expect(attempt).rejects.toThrow(PUBLIC_HTTP_REFUSAL)
    await expect(attempt).rejects.toMatchObject({ grade: { kind: 'unsafe', reason: 'public_http' } })
    expect(gateway.statusCalls).toBe(0)
    expect(gateway.loginCalls).toBe(0)
    expect(useDeviceStore.getState().connections).toEqual([saved])
  })

  it('refuses a public server that signs in without a password, before it sends the token', async () => {
    const gateway = new FakeGateway()
    const registry = registryOver(gateway)

    const attempt = connectGateway(registry, { label: 'Office', baseUrl: PUBLIC_HTTPS, mode: 'token', token: 'tok-1' })

    await expect(attempt).rejects.toThrow(NO_PASSWORD_PUBLIC)
    expect(gateway.statusCalls).toBe(1)
    expect(gateway.loginCalls).toBe(0)
    expect(useDeviceStore.getState().connections).toEqual([saved])
    expect(registry.forget).toHaveBeenCalledTimes(1)
  })

  it('signs in to a loopback server with a session token, as the development hook does', async () => {
    const gateway = new FakeGateway()

    await connectGateway(registryOver(gateway), { label: 'Local Hermes', baseUrl: 'http://127.0.0.1:9119', mode: 'token', token: 'tok-1' })

    expect(gateway.loginCalls).toBe(1)
    expect(gateway.statusCalls).toBe(0)
  })

  it('says so when the server cannot be asked, and signs in to nothing', async () => {
    const gateway = gatedGateway()
    gateway.setHermesVersion(new GatewayError('network', 'x'))
    const registry = registryOver(gateway)

    await expect(connectGateway(registry, passwordInput(PUBLIC_HTTPS, 'a'.repeat(12)))).rejects.toThrow('No connection to the gateway.')

    expect(gateway.loginCalls).toBe(0)
    expect(useDeviceStore.getState().connections).toEqual([saved])
    expect(registry.forget).toHaveBeenCalledTimes(1)
  })

  it('keeps nothing when the server rejects the sign-in', async () => {
    const registry = registryWith(
      vi.fn(async () => {
        throw new GatewayError('unauthorized', 'x')
      })
    )

    await expect(connectGateway(registry, passwordInput('http://192.168.1.10:9119', 'x'))).rejects.toThrow('Sign-in required.')

    expect(useDeviceStore.getState().connections).toEqual([saved])
    expect(registry.forget).toHaveBeenCalledTimes(1)
  })
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

  it('refuses a short password on a saved public connection before it signs in', async () => {
    const gateway = gatedGateway()
    const registry = registryOver(gateway)
    const publicServer: Connection = { ...saved, baseUrl: PUBLIC_HTTPS }
    const before = useDeviceStore.getState().connections

    const attempt = signInAgain(registry, publicServer, passwordCreds('a'.repeat(11)))

    await expect(attempt).rejects.toThrow(PASSWORD_TOO_SHORT)
    await expect(attempt).rejects.toMatchObject({ grade: { kind: 'public' } })
    expect(gateway.loginCalls).toBe(0)
    expect(registry.forget).not.toHaveBeenCalled()
    // The store was not written, and holds no connection to that address.
    expect(useDeviceStore.getState().connections).toBe(before)
    expect(before.some(c => c.baseUrl === PUBLIC_HTTPS)).toBe(false)
  })

  it('signs in to a saved public connection with a password of 12 characters, after a fresh status read', async () => {
    const gateway = gatedGateway()
    const publicServer: Connection = { ...saved, baseUrl: PUBLIC_HTTPS }

    await signInAgain(registryOver(gateway), publicServer, passwordCreds('a'.repeat(12)))

    expect(gateway.statusCalls).toBe(1)
    expect(gateway.loginCalls).toBe(1)
  })

  it('refuses a saved public address over http before any request', async () => {
    const gateway = gatedGateway()
    const old: Connection = { ...saved, baseUrl: 'http://8.8.8.8:9119' }

    await expect(signInAgain(registryOver(gateway), old, passwordCreds('a'.repeat(40)))).rejects.toThrow(PUBLIC_HTTP_REFUSAL)

    expect(gateway.statusCalls).toBe(0)
    expect(gateway.loginCalls).toBe(0)
  })

  it('refuses a saved public connection whose server now signs in without a password', async () => {
    const gateway = new FakeGateway()
    const publicServer: Connection = { ...saved, baseUrl: PUBLIC_HTTPS, authMode: 'token' }

    await expect(signInAgain(registryOver(gateway), publicServer, { mode: 'token', token: 'tok-1' })).rejects.toThrow(NO_PASSWORD_PUBLIC)

    expect(gateway.statusCalls).toBe(1)
    expect(gateway.loginCalls).toBe(0)
  })

  it('says so when the saved server cannot be asked, and signs in to nothing', async () => {
    const gateway = gatedGateway()
    gateway.setHermesVersion(new GatewayError('timeout', 'x'))
    const publicServer: Connection = { ...saved, baseUrl: PUBLIC_HTTPS }

    await expect(signInAgain(registryOver(gateway), publicServer, passwordCreds('a'.repeat(12)))).rejects.toThrow('The gateway did not answer in time.')

    expect(gateway.loginCalls).toBe(0)
  })

  it('signs in to a saved private connection with a short password, without asking its status', async () => {
    const gateway = new FakeGateway()

    await signInAgain(registryOver(gateway), saved, passwordCreds('x'))

    expect(gateway.loginCalls).toBe(1)
    expect(gateway.statusCalls).toBe(0)
  })

  it('signs a saved token connection in with a password once the server asks for one, and saves the new mode in place', async () => {
    // Saved before the server moved to password mode: the screen now shows the password fields (signInModeFrom).
    const gateway = gatedGateway()
    const tokenSaved: Connection = { ...saved, baseUrl: PUBLIC_HTTPS, authMode: 'token' }
    useDeviceStore.setState({ connections: [tokenSaved] })
    const before = useDeviceStore.getState()

    await signInAgain(registryOver(gateway), tokenSaved, passwordCreds('a'.repeat(12)))

    expect(gateway.loginCalls).toBe(1)
    const after = useDeviceStore.getState()
    expect(after.connections).toEqual([{ ...tokenSaved, authMode: 'password' }])
    expect(after.drafts).toBe(before.drafts)
    expect(after.outbox).toBe(before.outbox)
  })

  it('saves the new mode for a private address too, where any password goes', async () => {
    const gateway = gatedGateway()
    const tokenSaved: Connection = { ...saved, authMode: 'token' }
    useDeviceStore.setState({ connections: [tokenSaved] })

    await signInAgain(registryOver(gateway), tokenSaved, passwordCreds('x'))

    expect(useDeviceStore.getState().connections).toEqual([{ ...tokenSaved, authMode: 'password' }])
  })

  it('saves the token mode for a saved password connection whose private server now takes a token', async () => {
    const login = vi.fn(async () => null)

    await signInAgain(registryWith(login), saved, { mode: 'token', token: 'tok-1' })

    expect(useDeviceStore.getState().connections).toEqual([{ ...saved, authMode: 'token' }])
  })

  it('keeps the saved mode when the sign-in in the other mode is refused or rejected', async () => {
    const tokenSaved: Connection = { ...saved, baseUrl: PUBLIC_HTTPS, authMode: 'token' }
    useDeviceStore.setState({ connections: [tokenSaved] })
    const gateway = gatedGateway()

    await expect(signInAgain(registryOver(gateway), tokenSaved, passwordCreds('a'.repeat(11)))).rejects.toThrow(PASSWORD_TOO_SHORT)
    const rejecting = registryWith(
      vi.fn(async () => {
        throw new GatewayError('unauthorized', 'x')
      })
    )
    await expect(signInAgain(rejecting, { ...saved, authMode: 'token' }, passwordCreds('x'))).rejects.toThrow('Sign-in required.')

    expect(gateway.loginCalls).toBe(0)
    expect(useDeviceStore.getState().connections).toEqual([tokenSaved])
  })

  it('drops the spaces a pasted session token picks up, as Connect does', async () => {
    const login = vi.fn(async () => null)

    await signInAgain(registryWith(login), { ...saved, authMode: 'token' }, { mode: 'token', token: '  abc123\n' })

    expect(login).toHaveBeenCalledWith({ mode: 'token', token: 'abc123' })
  })
})

describe('signInFailure', () => {
  it('carries the grade of a refusal, so the screen can offer the guide', () => {
    const grade = { kind: 'unsafe', reason: 'public_http' } as const

    expect(signInFailure(new SignInRefused(PUBLIC_HTTP_REFUSAL, grade))).toEqual({ message: PUBLIC_HTTP_REFUSAL, grade })
  })

  it('carries no grade for any other failure', () => {
    expect(signInFailure(new Error('Sign-in required.'))).toEqual({ message: 'Sign-in required.', grade: null })
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
