/**
 * Finish on your server: the one page for every case where the user has to
 * act on the server. It shows what to do (a command to copy, how to restart
 * Hermes, or what to update), asks the server every few seconds, and
 * finishes the setup by itself when the plugin answers. Reached from the
 * setup screen and after Sign in again.
 *
 * A thin renderer: the cases, the text, the command and the buttons come from
 * `finishVariant` and `finishView` in `src/features/server/finish-view.ts`.
 */

import { useQueryClient } from '@tanstack/react-query'
import * as Clipboard from 'expo-clipboard'
import { Redirect, useIsFocused, useRouter } from 'expo-router'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Linking, Platform, StyleSheet, Text, View } from 'react-native'

import {
  finishPendingSetup,
  finishVariant,
  finishView,
  isSignedOut,
  lastManualOutcome,
  markPendingSetup,
  pendingCommit,
  RESTART_HEADING,
  serverCheckKey,
  setupProblem,
  useServerCheck,
  type FinishAction,
  type FinishVariant,
  type SetupProgress
} from '@/features/server'
import { usePrimaryConnection } from '@/features/settings'
import { useGateway } from '@/gateway/registry'
import { buildRecord } from '@/lib/build-info'
import type { Connection } from '@/state/device-store'
import { useTheme } from '@/theme/provider'
import { LEADING, RADIUS, SPACE, TYPE } from '@/theme/tokens'
import { Button } from '@/ui/Button'
import { Page } from '@/ui/Page'

const MONOSPACE = Platform.select({ ios: 'Menlo', default: 'monospace' })

export default function FinishOnServerScreen() {
  const connection = usePrimaryConnection()
  if (!connection) {
    return <Redirect href="/connect" />
  }
  return <FinishOnServer connection={connection} />
}

function FinishOnServer({ connection }: { connection: Connection }) {
  const theme = useTheme()
  const router = useRouter()
  const queryClient = useQueryClient()
  const gateway = useGateway(connection)
  const build = useMemo(() => buildRecord(), [])
  // Why the install is by hand comes from the run that ended that way, not from the route: the text of a route is anyone's to write.
  const [manual] = useState(() => lastManualOutcome(connection.id))
  const focused = useIsFocused()
  // True once the plugin answered and its setup went through: nothing is left to wait for.
  const [finished, setFinished] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  // The setup call outlives this screen; only a mounted screen draws what it reports.
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Polls while this screen is in view and something is left to wait for; the check stops by itself once the server refuses the session.
  const check = useServerCheck(connection, build, { poll: focused && !finished })
  const data = check.data
  // A 401 wins over the old data the query still holds, or the page would keep asking for a restart that already happened.
  const signedOut = isSignedOut(check.error)

  // The variant follows the server, except when a check names none (ready, or one poll that could not reach it): the page then stays as it was.
  const live = useMemo(() => finishVariant(data ?? null, manual), [data, manual])
  const [held, setHeld] = useState<FinishVariant | null>(live)
  if (live !== null && live !== held) {
    setHeld(live)
  }
  const variant = live ?? held

  // Once the plugin answers its setup runs. Record that as soon as the server said it is missing, off or outdated, so a closed app or a restart in between does not skip it.
  const commit = pendingCommit(data ?? null, build)
  useEffect(() => {
    if (commit !== null) {
      markPendingSetup(connection.id, commit)
    }
  }, [commit, connection.id])

  // Each ready poll tries again until the setup went through: `dataUpdatedAt` moves with every poll, while the data stays the same object.
  useEffect(() => {
    if (data?.kind !== 'ready' || finished || signedOut) {
      return
    }
    finishPendingSetup(gateway, connection, data).then(
      () => {
        // Home and the other screens read the same check: make them see the finished setup.
        void queryClient.invalidateQueries({ queryKey: serverCheckKey(connection.id) })
        if (mounted.current) {
          setProblem(null)
          setFinished(true)
        }
      },
      (error: unknown) => {
        if (isSignedOut(error)) {
          // The session ended while the setup ran: the check says so too, and shows Sign in again.
          void queryClient.invalidateQueries({ queryKey: serverCheckKey(connection.id) })
        }
        if (mounted.current) {
          setProblem(setupProblem(error))
        }
      }
    )
  }, [data, check.dataUpdatedAt, finished, signedOut, gateway, connection, queryClient])

  const setup: SetupProgress = finished ? { state: 'done' } : problem === null ? { state: 'pending' } : { state: 'failed', message: problem }
  const view = finishView(variant, build, signedOut ? 'sign_in' : (data ?? null), setup)

  const recheck = async () => {
    setChecking(true)
    await check.refetch()
    if (mounted.current) {
      setChecking(false)
    }
  }

  const act = (action: FinishAction) => {
    switch (action) {
      case 'check':
        void recheck()
        return
      case 'done':
        // Home is under this screen when it was pushed from there, and not when Sign in replaced into it.
        router.dismissTo('/')
        return
      case 'sign_in':
        router.push({ pathname: '/sign-in', params: { connection: connection.id } })
        return
    }
  }

  const openGuide = () => {
    Linking.openURL(view.guide.url).catch(() => Alert.alert('Could not open the guide', view.guide.url))
  }

  const { command } = view
  return (
    <Page
      title={view.title}
      onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      footer={<Button label={view.primary.label} onPress={() => act(view.primary.action)} loading={view.primary.action === 'check' && checking} />}
    >
      {view.intro.length > 0 ? (
        <View style={styles.text}>
          {view.intro.map(paragraph => (
            <Text key={paragraph} style={[styles.paragraph, { color: theme.colors.foreground }]}>
              {paragraph}
            </Text>
          ))}
        </View>
      ) : null}
      {command ? (
        <View style={styles.text}>
          <View style={[styles.command, { backgroundColor: theme.colors.muted }]}>
            <Text selectable style={[styles.commandText, { color: theme.colors.foreground }]}>
              {command}
            </Text>
          </View>
          <Button label="Copy" variant="secondary" onPress={() => void Clipboard.setStringAsync(command)} />
        </View>
      ) : null}
      {view.restartLines ? (
        <View style={styles.text}>
          <Text style={[styles.heading, { color: theme.colors.foreground }]}>{RESTART_HEADING}</Text>
          {view.restartLines.map(line => (
            <Text key={line} selectable style={[styles.line, { color: theme.colors.foreground }]}>
              {line}
            </Text>
          ))}
        </View>
      ) : null}
      <Text accessibilityLiveRegion="polite" style={view.done ? [styles.ready, { color: theme.colors.foreground }] : [styles.status, { color: theme.colors.mutedForeground }]}>
        {view.status}
      </Text>
      {view.done ? null : <Button label={view.guide.label} variant="secondary" onPress={openGuide} />}
    </Page>
  )
}

const styles = StyleSheet.create({
  text: { gap: SPACE.medium },
  paragraph: { ...TYPE.body, lineHeight: LEADING.body },
  command: { padding: SPACE.medium, borderRadius: RADIUS.medium },
  commandText: { ...TYPE.callout, fontFamily: MONOSPACE, lineHeight: LEADING.callout },
  heading: { ...TYPE.bodyStrong, lineHeight: LEADING.body },
  line: { ...TYPE.callout, lineHeight: LEADING.callout },
  status: { ...TYPE.callout, lineHeight: LEADING.callout },
  ready: { ...TYPE.bodyStrong, lineHeight: LEADING.body }
})
