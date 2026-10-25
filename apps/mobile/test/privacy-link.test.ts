/// <reference types="node" />
/**
 * Both stores ask for a link to the privacy policy inside the app. The
 * Settings screen runs only on a device, so this reads its source with the
 * TypeScript compiler and checks that the Privacy row opens the policy.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SETTINGS = path.resolve(import.meta.dirname, '..', 'app/settings/index.tsx')

/** The `ListRow` elements of a source file whose `title` is the string `title`. */
function rowsTitled(file: ts.SourceFile, title: string): ts.JsxSelfClosingElement[] {
  const rows: ts.JsxSelfClosingElement[] = []
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(file) === 'ListRow' && attribute(node, 'title')?.getText(file) === `"${title}"`) {
      rows.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return rows
}

function attribute(element: ts.JsxSelfClosingElement, name: string): ts.JsxAttributeValue | undefined {
  const found = element.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.getText() === name)
  return found !== undefined && ts.isJsxAttribute(found) ? found.initializer : undefined
}

describe('the Privacy row in Settings', () => {
  it('opens the privacy policy when tapped', () => {
    const file = ts.createSourceFile(SETTINGS, readFileSync(SETTINGS, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const rows = rowsTitled(file, 'Privacy')

    expect(rows).toHaveLength(1)
    expect(attribute(rows[0], 'onPress')?.getText(file)).toBe("{() => openPage(PRIVACY_POLICY_URL, 'the privacy policy')}")
    // A web page outside the app: the screen reader announces a link, and the row shows an external-link icon.
    expect(rows[0].attributes.properties.some(property => ts.isJsxAttribute(property) && property.name.getText(file) === 'external')).toBe(true)
  })
})
