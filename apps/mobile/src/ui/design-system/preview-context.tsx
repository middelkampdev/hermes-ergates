/**
 * The Design system pages' shared preview: one Mode and Theme for the index
 * and every section page. The design-system stack's layout owns the state;
 * the pages read and change it here.
 */

import { createContext, useContext, type ReactNode } from 'react'

import type { Appearance } from '@/theme/tokens'

export interface DesignSystemPreview {
  appearance: Appearance
  themeLabel: string
  nextMode(): void
  nextTheme(): void
  /** Back to the saved Appearance. */
  reset(): void
}

const PreviewContext = createContext<DesignSystemPreview | null>(null)

export function DesignSystemPreviewProvider({ value, children }: { value: DesignSystemPreview; children: ReactNode }) {
  return <PreviewContext.Provider value={value}>{children}</PreviewContext.Provider>
}

export function useDesignSystemPreview(): DesignSystemPreview {
  const preview = useContext(PreviewContext)
  if (!preview) {
    throw new Error('DesignSystemPreviewProvider is missing above this page.')
  }
  return preview
}
