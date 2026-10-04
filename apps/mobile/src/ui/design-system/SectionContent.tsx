/**
 * What each Design system section page shows, and the line icon its row has
 * on the index. The section list itself is `DESIGN_SYSTEM_SECTIONS`.
 */

import type { SectionId } from '@/features/design-system'

import type { IconName } from '../icons'
import {
  AvatarSamples,
  BubbleSamples,
  ButtonSamples,
  FieldSamples,
  GroupSamples,
  IconButtonSamples,
  ListRowSamples,
  RowContentSample
} from './ComponentSamples'
import { ColorSamples, ContrastSamples, ShapeSamples, TypeSamples } from './FoundationSamples'

export const SECTION_ICONS: Record<SectionId, IconName> = {
  colors: 'aperture',
  contrast: 'eye',
  type: 'type',
  shape: 'grid',
  button: 'square',
  'icon-button': 'plus-circle',
  field: 'edit-3',
  'list-row': 'list',
  group: 'layers',
  avatar: 'user',
  'row-body': 'message-square',
  bubble: 'message-circle'
}

const SECTION_CONTENT: Record<SectionId, () => React.JSX.Element> = {
  colors: ColorSamples,
  contrast: ContrastSamples,
  type: TypeSamples,
  shape: ShapeSamples,
  button: ButtonSamples,
  'icon-button': IconButtonSamples,
  field: FieldSamples,
  'list-row': ListRowSamples,
  group: GroupSamples,
  avatar: AvatarSamples,
  'row-body': RowContentSample,
  bubble: BubbleSamples
}

export function SectionContent({ id }: { id: SectionId }) {
  const Content = SECTION_CONTENT[id]
  return <Content />
}
