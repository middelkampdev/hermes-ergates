/**
 * Finish on your server: the page for the steps the app cannot do alone. It
 * shows the page header only until those steps are written.
 */

import { useRouter } from 'expo-router'
import React from 'react'

import { Page } from '@/ui/Page'

export default function FinishOnServerScreen() {
  const router = useRouter()
  return (
    <Page title="Finish on your server" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}>
      {null}
    </Page>
  )
}
