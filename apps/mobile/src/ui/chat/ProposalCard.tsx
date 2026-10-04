/**
 * An agent proposal from the chat (docs/11 section 4.1): what the agent
 * proposed, then Accept or Reject. Accept takes no edits. After Accept the
 * card follows the setup step by step. What it says and offers comes from
 * `proposalView` (`@/features/agents`).
 */

import React from 'react'
import { Alert, StyleSheet, Text, View } from 'react-native'

import type { ProposalAction } from '@/features/agents'
import { useProposal } from '@/features/chat'
import { userMessage } from '@/gateway/errors'
import type { AgentProposal } from '@/gateway/types'
import { useTheme } from '@/theme/provider'
import { LEADING, RADIUS, SPACE, TYPE } from '@/theme/tokens'
import { Button, type ButtonVariant } from '@/ui/Button'

const LABELS: Record<ProposalAction, string> = {
  accept: 'Accept',
  reject: 'Reject',
  retry: 'Try again',
  resend_briefing: 'Send the briefing again',
  open_chat: 'Open chat',
  reload: 'Reload'
}

const VARIANTS: Partial<Record<ProposalAction, ButtonVariant>> = { reject: 'secondary', open_chat: 'secondary', reload: 'secondary' }

export function ProposalCard({ proposal, onOpenChat }: { proposal: AgentProposal; onOpenChat: (profile: string) => void }) {
  const theme = useTheme()
  const card = useProposal(proposal)
  const { view } = card
  if (view.hidden) {
    return null
  }
  const { agent } = proposal

  const onAction = (action: ProposalAction) => {
    switch (action) {
      case 'accept':
        void card.accept()
        return
      case 'reject':
        Alert.alert('Reject this proposal?', `${agent.title} will not be created.`, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Reject', style: 'destructive', onPress: () => void card.reject().catch(err => Alert.alert('Could not reject', userMessage(err))) }
        ])
        return
      case 'retry':
        void card.retry()
        return
      case 'resend_briefing':
        void card.resendBriefing()
        return
      case 'open_chat':
        onOpenChat(agent.name)
        return
      case 'reload':
        card.reload()
    }
  }

  const statusColor = view.status === 'failed' || view.status === 'closed' ? theme.colors.destructive : theme.colors.mutedForeground
  return (
    <View style={[styles.card, { backgroundColor: theme.colors.muted, borderRadius: RADIUS.extraLarge }]} accessibilityLabel={`Proposed agent ${agent.title}`}>
      <Text style={[styles.kicker, { color: theme.colors.mutedForeground }]}>New agent proposed</Text>
      <Text style={[styles.title, { color: theme.colors.foreground }]}>
        {agent.title} · {agent.role}
      </Text>
      {agent.description ? <Text style={[styles.body, { color: theme.colors.foreground }]}>{agent.description}</Text> : null}
      <Text style={[styles.meta, { color: theme.colors.mutedForeground }]}>
        Profile {agent.name} · {agent.provider} / {agent.model}
      </Text>
      <Text style={[styles.meta, { color: theme.colors.mutedForeground }]}>Tools and access: the {agent.template_id} role</Text>
      {view.text ? (
        <Text style={[styles.meta, { color: statusColor }]} accessibilityLiveRegion="polite">
          {view.text}
        </Text>
      ) : null}
      {view.actions.length > 0 ? (
        <View style={styles.actions}>
          {view.actions.map(action => (
            <Button key={action} label={LABELS[action]} variant={VARIANTS[action]} onPress={() => onAction(action)} />
          ))}
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { paddingVertical: SPACE.medium, paddingHorizontal: SPACE.large, marginVertical: SPACE.extraSmall, gap: SPACE.extraSmall, alignSelf: 'stretch' },
  kicker: { ...TYPE.footnote },
  title: { ...TYPE.bodyStrong, lineHeight: LEADING.body },
  body: { ...TYPE.callout, lineHeight: LEADING.callout },
  meta: { ...TYPE.footnote, lineHeight: LEADING.footnote },
  actions: { gap: SPACE.small, marginTop: SPACE.extraSmall }
})
