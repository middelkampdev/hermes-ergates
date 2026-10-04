import { useLocalSearchParams, useRouter } from 'expo-router'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View, type ListRenderItemInfo } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { devInjectFrames, peerKey, useChatSession, useProposals, type Line } from '@/features/chat'
import { attachDocument, attachImage, composeOutgoingText, pickDocument, pickImage, type PendingAttachment } from '@/features/files'
import { realSpeech, SPEECH_DISCLOSURE } from '@/features/voice'
import { userMessage } from '@/gateway/errors'
import { lightTap } from '@/lib/haptics'
import { useDeviceStore, draftKey } from '@/state/device-store'
import { useTheme } from '@/theme/provider'
import { ICON_SIZE, LEADING, RADIUS, RULE, SIZE, SPACE, TYPE } from '@/theme/tokens'
import { Avatar } from '@/ui/Avatar'
import { BotMessageBubble } from '@/ui/chat/BotMessageBubble'
import { AssistantBubble, StreamingBubble, UserBubble } from '@/ui/chat/Bubble'
import { ApprovalCard, ClarifyCard, type ClarifyDrafts } from '@/ui/chat/Cards'
import { Composer } from '@/ui/chat/Composer'
import { ExchangeRow } from '@/ui/chat/ExchangeRow'
import { NoticeRow } from '@/ui/chat/NoticeRow'
import { ProposalCard } from '@/ui/chat/ProposalCard'
import { PeerAvatar } from '@/ui/chat/PeerAvatar'
import { CommentaryRow, ConnectionLine, DateSeparator, EventRow, ToolRow, WorkingLine } from '@/ui/chat/Rows'
import { Icon } from '@/ui/icons'
import { IconButton } from '@/ui/IconButton'
import { usePagePadding } from '@/ui/Screen'
import { useBottomInset } from '@/ui/use-bottom-inset'
import { useFontScaleKey, useOnFontScaleChange } from '@/ui/use-font-scale-key'

export default function ChatScreen() {
  const { profile, devSend, devFocus, devInject } = useLocalSearchParams<{ profile: string; devSend?: string; devFocus?: string; devInject?: string }>()
  if (!profile) {
    return null
  }
  // The connection and the session come from `_layout.tsx`; only the route
  // params are read here.
  return <Chat devSend={__DEV__ ? devSend : undefined} devInject={__DEV__ ? devInject : undefined} devFocus={__DEV__ && devFocus === '1'} />
}

function Chat({ devSend, devInject, devFocus }: { devSend?: string; devInject?: string; devFocus?: boolean }) {
  const theme = useTheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const fontScaleKey = useFontScaleKey()
  // The composer is a fixed bottom bar: it pads its own content by the
  // inset, dropped while the keyboard is open (the KeyboardAvoidingView
  // below already pushes it up by the full keyboard height, measured down
  // to the physical bottom of the screen, so counting the inset again would
  // leave a gap above the keyboard).
  const composerBottomInset = useBottomInset()
  const gutter = usePagePadding()
  // The layout owns the session: the chat, Activity and the transcript all read this one.
  const { connectionId, profile, port: gateway, bot, name, avatarUri, session, timeline } = useChatSession()

  const draft = useDeviceStore(s => s.drafts[draftKey(connectionId, profile)] ?? '')
  const setDraft = useDeviceStore(s => s.setDraft)
  const clearDraft = useDeviceStore(s => s.clearDraft)
  const markRead = useDeviceStore(s => s.markRead)
  const haptics = useDeviceStore(s => s.prefs.haptics)
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [recording, setRecording] = useState(false)
  const [interim, setInterim] = useState('')
  const [showDisclosure, setShowDisclosure] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  // The content remounts at the newest line on a text-size change, where the jump button has nothing to do.
  useOnFontScaleChange(() => setAtBottom(true))
  const [clarifyDrafts] = useState<ClarifyDrafts>(() => new Map())
  const listRef = useRef<FlatList<Line>>(null)

  useEffect(() => {
    markRead(connectionId, profile, Date.now())
  }, [connectionId, profile, markRead, session.state.items.length])

  // Development smoke-test hook: `?devSend=<text>` sends one message once the chat is ready (dev bundles only).
  const devSentRef = useRef(false)
  useEffect(() => {
    if (__DEV__ && devSend && session.phase === 'ready' && !devSentRef.current) {
      devSentRef.current = true
      void session.send(devSend)
    }
  }, [devSend, session.phase, session])

  // Development screenshot hook: `?devInject=<scenario>` feeds one named set of
  // synthetic frames through the normal event path once the chat is ready, so
  // the simulator pass can capture outcomes the local backend cannot produce on
  // demand. Dev bundles only; the frames themselves live in `dev-inject.ts`.
  const devInjectedRef = useRef(false)
  useEffect(() => {
    if (!__DEV__ || !devInject || session.phase !== 'ready' || devInjectedRef.current) {
      return
    }
    devInjectedRef.current = true
    for (const frame of devInjectFrames(devInject)) {
      session.devInjectEvent(frame)
    }
  }, [devInject, session.phase, session])

  const liveId = session.state.liveSessionId
  // Agent proposals sit under the newest message until they are answered (docs/11 section 4.1).
  const proposals = useProposals()
  const openAgentChat = useCallback((target: string) => router.push({ pathname: '/chat/[profile]', params: { profile: target } }), [router])

  // The timeline is the only producer of lines (spec 5.9); the screen reverses
  // it for the inverted list and renders one component per kind.
  const lines = useMemo<Line[]>(() => [...timeline.lines].reverse(), [timeline.lines])

  // Approval/clarify answers reject (unlike `send`, which never throws), so
  // every call site goes through this instead of `void`-ing the promise: a
  // dropped socket used to look exactly like an un-tapped card. No
  // automatic retry — ADR-027 keeps retries an explicit tap.
  const runWithAlert = useCallback((title: string, fn: () => Promise<unknown>) => {
    void fn().catch(err => Alert.alert(title, userMessage(err)))
  }, [])

  /** Inverted list: offset 0 is the newest row. */
  const scrollToLatest = useCallback(() => listRef.current?.scrollToOffset({ offset: 0, animated: true }), [])

  const send = useCallback(async () => {
    const text = composeOutgoingText(draft, attachments)
    if (!text) {
      return
    }
    clearDraft(connectionId, profile)
    setAttachments([])
    lightTap(haptics)
    const sent = session.send(text)
    // The new bubble and the working line are inserted at the bottom; a send
    // always reveals them, wherever the list was scrolled.
    scrollToLatest()
    await sent
  }, [draft, attachments, clearDraft, connectionId, profile, session, haptics, scrollToLatest])

  // A turn that starts while the reader is at the bottom (a routine, a queued
  // send, a reconnect) reveals the working line too; readers who scrolled up
  // keep their place and get the jump-to-latest control instead (docs/10).
  const wasStreamingRef = useRef(false)
  useEffect(() => {
    const streaming = session.state.live.streaming
    if (streaming && !wasStreamingRef.current && atBottom) {
      scrollToLatest()
    }
    wasStreamingRef.current = streaming
  }, [session.state.live.streaming, atBottom, scrollToLatest])

  const attach = useCallback(() => {
    if (!liveId) {
      return
    }
    Alert.alert('Attach', undefined, [
      {
        text: 'Photo',
        onPress: async () => {
          try {
            const picked = await pickImage()
            if (!picked) {
              return
            }
            const pending: PendingAttachment = { id: `p-${Date.now()}`, kind: 'image', name: picked.name, bytes: picked.bytes, previewUri: picked.previewUri, state: 'attaching' }
            setAttachments(a => [...a, pending])
            const result = await attachImage(gateway, liveId, picked)
            setAttachments(a => a.map(x => (x.id === pending.id ? result : x)))
          } catch (err) {
            Alert.alert('Could not attach', userMessage(err))
          }
        }
      },
      {
        text: 'File',
        onPress: async () => {
          try {
            const picked = await pickDocument()
            if (!picked) {
              return
            }
            const pending: PendingAttachment = { id: `p-${Date.now()}`, kind: 'file', name: picked.name, bytes: picked.bytes, state: 'attaching' }
            setAttachments(a => [...a, pending])
            const result = await attachDocument(gateway, liveId, picked)
            setAttachments(a => a.map(x => (x.id === pending.id ? result : x)))
          } catch (err) {
            Alert.alert('Could not attach', userMessage(err))
          }
        }
      },
      { text: 'Cancel', style: 'cancel' }
    ])
  }, [gateway, liveId])

  const micStart = useCallback(async () => {
    if (!(await realSpeech.available())) {
      Alert.alert('Voice input is not available on this device.')
      return
    }
    if (!(await realSpeech.requestPermission())) {
      Alert.alert('Microphone or speech permission was not allowed.')
      return
    }
    if (!realSpeech.onDevice()) {
      setShowDisclosure(true)
    }
    setInterim('')
    setRecording(true)
    await realSpeech.start({
      lang: 'en-US',
      onInterim: setInterim,
      onFinal: text => {
        // Read the draft as it is now: the callback handed to `start` is frozen
        // at that moment, so a captured `draft` dropped earlier results and
        // anything typed after the mic began.
        const current = useDeviceStore.getState().drafts[draftKey(connectionId, profile)] ?? ''
        setDraft(connectionId, profile, [current.trim(), text.trim()].filter(Boolean).join(' '))
        setInterim('')
      },
      onError: message => {
        setRecording(false)
        Alert.alert('Voice input failed', message)
      },
      onEnd: () => setRecording(false)
    })
  }, [connectionId, profile, setDraft])

  // Leaving the chat must stop the microphone: nothing else cancels it, so the
  // recognizer kept listening after Back with no visible indicator.
  useEffect(
    () => () => {
      // Leaving the chat must never leave the microphone open; a failed module load is not an error here.
      void Promise.resolve(realSpeech.cancel()).catch(() => undefined)
    },
    []
  )

  const openActivity = useCallback(() => router.push({ pathname: '/chat/[profile]/activity', params: { profile } }), [router, profile])

  const renderLine = useCallback(
    ({ item: line }: ListRenderItemInfo<Line>) => {
      switch (line.kind) {
        case 'date':
          return <DateSeparator label={line.label} />
        case 'stream':
          return <StreamingBubble text={session.state.live.assistantText} />
        case 'working':
          return <WorkingLine text={line.text} onStop={() => void session.stop()} />
        case 'state':
          return <Text style={[styles.state, { color: theme.colors.mutedForeground }]}>{line.text}</Text>
        case 'bot_message':
          return <BotMessageBubble name={line.peer.display.name} text={line.item.text} label={line.label} avatar={<PeerAvatar peer={line.peer} size={SIZE.small} connectionId={connectionId} />} />
        case 'exchange':
          return (
            <ExchangeRow
              text={line.text}
              label={line.label}
              openable={line.openable}
              marked={line.marked}
              avatar={<PeerAvatar peer={line.exchange.peer} size={SIZE.extraSmall} connectionId={connectionId} />}
              onPress={() =>
                router.push({
                  pathname: '/chat/[profile]/exchange',
                  params: {
                    profile,
                    peer: peerKey(line.exchange.peer),
                    anchorRowId: String(line.exchange.anchor.rowId ?? ''),
                    anchorToolCallId: line.exchange.anchor.toolCallId ?? ''
                  }
                })
              }
            />
          )
        case 'notice':
          return <NoticeRow text={line.text} label={line.label} onPress={openActivity} />
        case 'tool':
          return <ToolRow item={line.item} text={line.label} label={line.label} onPress={openActivity} />
        case 'item': {
          const item = line.item
          switch (item.kind) {
            case 'user':
              return <UserBubble item={item} onRetry={id => void session.retry(id)} />
            case 'assistant':
              return <AssistantBubble item={item} />
            case 'commentary':
              return <CommentaryRow text={item.text} />
            case 'event':
              return <EventRow text={item.text} />
            case 'clarify':
              return (
                <ClarifyCard
                  item={item}
                  drafts={clarifyDrafts}
                  onAnswer={answers => runWithAlert('Could not send your answer', () => session.answerClarify(item.requestId, answers))}
                  onDismiss={text => runWithAlert('Could not send your answer', () => session.dismissClarify(item.requestId, text))}
                />
              )
            case 'approval':
              return <ApprovalCard item={item} onChoose={choice => runWithAlert('Could not send your decision', () => session.answerApproval(item.requestId, choice))} />
            default:
              return null
          }
        }
        default:
          return null
      }
    },
    [profile, connectionId, router, session, runWithAlert, openActivity, clarifyDrafts, theme.colors.mutedForeground]
  )

  return (
    <View key={fontScaleKey} style={[styles.screen, { backgroundColor: theme.colors.background, paddingTop: insets.top }]}>
      <View style={[styles.header, { paddingHorizontal: gutter, borderBottomColor: theme.colors.border, backgroundColor: theme.colors.background }]}>
        {/* A chat opened from a push notification has nothing beneath it: Back goes Home. */}
        <IconButton name="chevron-left" accessibilityLabel="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <Pressable onPress={() => router.push({ pathname: '/agent/[profile]', params: { profile } })} accessibilityRole="button" accessibilityLabel={`${name}, details`} style={[styles.identity, { borderColor: theme.colors.border, backgroundColor: theme.colors.popover }]}>
          <Avatar name={name} color={bot?.color} imageUri={avatarUri} size={SIZE.small} />
          <Text style={[styles.name, { color: theme.colors.foreground }]} numberOfLines={1}>
            {name}
          </Text>
        </Pressable>
        <View style={styles.spacer} />
        {timeline.hasActivity ? <IconButton name="activity" accessibilityLabel="Activity" onPress={openActivity} /> : null}
      </View>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={0}>
        <ConnectionLine state={session.state.connection} />
        {session.phase === 'error' ? (
          <View style={styles.center}>
            <Text style={[styles.error, { color: theme.colors.destructive }]}>{session.openError}</Text>
          </View>
        ) : null}
        {session.needsReauth ? (
          <Pressable onPress={() => router.push('/settings')} accessibilityRole="button" accessibilityLabel="Sign in again" style={[styles.errorLine, { backgroundColor: theme.colors.muted }]}>
            <Text style={[styles.errorText, { color: theme.colors.destructive }]}>
              {session.connectionError ?? 'Sign-in required.'} Tap to sign in again.
            </Text>
          </Pressable>
        ) : null}
        {session.state.lastError ? (
          <Pressable onPress={session.clearError} accessibilityRole="button" accessibilityLabel="Dismiss error" style={[styles.errorLine, { backgroundColor: theme.colors.muted }]}>
            <Text style={[styles.errorText, { color: theme.colors.destructive }]} numberOfLines={3}>
              {session.state.lastError}
            </Text>
          </Pressable>
        ) : null}
        <FlatList
          ref={listRef}
          inverted
          data={lines}
          keyExtractor={l => l.key}
          renderItem={renderLine}
          // The inverted list draws its header at the bottom, under the newest line.
          ListHeaderComponent={
            proposals.length > 0 ? (
              <View>
                {proposals.map(p => (
                  <ProposalCard key={p.proposal_id} proposal={p} onOpenChat={openAgentChat} />
                ))}
              </View>
            ) : null
          }
          contentContainerStyle={[styles.list, { paddingHorizontal: gutter }]}
          onScroll={e => setAtBottom(e.nativeEvent.contentOffset.y < 40)}
          scrollEventThrottle={100}
          keyboardDismissMode="interactive"
          // Keep the reader's place when rows arrive or regroup (an exchange row
          // replacing its tool row, a merged run), except near the bottom, where
          // the list follows new output (streamed deltas, the working line).
          maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 120 }}
        />
        {!atBottom ? (
          <Pressable onPress={() => listRef.current?.scrollToOffset({ offset: 0, animated: true })} accessibilityRole="button" accessibilityLabel="Jump to latest" style={[styles.jump, { backgroundColor: theme.colors.popover, borderColor: theme.colors.border }]}>
            <Icon name="arrow-down" size={ICON_SIZE.small} color={theme.colors.foreground} />
          </Pressable>
        ) : null}
        <View style={[styles.composer, { paddingHorizontal: gutter, paddingBottom: Math.max(composerBottomInset, SPACE.small) }]}>
          <Composer
            name={name}
            value={draft}
            onChangeText={t => setDraft(connectionId, profile, t)}
            onSend={() => void send()}
            onAttach={attach}
            onMicStart={() => void micStart()}
            onMicStop={() => realSpeech.stop()}
            onMicCancel={() => {
              realSpeech.cancel()
              setRecording(false)
            }}
            recording={recording}
            interim={interim}
            attachments={attachments}
            onRemoveAttachment={id => setAttachments(a => a.filter(x => x.id !== id))}
            disabled={session.phase !== 'ready'}
            autoFocus={devFocus}
            disclosure={showDisclosure ? SPEECH_DISCLOSURE : null}
          />
        </View>
      </KeyboardAvoidingView>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: SPACE.small, minHeight: SIZE.large, paddingBottom: SPACE.small, borderBottomWidth: StyleSheet.hairlineWidth },
  identity: { flexDirection: 'row', alignItems: 'center', gap: SPACE.small, borderWidth: 1, borderRadius: RADIUS.full, paddingVertical: SPACE.extraSmall, paddingLeft: SPACE.extraSmall, paddingRight: SPACE.medium, minHeight: RULE.touch, maxWidth: '70%' },
  name: { ...TYPE.bodyStrong, flexShrink: 1 },
  spacer: { flex: 1 },
  list: { paddingVertical: SPACE.extraLarge },
  center: { padding: SPACE.extraLarge },
  error: { ...TYPE.callout, lineHeight: LEADING.callout, textAlign: 'center' },
  errorLine: { marginHorizontal: SPACE.extraLarge, marginTop: SPACE.extraSmall, padding: SPACE.small, borderRadius: RADIUS.medium },
  errorText: { ...TYPE.footnote, lineHeight: LEADING.footnote },
  state: { ...TYPE.footnote, lineHeight: LEADING.footnote, textAlign: 'center', marginVertical: SPACE.small },
  jump: { position: 'absolute', right: SPACE.extraLarge, bottom: RULE.floatingBottom, width: RULE.touch, height: RULE.touch, borderRadius: RULE.touch / 2, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  composer: { paddingTop: SPACE.extraSmall }
})
