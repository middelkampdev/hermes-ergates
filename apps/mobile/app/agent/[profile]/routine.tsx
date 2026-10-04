/**
 * Routine editor (docs/02 section 3.6 FR-176, docs/10 "Settings and agent
 * details"): create or edit one Hermes cron job scoped to this profile.
 * A new routine goes through the Ergates reminder route (docs/11 section
 * 4.3), so a resend never makes a second job; editing stays on native cron.
 * Active is a lifecycle action (pause/resume) applied immediately, separate
 * from Save, which only writes name/instruction/schedule.
 */

import { useLocalSearchParams, useRouter } from 'expo-router'
import React, { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native'

import {
  displayName,
  isActive,
  nextRunLabel,
  reminderResult,
  toDate,
  useCreateReminder,
  useRoutineMutations,
  useRoutineRuns,
  useRoutines,
  validateRoutine,
  type ReminderResult,
  type RoutineDraft
} from '@/features/routines'
import { usePrimaryConnection } from '@/features/settings'
import { userMessage } from '@/gateway/errors'
import { useGateway } from '@/gateway/registry'
import type { CronJob, CronRun } from '@/gateway/types'
import { softFill } from '@/theme/fill'
import { useTheme } from '@/theme/provider'
import { LEADING, LEGACY_RADIUS, TYPE } from '@/theme/tokens'
import { Button } from '@/ui/Button'
import { Card } from '@/ui/Card'
import { Field } from '@/ui/Field'
import { Sheet } from '@/ui/Sheet'
import { SwitchRow } from '@/ui/SwitchRow'
import { useSurface } from '@/ui/surface-context'

export default function RoutineScreen() {
  const { profile, id } = useLocalSearchParams<{ profile: string; id?: string }>()
  const router = useRouter()
  const connection = usePrimaryConnection()
  if (!connection || !profile) {
    return null
  }
  return <RoutineEditor connection={connection} profile={profile} id={id ?? 'new'} onClose={() => router.back()} />
}

function runTimeMs(run: CronRun): number {
  return toDate(run.started_at)?.getTime() ?? 0
}

function formatRunTime(run: CronRun): string {
  const ms = runTimeMs(run)
  if (!ms) {
    return 'Unknown time'
  }
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function firstLine(run: CronRun): string {
  const text = (run.output || run.error || '').trim()
  if (!text) {
    return ''
  }
  return text.split('\n')[0] ?? ''
}

function RoutineEditor({
  connection,
  profile,
  id,
  onClose
}: {
  connection: NonNullable<ReturnType<typeof usePrimaryConnection>>
  profile: string
  id: string
  onClose: () => void
}) {
  const theme = useTheme()
  // The badge sits inside a Card, so it takes the fill that differs from the Card's.
  const badgeFill = softFill(theme.colors, softFill(theme.colors, useSurface()))
  const gateway = useGateway(connection)
  const isNew = id === 'new'
  const routines = useRoutines(gateway, connection.id, profile)
  const mutations = useRoutineMutations(gateway, connection.id, profile)
  const createReminder = useCreateReminder(gateway, connection.id, profile)
  const [notice, setNotice] = useState<ReminderResult | null>(null)
  const runs = useRoutineRuns(gateway, connection.id, profile, isNew ? null : id)
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, [])

  const job: CronJob | null = isNew ? null : routines.data?.find(j => j.id === id) ?? null

  const [draft, setDraft] = useState<RoutineDraft>({ title: '', instruction: '', schedule: '' })
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)

  useEffect(() => {
    if (job && loadedFor !== job.id) {
      setDraft({ title: displayName(job, profile), instruction: job.prompt ?? '', schedule: job.schedule ?? '' })
      setLoadedFor(job.id)
    }
  }, [job, loadedFor, profile])

  const errors = validateRoutine(draft)
  // An edit makes the last create's notice stale: Save now sends something
  // else (or, edited back, the same request under the same id).
  const edit = (field: keyof RoutineDraft) => (text: string) => {
    setNotice(null)
    setDraft(d => ({ ...d, [field]: text }))
  }
  const toggleBusy = mutations.pause.isPending || mutations.resume.isPending
  const saveBusy = createReminder.isPending || mutations.update.isPending

  const onCreate = async () => {
    // One call per tap: an uncertain answer waits for the user, who may tap again (same request id).
    const result = await createReminder.mutateAsync({ draft, timezone: tz }).then(
      outcome => reminderResult(outcome, null),
      (err: unknown) => reminderResult(undefined, err)
    )
    if (result.kind === 'created') {
      onClose()
    } else {
      setNotice(result)
    }
  }

  const onSave = async () => {
    setSubmitted(true)
    if (Object.keys(errors).length > 0) {
      return
    }
    if (isNew) {
      await onCreate()
      return
    }
    try {
      if (job) {
        await mutations.update.mutateAsync({ job, d: draft })
      }
      onClose()
    } catch (err) {
      Alert.alert('Could not save', userMessage(err))
    }
  }

  const onToggleActive = async (value: boolean) => {
    if (!job) {
      return
    }
    try {
      if (value) {
        await mutations.resume.mutateAsync(job.id)
      } else {
        await mutations.pause.mutateAsync(job.id)
      }
    } catch (err) {
      Alert.alert('Could not update', userMessage(err))
    }
  }

  const onTestRun = async () => {
    if (!job) {
      return
    }
    try {
      await mutations.trigger.mutateAsync(job.id)
      Alert.alert('Test run started')
    } catch (err) {
      Alert.alert('Could not start test run', userMessage(err))
    }
  }

  const onDelete = () => {
    if (!job) {
      return
    }
    Alert.alert('Delete routine', `Delete "${displayName(job, profile)}"? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              await mutations.remove.mutateAsync(job.id)
              onClose()
            } catch (err) {
              Alert.alert('Could not delete', userMessage(err))
            }
          })()
        }
      }
    ])
  }

  const waitingForJob = !isNew && routines.isLoading
  const jobMissing = !isNew && !routines.isLoading && !job

  const runsSorted = [...(runs.data ?? [])].sort((a, b) => runTimeMs(b) - runTimeMs(a))

  return (
    <Sheet title={isNew ? 'New routine' : 'Routine'} onClose={onClose}>
      {waitingForJob ? (
        <ActivityIndicator style={styles.spinner} />
      ) : jobMissing ? (
        <Text style={[styles.line, { color: theme.colors.mutedForeground }]}>This routine could not be found.</Text>
      ) : (
        <>
          <Field
            label="Name"
            value={draft.title}
            onChangeText={edit('title')}
            placeholder="Morning briefing"
            error={submitted ? errors.title : undefined}
          />
          <Field
            label="Instruction"
            value={draft.instruction}
            onChangeText={edit('instruction')}
            placeholder="Summarize overnight messages and open loops."
            multiline
            error={submitted ? errors.instruction : undefined}
          />
          <Field
            label="Schedule"
            value={draft.schedule}
            onChangeText={edit('schedule')}
            placeholder="every day at 09:00, or 0 9 * * 1"
            error={submitted ? errors.schedule : undefined}
          />
          {/* Hermes interprets a schedule in the time zone it is configured for,
              and `cron.manage add` takes no per-job zone at the pin (cron/jobs.py
              `create_job`), so the input cannot promise the device's zone.
              `next_run` is an absolute instant, so it is still displayed here in
              the device's zone. */}
          <Text style={[styles.hint, { color: theme.colors.mutedForeground }]}>
            Times are read in the time zone Hermes is configured for, which may differ from this phone&apos;s.
          </Text>
          {job ? (
            <Text style={[styles.hint, { color: theme.colors.mutedForeground }]}>Next run: {nextRunLabel(job, new Date(), tz)} (shown in {tz})</Text>
          ) : null}

          {job ? (
            <View style={styles.switchWrap}>
              <SwitchRow
                label="Active"
                description={toggleBusy ? 'Applying…' : undefined}
                value={isActive(job)}
                onValueChange={v => void onToggleActive(v)}
                disabled={toggleBusy}
                accessibilityLabel="Active"
              />
            </View>
          ) : null}

          {notice && notice.kind !== 'created' ? (
            <Text style={[styles.hint, { color: notice.kind === 'uncertain' ? theme.colors.mutedForeground : theme.colors.destructive }]} accessibilityRole="alert">
              {notice.message}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <Button
              label={saveBusy ? 'Saving…' : notice?.kind === 'uncertain' ? 'Try again' : 'Save'}
              onPress={() => void onSave()}
              loading={saveBusy}
              accessibilityLabel="Save routine"
            />
            {job ? (
              <Button
                label="Test run"
                variant="secondary"
                loading={mutations.trigger.isPending}
                onPress={() => void onTestRun()}
                accessibilityLabel="Test run"
              />
            ) : null}
            {job ? (
              <Button
                label="Delete routine"
                variant="destructive"
                loading={mutations.remove.isPending}
                onPress={onDelete}
                accessibilityLabel="Delete routine"
              />
            ) : null}
          </View>

          {job ? (
            <View style={styles.history}>
              <Text style={[styles.sectionTitle, { color: theme.colors.foreground }]}>Run history</Text>
              {runs.isLoading ? <ActivityIndicator style={styles.spinner} /> : null}
              {runs.isError ? (
                <Text style={[styles.line, { color: theme.colors.destructive }]} accessibilityRole="alert">
                  {userMessage(runs.error)}
                </Text>
              ) : null}
              <Card>
                {runsSorted.map((run, i) => (
                  <View key={run.id ?? i} style={styles.runRow}>
                    <View style={styles.runTitleLine}>
                      <Text style={[styles.runWhen, { color: theme.colors.foreground }]}>{formatRunTime(run)}</Text>
                      {run.is_active ? (
                        <View style={[styles.runningBadge, { backgroundColor: badgeFill }]}>
                          <Text style={[styles.runningText, { color: theme.colors.mutedForeground }]}>Running</Text>
                        </View>
                      ) : null}
                    </View>
                    <Text style={[styles.runStatus, { color: theme.colors.mutedForeground }]}>{run.status ?? 'unknown'}</Text>
                    {firstLine(run) ? (
                      <Text style={[styles.runLine, { color: theme.colors.mutedForeground }]} numberOfLines={1}>
                        {firstLine(run)}
                      </Text>
                    ) : null}
                  </View>
                ))}
                {runs.isSuccess && runsSorted.length === 0 ? (
                  <View style={styles.runRow}>
                    <Text style={[styles.runStatus, { color: theme.colors.mutedForeground }]}>No runs yet.</Text>
                  </View>
                ) : null}
              </Card>
            </View>
          ) : null}
        </>
      )}
    </Sheet>
  )
}

const styles = StyleSheet.create({
  hint: { ...TYPE.footnote, lineHeight: LEADING.footnote, marginTop: 4 },
  switchWrap: { marginTop: 16 },
  actions: { marginTop: 20, gap: 10, marginBottom: 24 },
  history: { marginBottom: 40 },
  sectionTitle: { ...TYPE.headline, marginBottom: 8 },
  spinner: { marginVertical: 12 },
  line: { ...TYPE.callout, lineHeight: LEADING.callout, paddingVertical: 16, textAlign: 'center' },
  runRow: { minHeight: 44, paddingVertical: 10, paddingHorizontal: 16, gap: 2 },
  runTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  runWhen: { ...TYPE.calloutStrong },
  runStatus: { ...TYPE.footnote },
  runLine: { ...TYPE.footnote },
  runningBadge: { borderRadius: LEGACY_RADIUS.badge, paddingHorizontal: 6, paddingVertical: 2 },
  runningText: { ...TYPE.caption }
})
