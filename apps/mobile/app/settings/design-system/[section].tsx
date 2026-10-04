/**
 * One Design system section on its own page, previewed in the Mode and
 * Theme set on the index. An unknown section lands on the index.
 */

import { Redirect, useLocalSearchParams, useRouter } from 'expo-router'
import React from 'react'

import { sectionById } from '@/features/design-system'
import { SectionContent } from '@/ui/design-system'
import { Page } from '@/ui/Page'

export default function DesignSystemSectionPage() {
  const router = useRouter()
  const { section } = useLocalSearchParams<{ section: string }>()
  const found = sectionById(section)

  if (!found) {
    return <Redirect href="/settings/design-system" />
  }
  return (
    <Page title={found.title} onBack={() => router.back()}>
      <SectionContent id={found.id} />
    </Page>
  )
}
