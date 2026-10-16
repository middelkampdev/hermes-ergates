/**
 * The steps of a run that changes the plugin on a server (setup, update or
 * going back), one row each: an icon for how far the step got, and the one
 * spinner on the step that is going. Sits in a `Group`.
 */

import { ActivityIndicator } from 'react-native'

import { stepStatusWord, type StepStatus } from '@/features/server'

import { Group } from './Group'
import type { IconName } from './icons'
import { ListRow } from './ListRow'

// The active step keeps the open circle: its row shows the one spinner on the right. A skipped step gets a bare check, set apart from a step that ran.
const STEP_ICON: Record<StepStatus, IconName> = {
  pending: 'circle',
  active: 'circle',
  done: 'check-circle',
  skipped: 'check',
  failed: 'x-circle'
}

export interface StepListProps {
  steps: { label: string; status: StepStatus }[]
}

export function StepList({ steps }: StepListProps) {
  return (
    <Group>
      {steps.map(step => (
        <ListRow
          key={step.label}
          title={step.label}
          icon={STEP_ICON[step.status]}
          destructive={step.status === 'failed'}
          right={step.status === 'active' ? <ActivityIndicator accessibilityLabel={stepStatusWord('active')} /> : undefined}
          accessibilityLabel={`${step.label}, ${stepStatusWord(step.status)}`}
        />
      ))}
    </Group>
  )
}
