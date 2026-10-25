/**
 * Inline request cards: clarify (choice card, FR-120–123) and approval
 * (FR-190). Same radius and typography as bubbles; explicit actions; the
 * backend state (pending/answered/expired/resolved) is authoritative.
 */

import React, { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'

import { answerParts, canConfirm, clarifyAnswers, pickChoice, stageOf, typeAnswer, type ChatItem, type ClarifyDraft } from '@/features/chat'
import type { ApprovalChoice } from '@/gateway/types'
import { useTheme } from '@/theme/provider'
import { LEADING, RADIUS, RULE, SIZE, SPACE, TYPE } from '@/theme/tokens'
import { Button } from '@/ui/Button'

type ClarifyItem = Extract<ChatItem, { kind: 'clarify' }>
type ApprovalItem = Extract<ChatItem, { kind: 'approval' }>

const LETTERS = 'ABCDEFGHIJ'

function letterOf(choice: string, index: number): { letter: string; label: string } {
  const m = /^([A-Za-z])[).:]\s*(.*)$/.exec(choice)
  if (m) {
    return { letter: m[1]!.toUpperCase(), label: m[2] ?? '' }
  }
  return { letter: LETTERS[index] ?? String(index + 1), label: choice }
}

/**
 * Clarify answers in progress by request id. The chat owns it above its
 * content's remount on a text-size change (`use-font-scale-key.ts`), so a
 * card that remounts picks its answer up again.
 */
export type ClarifyDrafts = Map<string, ClarifyDraft>

/**
 * Each question has its choices and its own text field; a question left open
 * is sent as skipped (`clarify-answers.ts`). Confirm needs one answer.
 */
export function ClarifyCard({ item, drafts, onAnswer }: { item: ClarifyItem; drafts: ClarifyDrafts; onAnswer: (answers: Record<string, string | null>) => void }) {
  const theme = useTheme()
  const [draft, setDraft] = useState<ClarifyDraft>(() => drafts.get(item.requestId) ?? {})
  useEffect(() => {
    drafts.set(item.requestId, draft)
  }, [drafts, item.requestId, draft])
  const pending = item.state === 'pending'
  const stateLabel = item.state === 'answered' ? 'Answered' : item.state === 'expired' ? 'Expired' : null

  return (
    <View style={[styles.card, { backgroundColor: theme.colors.muted, borderRadius: RADIUS.extraLarge }]} accessibilityLabel="Question from the assistant">
      {item.questions.map(q => {
        const stage = stageOf(draft, q.qid)
        const sent = answerParts(q, item.answers?.[q.qid])
        const field = q.choices.length > 0 ? 'Or type your own answer' : 'Type your answer'
        return (
          <View key={q.qid} style={styles.question}>
            <Text style={[styles.title, { color: theme.colors.foreground }]}>{q.question}</Text>
            {q.multi_select ? <Text style={[styles.hint, { color: theme.colors.mutedForeground }]}>Choose one or more</Text> : null}
            {q.choices.map((choice, index) => {
              const { letter, label } = letterOf(choice, index)
              const isSelected = pending ? stage.choices.includes(choice) : sent.choices.includes(choice)
              return (
                <Pressable
                  key={choice}
                  disabled={!pending}
                  onPress={() => setDraft(d => pickChoice(d, q, choice))}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isSelected, disabled: !pending }}
                  accessibilityLabel={`${letter}: ${label}`}
                  style={[styles.option, { borderColor: isSelected ? theme.colors.primary : theme.colors.border, backgroundColor: isSelected ? theme.colors.accent : theme.colors.background }]}
                >
                  <Text style={[styles.letter, { color: theme.colors.mutedForeground }]}>{letter}</Text>
                  <Text style={[styles.optionText, { color: theme.colors.foreground }]}>{label}</Text>
                  {isSelected && !pending ? <Text style={{ color: theme.colors.primary }}>✓</Text> : null}
                </Pressable>
              )
            })}
            {pending ? (
              <TextInput
                value={stage.typed}
                onChangeText={text => setDraft(d => typeAnswer(d, q, text))}
                placeholder={field}
                placeholderTextColor={theme.colors.mutedForeground}
                accessibilityLabel={`${field}: ${q.question}`}
                style={[styles.input, { backgroundColor: theme.colors.input, borderColor: theme.colors.border, color: theme.colors.foreground }]}
              />
            ) : sent.typed !== null ? (
              <Text style={[styles.answer, { color: theme.colors.foreground }]}>{sent.typed}</Text>
            ) : sent.skipped ? (
              <Text style={[styles.hint, { color: theme.colors.mutedForeground }]}>Skipped</Text>
            ) : null}
          </View>
        )
      })}
      {pending ? (
        <View style={styles.actions}>
          {item.error ? <Text style={[styles.hint, { color: theme.colors.destructive }]}>{item.error}</Text> : null}
          <Button label="Confirm" onPress={() => onAnswer(clarifyAnswers(item.questions, draft, item.locked))} disabled={!canConfirm(item.questions, draft)} />
        </View>
      ) : (
        <Text style={[styles.hint, { color: theme.colors.mutedForeground }]}>{stateLabel}</Text>
      )}
    </View>
  )
}

const CHOICE_LABEL: Record<ApprovalChoice, string> = { once: 'Allow once', session: 'Allow this chat', always: 'Always allow', deny: 'Deny' }

export function ApprovalCard({ item, onChoose }: { item: ApprovalItem; onChoose: (choice: ApprovalChoice) => void }) {
  const theme = useTheme()
  const pending = item.state === 'pending'
  const choices = (item.payload.choices?.length ? item.payload.choices : (['once', 'session', 'always', 'deny'] as ApprovalChoice[])).filter((c): c is ApprovalChoice => c in CHOICE_LABEL)
  return (
    <View style={[styles.card, { backgroundColor: theme.colors.muted, borderRadius: RADIUS.extraLarge }]} accessibilityLabel="Approval request">
      <Text style={[styles.title, { color: theme.colors.foreground }]}>{item.payload.description || 'The assistant asks permission to run a command.'}</Text>
      {item.payload.command ? (
        <Text style={[styles.command, { color: theme.colors.foreground, backgroundColor: theme.colors.background }]} numberOfLines={6}>
          {item.payload.command}
        </Text>
      ) : null}
      {pending ? (
        <View style={styles.actions}>
          {choices.map(c => (
            <Button key={c} label={CHOICE_LABEL[c]} variant={c === 'deny' ? 'destructive' : c === 'once' ? 'primary' : 'secondary'} onPress={() => onChoose(c)} />
          ))}
        </View>
      ) : (
        <Text style={[styles.hint, { color: theme.colors.mutedForeground }]}>{item.state === 'expired' ? 'Expired' : `Resolved${item.choice ? `: ${CHOICE_LABEL[item.choice as ApprovalChoice] ?? item.choice}` : ''}`}</Text>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { paddingVertical: SPACE.medium, paddingHorizontal: SPACE.large, marginVertical: SPACE.extraSmall, gap: SPACE.small, alignSelf: 'stretch' },
  question: { gap: SPACE.small },
  title: { ...TYPE.bodyStrong, lineHeight: LEADING.body },
  hint: { ...TYPE.footnote, lineHeight: LEADING.footnote },
  option: { flexDirection: 'row', alignItems: 'center', gap: SPACE.small, minHeight: SIZE.large, paddingHorizontal: SPACE.medium, borderRadius: RADIUS.medium, borderWidth: 1 },
  letter: { ...TYPE.calloutStrong, width: SIZE.extraSmall },
  optionText: { ...TYPE.body, flex: 1 },
  answer: { ...TYPE.body, lineHeight: LEADING.body },
  input: { minHeight: RULE.touch, borderRadius: RADIUS.medium, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: SPACE.medium, ...TYPE.body },
  actions: { gap: SPACE.small, marginTop: SPACE.extraSmall },
  command: { ...TYPE.footnote, fontFamily: 'Menlo', lineHeight: LEADING.footnote, padding: SPACE.small, borderRadius: RADIUS.small }
})
