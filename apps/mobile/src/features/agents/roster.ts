/**
 * Roster: Hermes profiles as Bot view models, plus the Hermes-owned
 * queries (TanStack Query) for the roster, describe, avatar and model options.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type { GatewayPort } from '@/gateway/port'
import type { ProfileSummary } from '@/gateway/types'

import { botsMeta, friendlyName, roleBadge } from './editor'

export interface Bot {
  profile: string
  name: string
  role: string
  description: string
  hidden: boolean
  color?: string
  hasAvatar: boolean
  isDefault: boolean
  model?: string
  provider?: string
  /** Epoch milliseconds of the latest Bot Chat activity. */
  lastActivityAt: number
  preview: string
  canonicalSessionId: string | null
  /** Shared with Hermes Desktop (`ui_meta['hermes-bots'].pinned`); undefined when Hermes has no value. */
  pinned?: boolean
  /** `ui_meta['hermes-bots'].sectionId`: null is No section, undefined is no value. */
  sectionId?: string | null
  /** `ui_meta['hermes-bots'].sectionName`, the section's name as the last writer saw it. */
  sectionName?: string | null
  /** The `hermes-bots` metadata revision a write must name (0 when Hermes has none). */
  revision?: number
  summary: ProfileSummary
}

const seconds = (v: number | undefined | null) => (typeof v === 'number' && v > 0 ? Math.round(v * 1000) : 0)

/** A chat preview as one line of plain text: Desktop's `stripPreviewMarkdown` (hermes-bots/labels.ts at the pin). */
export function stripPreviewMarkdown(text: unknown): string {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|\s)[*_](\S(?:.*?\S)?)[*_](?=\s|$|[.,;:!?])/g, '$1$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A trimmed non-empty string, or null (an empty or non-string value means none). */
const textOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** Desktop's `botSectionId` (`id ? String(id) : null`): a non-empty string or number becomes its string form, untrimmed; anything else, or empty, is null. */
const sectionIdOrNull = (v: unknown): string | null => ((typeof v === 'string' || typeof v === 'number') && v ? String(v) : null)

export function toBot(p: ProfileSummary): Bot {
  const meta = botsMeta(p)
  const cs = p.canonical_session ?? null
  return {
    profile: p.name,
    name: friendlyName(p),
    role: roleBadge(p),
    description: p.description ?? '',
    hidden: Boolean(meta.hidden),
    color: typeof meta.color === 'string' ? meta.color : undefined,
    hasAvatar: Boolean(p.has_avatar),
    isDefault: Boolean(p.is_default),
    model: p.model,
    provider: p.provider,
    lastActivityAt: Math.max(seconds(cs?.last_active), seconds(cs?.started_at), seconds((p.last_session as { last_active?: number } | null)?.last_active)),
    preview: stripPreviewMarkdown(cs?.preview ?? (p.last_session as { preview?: string } | null)?.preview ?? ''),
    canonicalSessionId: cs ? cs.resolved_id || cs.id : null,
    pinned: typeof meta.pinned === 'boolean' ? meta.pinned : undefined,
    sectionId: 'sectionId' in meta ? sectionIdOrNull(meta.sectionId) : undefined,
    sectionName: 'sectionName' in meta ? textOrNull(meta.sectionName) : undefined,
    revision: p.ui_meta_revisions?.['hermes-bots'] ?? 0,
    summary: p
  }
}

export function searchBots(bots: Bot[], query: string): Bot[] {
  const q = query.trim().toLowerCase()
  if (!q) {
    return bots
  }
  return bots.filter(b => [b.name, b.role, b.description, b.profile].some(v => v.toLowerCase().includes(q)))
}

/** The agent's summary from a roster as last read; undefined when the roster is missing it (loading, or Hermes no longer has it). */
export function summaryOfRoster(roster: Bot[] | undefined, profile: string): ProfileSummary | undefined {
  return roster?.find(b => b.profile === profile)?.summary
}

/** The agent's shown name from that same roster; the profile name itself when the roster does not have it. */
export function nameOfRoster(roster: Bot[] | undefined, profile: string): string {
  return roster?.find(b => b.profile === profile)?.name ?? profile
}

export const rosterKey = (connectionId: string) => ['profiles', connectionId] as const
export const describeKey = (connectionId: string, profile: string) => ['describe', connectionId, profile] as const
export const avatarKey = (connectionId: string, profile: string) => ['avatar', connectionId, profile] as const
export const modelOptionsKey = (connectionId: string, profile: string) => ['model-options', connectionId, profile] as const

export function useRoster(port: GatewayPort, connectionId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: rosterKey(connectionId),
    queryFn: async () => (await port.profiles.list()).profiles.map(toBot),
    staleTime: 5_000,
    refetchInterval: 30_000,
    enabled: options.enabled ?? true
  })
}

export function useDescribe(port: GatewayPort, connectionId: string, profile: string) {
  return useQuery({ queryKey: describeKey(connectionId, profile), queryFn: () => port.profiles.describe(profile), staleTime: 10_000 })
}

export function useAvatar(port: GatewayPort, connectionId: string, profile: string, hasAvatar: boolean) {
  return useQuery({
    queryKey: avatarKey(connectionId, profile),
    queryFn: async () => {
      const asset = await port.profiles.getAsset(profile)
      return asset.found && asset.data ? asset.data : null
    },
    enabled: hasAvatar,
    staleTime: 60 * 60 * 1000
  })
}

export function useModelOptions(port: GatewayPort, connectionId: string, profile: string) {
  return useQuery({ queryKey: modelOptionsKey(connectionId, profile), queryFn: () => port.profiles.modelOptions(profile), staleTime: 120_000, retry: false })
}

/** Hide/unhide is shared Hermes metadata: send the full merged namespace with its expected revision. */
export function useSetHidden(port: GatewayPort, connectionId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async ({ bot, hidden }: { bot: Bot; hidden: boolean }) => {
      const meta = { ...botsMeta(bot.summary), hidden }
      const rev = bot.summary.ui_meta_revisions?.['hermes-bots'] ?? 0
      const result = await port.profiles.configure({ name: bot.profile, ui_meta: { 'hermes-bots': meta }, ui_meta_expected_revisions: { 'hermes-bots': rev } })
      if (result.applied?.ui_meta === false) {
        throw new Error(result.applied.ui_meta_conflicts ? 'Someone else changed this bot. Try again.' : 'The gateway did not apply the change.')
      }
      return result
    },
    onSettled: () => client.invalidateQueries({ queryKey: rosterKey(connectionId) })
  })
}
