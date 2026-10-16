/**
 * One RealGateway per saved connection, shared through React context.
 * Screens never build a gateway themselves; features ask the registry.
 */

import React, { createContext, useContext, useMemo, useRef } from 'react'

import { normalizeBaseUrl } from './address'
import type { ConnectedGateway } from './port'
import { RealGateway } from './real/real-gateway'
import type { SecretStore } from './secrets'

export interface ConnectionRecord {
  id: string
  label: string
  baseUrl: string
  authMode: 'token' | 'password'
  primary: boolean
  lastProfile?: string
  createdAt: number
}

export interface GatewayRegistry {
  /** Returns the gateway for a saved connection, creating it on first use. */
  get(connection: ConnectionRecord): ConnectedGateway
  /** Builds a gateway for a connection that is not saved yet (the Connect screen). */
  probe(id: string, baseUrl: string): ConnectedGateway
  /** Drops the gateway and closes its sockets (sign-out, connection removal). */
  forget(id: string): void
}

export function createGatewayRegistry(secrets: SecretStore, factory: (id: string, baseUrl: string) => RealGateway = (id, baseUrl) => new RealGateway({ connectionId: id, baseUrl, secrets })): GatewayRegistry {
  const cache = new Map<string, RealGateway>()
  return {
    get(connection) {
      const existing = cache.get(connection.id)
      if (existing && existing.http.baseUrl === normalizeBaseUrl(connection.baseUrl)) {
        return existing
      }
      existing?.disconnectAll()
      const gateway = factory(connection.id, connection.baseUrl)
      cache.set(connection.id, gateway)
      return gateway
    },
    probe(id, baseUrl) {
      return factory(id, baseUrl)
    },
    forget(id) {
      cache.get(id)?.disconnectAll()
      cache.delete(id)
    }
  }
}

const RegistryContext = createContext<GatewayRegistry | null>(null)

export function GatewayRegistryProvider({ secrets, children }: { secrets: SecretStore; children: React.ReactNode }) {
  const ref = useRef<GatewayRegistry | null>(null)
  if (!ref.current) {
    ref.current = createGatewayRegistry(secrets)
  }
  return <RegistryContext.Provider value={ref.current}>{children}</RegistryContext.Provider>
}

export function useGatewayRegistry(): GatewayRegistry {
  const registry = useContext(RegistryContext)
  if (!registry) {
    throw new Error('GatewayRegistryProvider is missing above this component.')
  }
  return registry
}

/** The port for a saved connection; stable across renders for the same id and URL. */
export function useGateway(connection: ConnectionRecord): ConnectedGateway {
  const registry = useGatewayRegistry()
  // Keyed on the id and the URL, not the record: a record that changes only its label or `primary` flag keeps its gateway.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => registry.get(connection), [registry, connection.id, connection.baseUrl])
}
