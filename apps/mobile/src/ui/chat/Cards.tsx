/**
 * Inline request cards: clarify (choice card, FR-120–123) and approval
 * (FR-190). Same radius and typography as bubbles; explicit actions; the
 * backend state (pending/answered/expired/resolved) is authoritative.
 */

import React, { useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'

import type { ChatItem } from '@/features/chat'
import type { ApprovalChoice } from '@/gateway/types'
import { useTheme } from '@/theme/provider'
import { LEADING, RADIUS, TYPE } from '@/theme/tokens'
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

export function ClarifyCard({ item, onAnswer, onDismiss }: { item: ClarifyItem; onAnswer: (answers: Record<string, string>) => void; onDismiss: (freeText: string) => void }) {
  const theme = useTheme()
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [freeText, setFreeText] = useState('')
  const pending = item.state === 'pending'
  const stateLabel = item.state === 'answered' ? 'Answered' : item.state === 'expired' ? 'Expired' : item.state === 'dismissed' ? 'Dismissed' : null

  const toggle = (qid: string, choice: string, multi: boolean) => {
    setSelected(s => {
      const current = s[qid] ?? []
      if (multi) {
        return { ...s, [qid]: current.includes(choice) ? current.filter(c => c !== choice) : [...current, choice] }
      }
      return { ...s, [qid]: [choice] }
    })
  }

  const submit = () => {
    const answers: Record<string, string> = {}
    for (const q of item.questions) {
      const picks = (selected[q.qid] ?? []).map(c => c.replace(/\s*\(Recommended\)$/, ''))
      answers[q.qid] = q.multi_select ? JSON.stringify(picks) : (picks[0] ?? '')
    }
    onAnswer(answers)
  }
  const canSubmit = pending && item.questions.every(q => (selected[q.qid] ?? []).length > 0)

  return (
    <View style={[styles.card, { backgroundColor: theme.colors.muted, borderRadius: theme.radius.bubble }]} accessibilityLabel="Question from the assistant">
      {item.questions.map(q => (
        <View key={q.qid} style={styles.question}>
          <Text style={[styles.title, { color: theme.colors.foreground }]}>{q.question}</Text>
          {q.multi_select ? <Text style={[styles.hint, { color: theme.colors.mutedForeground }]}>Choose one or more</Text> : null}
          {q.choices.map((choice, index) => {
            const { letter, label } = letterOf(choice, index)
            const answered = item.answers?.[q.qid] ?? ''
            // `label` can be empty (a choice that is only a letter); `''.includes('')`
            // is true, which would render every choice as selected.
            const isSelected = (selected[q.qid] ?? []).includes(choice) || (label.length > 0 && answered.includes(label))
            return (
              <Pressable
                key={choice}
                disabled={!pending}
                onPress={() => toggle(q.qid, choice, q.multi_select)}
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
        </View>
      ))}
      {pending ? (
        <>
          <TextInput
            value={freeText}
            onChangeText={setFreeText}
            placeholder="Or type your own answer"
            placeholderTextColor={theme.colors.mutedForeground}
            accessibilityLabel="Type your own answer"
            style={[styles.input, { backgroundColor: theme.colors.input, borderColor: theme.colors.border, color: theme.colors.foreground }]}
          />
          <View style={styles.actions}>
            {freeText.trim() ? <Button label="Send answer" onPress={() => onDismiss(freeText.trim())} /> : <Button label="Confirm" onPress={submit} disabled={!canSubmit} />}
          </View>
        </>
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
    <View style={[styles.card, { backgroundColor: theme.colors.muted, borderRadius: theme.radius.bubble }]} accessibilityLabel="Approval request">
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

/** The command block's own monospace size, leading and corner. */
const COMMAND_FONT_SIZE = 14
const COMMAND_LINE_HEIGHT = 20
const COMMAND_RADIUS = 10

const styles = StyleSheet.create({
  card: { paddingVertical: 12, paddingHorizontal: 16, marginVertical: 6, gap: 8, alignSelf: 'stretch' },
  question: { gap: 8 },
  title: { ...TYPE.bodyStrong, lineHeight: LEADING.body },
  hint: { ...TYPE.footnote, lineHeight: LEADING.footnote },
  option: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingHorizontal: 12, borderRadius: RADIUS.chip, borderWidth: 1 },
  letter: { ...TYPE.calloutStrong, width: 18 },
  optionText: { ...TYPE.body, flex: 1 },
  input: { minHeight: 44, borderRadius: RADIUS.chip, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, ...TYPE.body },
  actions: { gap: 8, marginTop: 4 },
  command: { fontFamily: 'Menlo', fontSize: COMMAND_FONT_SIZE, lineHeight: COMMAND_LINE_HEIGHT, padding: 10, borderRadius: COMMAND_RADIUS }
})
