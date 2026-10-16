import { describe, expect, it } from 'vitest'

import { MARKDOWN_IMAGE_SOURCES } from './markdown-images'

/**
 * The image rule of react-native-markdown-display 7 (src/lib/renderRules.js, `image`): a source that starts with an
 * allowed prefix, in any case, loads as is. Any other source loads with the default prefix in front, or not at all when
 * the default is null. The rule itself imports React Native, so this mirrors it for Node.
 */
function loadedSource(src: string): string | null {
  const allowed = MARKDOWN_IMAGE_SOURCES.allowedImageHandlers.some(prefix => src.toLowerCase().startsWith(prefix.toLowerCase()))
  if (allowed) {
    return src
  }
  return MARKDOWN_IMAGE_SOURCES.defaultImageHandler === null ? null : `${MARKDOWN_IMAGE_SOURCES.defaultImageHandler}${src}`
}

describe('markdown images', () => {
  it('load only from inline data or https', () => {
    for (const prefix of MARKDOWN_IMAGE_SOURCES.allowedImageHandlers) {
      expect(prefix.startsWith('data:') || prefix === 'https://').toBe(true)
    }
  })

  it.each(['https://example.com/cat.png', 'HTTPS://example.com/cat.png', 'data:image/png;base64,iVBORw0KGgo='])('load %j as written', src => {
    expect(loadedSource(src)).toBe(src)
  })

  // Android allows plain http to every host (ADR-045), so a chat message must not make the phone fetch an image in plain text.
  it.each(['http://192.168.1.10/cat.png', 'HTTP://example.com/cat.png', 'example.com/cat.png', '//example.com/cat.png', 'file:///etc/hosts'])(
    'never load %j, and never with https put in front',
    src => {
      expect(loadedSource(src)).toBeNull()
    }
  )
})
