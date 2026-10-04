/**
 * The Components pages of the Design system: live samples of each shared
 * component in its states, with fixed sample text, one export per page.
 * Buttons do nothing; switches and fields keep their own local state.
 */

import { useState, type ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import type { ChatItem } from '@/features/chat'
import { useTheme } from '@/theme/provider'
import { ICON_SIZE, SIZE, SPACE, TYPE } from '@/theme/tokens'
import { Avatar } from '@/ui/Avatar'
import { Button } from '@/ui/Button'
import { Card } from '@/ui/Card'
import { AssistantBubble, UserBubble } from '@/ui/chat/Bubble'
import { Field } from '@/ui/Field'
import { Group } from '@/ui/Group'
import { IconButton } from '@/ui/IconButton'
import { Icon } from '@/ui/icons'
import { ListRow } from '@/ui/ListRow'
import { RowContent } from '@/ui/RowContent'
import { Toggle } from '@/ui/SwitchRow'

const noop = () => {}

const USER_SAMPLE: Extract<ChatItem, { kind: 'user' }> = {
  kind: 'user',
  id: 'sample-user',
  text: 'Can you summarize the release notes?',
  delivery: 'acknowledged'
}

const ASSISTANT_SAMPLE: Extract<ChatItem, { kind: 'assistant' }> = {
  kind: 'assistant',
  id: 'sample-assistant',
  text: 'Sure. The release adds **three** fixes and one new setting.'
}

function Sample({ children }: { children: ReactNode }) {
  return <View style={styles.sample}>{children}</View>
}

export function ButtonSamples() {
  return (
    <Sample>
      <Button label="Primary" onPress={noop} />
      <Button label="Secondary" variant="secondary" onPress={noop} />
      <Button label="Destructive" variant="destructive" onPress={noop} />
      <Button label="Ghost" variant="ghost" onPress={noop} />
      <Button label="Loading" loading onPress={noop} />
      <Button label="Disabled" disabled onPress={noop} />
    </Sample>
  )
}

export function IconButtonSamples() {
  return (
    <Sample>
      <View style={styles.inline}>
        <IconButton name="plus" accessibilityLabel="Icon button" onPress={noop} />
        <IconButton name="search" filled accessibilityLabel="Filled icon button" onPress={noop} />
        <IconButton name="trash-2" disabled accessibilityLabel="Disabled icon button" onPress={noop} />
      </View>
    </Sample>
  )
}

export function FieldSamples() {
  const [empty, setEmpty] = useState('')
  const [filled, setFilled] = useState('Ada Lovelace')
  const [invalid, setInvalid] = useState('not a url')
  const [notes, setNotes] = useState('A multiline field grows to its minimum height and wraps long text onto the next lines.')

  return (
    <Sample>
      <Field label="Empty" value={empty} onChangeText={setEmpty} placeholder="Placeholder" />
      <Field label="Filled" value={filled} onChangeText={setFilled} />
      <Field label="Error" value={invalid} onChangeText={setInvalid} error="Enter a full address, such as https://example.com." />
      <Field label="Multiline" value={notes} onChangeText={setNotes} multiline />
    </Sample>
  )
}

export function ListRowSamples() {
  const theme = useTheme()
  const [on, setOn] = useState(true)

  return (
    <Sample>
      <Group>
        <ListRow title="With icon" icon="star" />
        <ListRow title="With subtitle" subtitle="A second line in footnote" icon="file-text" />
        <ListRow title="Opens something" icon="folder" onPress={noop} />
        <ListRow title="With switch" icon="toggle-right" right={<Toggle value={on} onValueChange={setOn} accessibilityLabel="With switch" />} />
        <ListRow title="Checked" icon="droplet" selected right={<Icon name="check" size={ICON_SIZE.medium} color={theme.colors.primary} />} onPress={noop} />
        <ListRow title="Destructive" icon="trash-2" destructive onPress={noop} />
        <ListRow title="With error" subtitle="Subtitle" error="Something needs attention." icon="alert-circle" />
      </Group>
    </Sample>
  )
}

export function GroupSamples() {
  return (
    <Sample>
      <View style={styles.stack}>
        <Group caption="Caption" iconless>
          <ListRow title="Group with caption" />
          <ListRow title="Second row" />
        </Group>
        <Group iconless>
          <ListRow title="Group without caption" />
          <ListRow title="Second row" />
        </Group>
      </View>
    </Sample>
  )
}

/** The size steps an avatar can take: from `SIZE.extraSmall` up, because the smallest step is too small for initials. */
const AVATAR_SIZES = Object.entries(SIZE).filter(([, size]) => size >= SIZE.extraSmall)

export function AvatarSamples() {
  const theme = useTheme()

  return (
    <Sample>
      <View style={styles.avatars}>
        {AVATAR_SIZES.map(([name, size]) => (
          <View key={name} style={styles.avatar}>
            <Avatar name="Ada Lovelace" size={size} />
            <Text style={[styles.avatarLabel, { color: theme.colors.mutedForeground }]}>
              {name} {size}
            </Text>
          </View>
        ))}
      </View>
    </Sample>
  )
}

export function RowContentSample() {
  return (
    <Sample>
      <Card>
        <View style={styles.rowContent} accessible accessibilityLabel="Ada, Coder, 09:41, Unread: The build is green.">
          <RowContent name="Ada" avatar={<Avatar name="Ada" size={SIZE.large} />} role="Coder" time="09:41" preview="The build is green." unread />
        </View>
      </Card>
    </Sample>
  )
}

export function BubbleSamples() {
  return (
    <Sample>
      <UserBubble item={USER_SAMPLE} />
      <AssistantBubble item={ASSISTANT_SAMPLE} />
    </Sample>
  )
}

const styles = StyleSheet.create({
  stack: {
    gap: SPACE.huge
  },
  sample: {
    gap: SPACE.small
  },
  inline: {
    flexDirection: 'row',
    gap: SPACE.small
  },
  avatars: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    gap: SPACE.large
  },
  avatar: {
    alignItems: 'center',
    gap: SPACE.extraSmall
  },
  avatarLabel: {
    ...TYPE.caption
  },
  rowContent: {
    flexDirection: 'row',
    paddingHorizontal: SPACE.large,
    paddingVertical: SPACE.small
  }
})
