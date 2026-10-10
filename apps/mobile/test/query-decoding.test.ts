/**
 * expo-router parses a link's query string with query-string, which decodes
 * each value with decode-uri-component. Version 0.2.2 decodes malformed
 * percent-encoding in polynomial time (GHSA-vcc3-ghjq-m6fr): a link of a few
 * kilobytes freezes the JavaScript thread for seconds. The fix shipped in
 * 0.5.0, which is ESM-only, so query-string 7 cannot load it.
 * patches/decode-uri-component+0.2.2.patch backports the linear decoder; these
 * tests fail when the patch is not applied.
 */
import queryString from 'query-string'
import { describe, expect, it } from 'vitest'

function decodedValue(encoded: string): unknown {
  return queryString.parse(`q=${encoded}`).q
}

describe('query decoding of a link', () => {
  it('decodes malformed percent-encoding in linear time', () => {
    // 2,400 characters: about 6 seconds with the unpatched decoder.
    const malformed = '%E0%A4'.repeat(400)

    const started = performance.now()
    const value = decodedValue(malformed)
    const elapsed = performance.now() - started

    expect(value).toBe(malformed)
    expect(elapsed).toBeLessThan(500)
  })

  it.each([
    ['%25', '%'],
    ['%', '%'],
    ['st%C3%A5le', 'ståle'],
    ['%st%C3%A5le%', '%ståle%'],
    ['%%7Bst%C3%A5le%7D%', '%{ståle}%'],
    ['%7B%ab%%7C%de%%7D', '{%ab%|%de%}'],
    ['%FE%FF', '��'],
    ['%C2', '�'],
    ['%C2%B5', 'µ'],
    ['a%E0%A4b%C3%A5', 'a%E0%A4bå']
  ])('decodes %s as before', (encoded, decoded) => {
    expect(decodedValue(encoded)).toBe(decoded)
  })
})
