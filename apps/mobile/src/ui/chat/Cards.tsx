/**
 * Inline request cards: clarify (choice card, FR-120–123) and approval
 * (FR-190). Same radius and typography as bubbles; explicit actions; the
 * backend state (pending/answered/expired/resolved) is authoritative.
 */

import React, { useEffect, useState } from 'react'
import { Platform, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native'

import { answerParts, canConfirm, canSend, clarifyAnswers, pickChoice, promptStateLabel, promptValue, promptView, stageOf, typeAnswer, type ChatItem, type ClarifyDraft, type PromptEntries, type PromptEntry } from '@/features/chat'
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

const CLARIFY_STATE: Record<ClarifyItem['state'], string | null> = { pending: null, answered: 'Answered', skipped: 'Skipped', expired: 'Expired' }

/**
 * Each question has its choices and its own text field; a question left open
 * is sent as skipped (`clarify-answers.ts`). Confirm needs one answer. Skip
 * (`onAnswer(null)`) skips every question at once, as Hermes Desktop's Skip does.
 */
export function ClarifyCard({ item, drafts, onAnswer }: { item: ClarifyItem; drafts: ClarifyDrafts; onAnswer: (answers: Record<string, string | null> | null) => void }) {
  const theme = useTheme()
  const [draft, setDraft] = useState<ClarifyDraft>(() => drafts.get(item.requestId) ?? {})
  useEffect(() => {
    drafts.set(item.requestId, draft)
  }, [drafts, item.requestId, draft])
  const pending = item.state === 'pending'

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
          <Button label="Skip" variant="secondary" accessibilityLabel={item.questions.length > 1 ? 'Skip all questions' : 'Skip the question'} onPress={() => onAnswer(null)} />
        </View>
      ) : (
        <Text style={[styles.hint, { color: theme.colors.mutedForeground }]}>{CLARIFY_STATE[item.state]}</Text>
      )}
    </View>
  )
}

type PromptItem = Extract<ChatItem, { kind: 'prompt' }>

/** The phone's autofill hints for a prompt field. `off` asks it not to autofill a server password or a secret; iOS still shows its Passwords button above the keyboard for a masked field. */
function autofillProps(autofill: PromptEntry['autofill']): Pick<TextInputProps, 'autoComplete' | 'textContentType' | 'importantForAutofill'> {
  switch (autofill) {
    case 'off':
      return { autoComplete: 'off', textContentType: 'none', importantForAutofill: 'no' }
    case 'password':
      return { autoComplete: 'password', textContentType: 'password' }
    case 'username':
      return { autoComplete: 'username', textContentType: 'username' }
    case 'oneTimeCode':
      return { autoComplete: Platform.OS === 'android' ? 'sms-otp' : 'one-time-code', textContentType: 'oneTimeCode' }
  }
}

/**
 * A password, secret or code Hermes asks for (`prompt-view.ts`). What the
 * user types lives only in this card's state, never in the chat state or a
 * draft, and is dropped once the card settles; the settled card says how it
 * ended, never the value. `onAnswer('')` declines.
 */
export function PromptCard({ item, onAnswer }: { item: PromptItem; onAnswer: (value: string) => void }) {
  const theme = useTheme()
  const view = promptView(item.method, item.fields)
  const [entries, setEntries] = useState<PromptEntries>({})
  const pending = item.state === 'pending'
  useEffect(() => {
    if (!pending) {
      setEntries({})
    }
  }, [pending])

  return (
    <View style={[styles.card, { backgroundColor: theme.colors.muted, borderRadius: RADIUS.extraLarge }]}>
      <Text style={[styles.title, { color: theme.colors.foreground }]} accessibilityRole="header">
        {view.title}
      </Text>
      {view.body.map((line, index) => (
        <Text key={index} style={[styles.answer, { color: theme.colors.foreground }]}>
          {line}
        </Text>
      ))}
      {view.command ? (
        // The whole command: the user judges it before the password goes out.
        <Text style={[styles.command, { color: theme.colors.foreground, backgroundColor: theme.colors.background }]}>
          {view.command}
        </Text>
      ) : null}
      {pending ? (
        <>
          {view.entries.map(entry => (
            <TextInput
              key={entry.key}
              value={entries[entry.key] ?? ''}
              onChangeText={text => setEntries(e => ({ ...e, [entry.key]: text }))}
              placeholder={entry.label}
              placeholderTextColor={theme.colors.mutedForeground}
              accessibilityLabel={entry.label}
              secureTextEntry={entry.masked}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              {...autofillProps(entry.autofill)}
              style={[styles.input, { backgroundColor: theme.colors.input, borderColor: theme.colors.border, color: theme.colors.foreground }]}
            />
          ))}
          <View style={styles.actions}>
            {item.error ? <Text style={[styles.hint, { color: theme.colors.destructive }]}>{item.error}</Text> : null}
            <Button label={view.send} onPress={() => onAnswer(promptValue(item.method, entries))} disabled={!canSend(view, entries)} />
            <Button label={view.decline} variant="secondary" onPress={() => onAnswer('')} />
          </View>
        </>
      ) : (
        <Text style={[styles.hint, { color: theme.colors.mutedForeground }]}>{promptStateLabel(item)}</Text>
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
        // The whole command: the user judges it before allowing it.
        <Text style={[styles.command, { color: theme.colors.foreground, backgroundColor: theme.colors.background }]}>
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
