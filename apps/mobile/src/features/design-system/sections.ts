import type { MobileTheme } from '@/theme/tokens'

import { colorSwatches, contrastRows, shapeRows, typeRows } from './specimen'

export type SectionId =
  | 'colors'
  | 'contrast'
  | 'type'
  | 'shape'
  | 'button'
  | 'icon-button'
  | 'field'
  | 'list-row'
  | 'group'
  | 'avatar'
  | 'row-body'
  | 'bubble'

export interface DesignSystemSection {
  id: SectionId
  title: string
  group: 'foundations' | 'components'
}

/** The Design system page's index: the foundations, then the components, each opening its own page. */
export const DESIGN_SYSTEM_SECTIONS: readonly DesignSystemSection[] = [
  { id: 'colors', title: 'Colors', group: 'foundations' },
  { id: 'contrast', title: 'Contrast', group: 'foundations' },
  { id: 'type', title: 'Type', group: 'foundations' },
  { id: 'shape', title: 'Space and shape', group: 'foundations' },
  { id: 'button', title: 'Button', group: 'components' },
  { id: 'icon-button', title: 'Icon button', group: 'components' },
  { id: 'field', title: 'Field', group: 'components' },
  { id: 'list-row', title: 'List row', group: 'components' },
  { id: 'group', title: 'Group', group: 'components' },
  { id: 'avatar', title: 'Avatar', group: 'components' },
  { id: 'row-body', title: 'Row body', group: 'components' },
  { id: 'bubble', title: 'Bubble', group: 'components' }
]

const COMPONENT_DESCRIPTIONS: Partial<Record<SectionId, string>> = {
  button: 'Primary, secondary, destructive, ghost',
  'icon-button': 'Plain, filled, disabled',
  field: 'Empty, filled, error, multiline',
  'list-row': 'Icon, subtitle, chevron, switch, check',
  group: 'With and without caption',
  avatar: 'Every avatar size',
  'row-body': 'The Home and Search row',
  bubble: 'User and assistant'
}

export function sectionById(id: string | undefined): DesignSystemSection | undefined {
  return DESIGN_SYSTEM_SECTIONS.find(s => s.id === id)
}

/** One line for the index row: counts for the foundations (with the contrast pairs below AA), a description for a component. */
export function sectionSummary(id: SectionId, colors: MobileTheme['colors']): string {
  switch (id) {
    case 'colors':
      return `${colorSwatches(colors).length} tokens`
    case 'contrast': {
      const rows = contrastRows(colors)
      // An unparseable color cannot be shown to pass, so it counts as below AA.
      const below = rows.filter(r => r.rating === null || r.rating === 'Fail' || r.rating === 'AA large').length
      return `${rows.length} pairs · ${below === 0 ? 'all pass AA' : `${below} below AA`}`
    }
    case 'type':
      return `${typeRows().length} styles`
    case 'shape': {
      const shapes = shapeRows()
      return `${shapes.space.length} space · ${shapes.radius.length} radius · ${shapes.size.length} size`
    }
    default:
      return COMPONENT_DESCRIPTIONS[id] ?? ''
  }
}
