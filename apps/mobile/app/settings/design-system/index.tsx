/**
 * The Design system index: the preview controls, then the Foundations and
 * the Components, each row with a one-line summary and opening its own page.
 */

import { useRouter } from 'expo-router'
import React from 'react'

import { DESIGN_SYSTEM_SECTIONS, sectionSummary, type DesignSystemSection, type SectionId } from '@/features/design-system'
import { APPEARANCE_LABELS } from '@/features/settings'
import { useTheme } from '@/theme/provider'
import { SECTION_ICONS, useDesignSystemPreview } from '@/ui/design-system'
import { Group } from '@/ui/Group'
import { ListRow } from '@/ui/ListRow'
import { Page } from '@/ui/Page'

const GROUPS: { group: DesignSystemSection['group']; caption: string }[] = [
  { group: 'foundations', caption: 'Foundations' },
  { group: 'components', caption: 'Components' }
]

export default function DesignSystemIndex() {
  const router = useRouter()
  const theme = useTheme()
  const preview = useDesignSystemPreview()
  const open = (section: SectionId) => router.push({ pathname: '/settings/design-system/[section]', params: { section } })

  return (
    <Page title="Design system" onBack={() => router.back()}>
      <Group caption="Preview">
        <ListRow title="Mode" subtitle={APPEARANCE_LABELS[preview.appearance]} icon="sun" onPress={preview.nextMode} />
        <ListRow title="Theme" subtitle={preview.themeLabel} icon="droplet" onPress={preview.nextTheme} />
        <ListRow title="Reset" subtitle="Back to the saved Appearance" icon="rotate-ccw" onPress={preview.reset} />
      </Group>
      {GROUPS.map(({ group, caption }) => (
        <Group key={group} caption={caption}>
          {DESIGN_SYSTEM_SECTIONS.filter(s => s.group === group).map(s => (
            <ListRow key={s.id} title={s.title} subtitle={sectionSummary(s.id, theme.colors)} icon={SECTION_ICONS[s.id]} onPress={() => open(s.id)} />
          ))}
        </Group>
      ))}
    </Page>
  )
}
