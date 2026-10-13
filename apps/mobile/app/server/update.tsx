/**
 * Update ready: the page the plugin update notices lead to. It has a header
 * and a way back for now; the update itself is added to this page.
 */

import { useRouter } from 'expo-router'
import React from 'react'

import { Page } from '@/ui/Page'

export default function UpdateReadyScreen() {
  const router = useRouter()
  return (
    <Page title="Update ready" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}>
      {null}
    </Page>
  )
}
