/**
 * The Components part of the Design system page: live samples of every
 * shared component in its states, with fixed sample text. Buttons do
 * nothing; switches and fields keep their own local state.
 */

import { useState, type ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import type { ChatItem } from '@/features/chat'
import { useTheme } from '@/theme/provider'
import { AVATAR, ICON, TYPE } from '@/theme/tokens'
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

function Sample({ caption, children }: { caption: string; children: ReactNode }) {
  const theme = useTheme()

  return (
    <View style={styles.sample}>
      <Text style={[styles.caption, { color: theme.colors.mutedForeground }]}>{caption}</Text>
      {children}
    </View>
  )
}

function ButtonSamples() {
  return (
    <Sample caption="Button">
      <Button label="Primary" onPress={noop} />
      <Button label="Secondary" variant="secondary" onPress={noop} />
      <Button label="Destructive" variant="destructive" onPress={noop} />
      <Button label="Ghost" variant="ghost" onPress={noop} />
      <Button label="Loading" loading onPress={noop} />
      <Button label="Disabled" disabled onPress={noop} />
    </Sample>
  )
}

function IconButtonSamples() {
  return (
    <Sample caption="Icon button">
      <View style={styles.inline}>
        <IconButton name="plus" accessibilityLabel="Icon button" onPress={noop} />
        <IconButton name="search" filled accessibilityLabel="Filled icon button" onPress={noop} />
        <IconButton name="trash-2" disabled accessibilityLabel="Disabled icon button" onPress={noop} />
      </View>
    </Sample>
  )
}

function FieldSamples() {
  const [empty, setEmpty] = useState('')
  const [filled, setFilled] = useState('Ada Lovelace')
  const [invalid, setInvalid] = useState('not a url')
  const [notes, setNotes] = useState('A multiline field grows to its minimum height and wraps long text onto the next lines.')

  return (
    <Sample caption="Field">
      <Field label="Empty" value={empty} onChangeText={setEmpty} placeholder="Placeholder" />
      <Field label="Filled" value={filled} onChangeText={setFilled} />
      <Field label="Error" value={invalid} onChangeText={setInvalid} error="Enter a full address, such as https://example.com." />
      <Field label="Multiline" value={notes} onChangeText={setNotes} multiline />
    </Sample>
  )
}

function ListRowSamples() {
  const theme = useTheme()
  const [on, setOn] = useState(true)

  return (
    <Sample caption="List row">
      <Group>
        <ListRow title="With icon" icon="star" />
        <ListRow title="With subtitle" subtitle="A second line in footnote" icon="file-text" />
        <ListRow title="Opens something" icon="folder" onPress={noop} />
        <ListRow title="With switch" icon="toggle-right" right={<Toggle value={on} onValueChange={setOn} accessibilityLabel="With switch" />} />
        <ListRow title="Checked" icon="droplet" selected right={<Icon name="check" size={ICON.row} color={theme.colors.primary} />} onPress={noop} />
        <ListRow title="Destructive" icon="trash-2" destructive onPress={noop} />
        <ListRow title="With error" subtitle="Subtitle" error="Something needs attention." icon="alert-circle" />
      </Group>
    </Sample>
  )
}

function GroupSamples() {
  return (
    <Sample caption="Group">
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

function AvatarSamples() {
  const theme = useTheme()

  return (
    <Sample caption="Avatar">
      <View style={styles.avatars}>
        {Object.entries(AVATAR).map(([name, size]) => (
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

function RowContentSample() {
  return (
    <Sample caption="Row body">
      <Card>
        <View style={styles.rowContent} accessible accessibilityLabel="Ada, Coder, 09:41, Unread: The build is green.">
          <RowContent name="Ada" avatar={<Avatar name="Ada" size={AVATAR.list} />} role="Coder" time="09:41" preview="The build is green." unread />
        </View>
      </Card>
    </Sample>
  )
}

function BubbleSamples() {
  return (
    <Sample caption="Bubble">
      <UserBubble item={USER_SAMPLE} />
      <AssistantBubble item={ASSISTANT_SAMPLE} />
    </Sample>
  )
}

export function ComponentSamples() {
  const theme = useTheme()

  return (
    <View style={styles.stack}>
      <Text accessibilityRole="header" style={[styles.heading, { color: theme.colors.foreground }]}>
        Components
      </Text>
      <ButtonSamples />
      <IconButtonSamples />
      <FieldSamples />
      <ListRowSamples />
      <GroupSamples />
      <AvatarSamples />
      <RowContentSample />
      <BubbleSamples />
    </View>
  )
}

const styles = StyleSheet.create({
  stack: {
    gap: 24
  },
  heading: {
    ...TYPE.headline,
    paddingHorizontal: 4
  },
  sample: {
    gap: 8
  },
  caption: {
    ...TYPE.footnote,
    paddingHorizontal: 4
  },
  inline: {
    flexDirection: 'row',
    gap: 8
  },
  avatars: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    gap: 16
  },
  avatar: {
    alignItems: 'center',
    gap: 4
  },
  avatarLabel: {
    ...TYPE.caption
  },
  rowContent: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 10
  }
})
