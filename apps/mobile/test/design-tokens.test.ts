/// <reference types="node" />
/**
 * Type, radius, opacity and color values come from src/theme/tokens.ts and
 * the theme, not from literals in a screen or a shared component. The scan
 * parses every `.tsx` file under app/ and src/ui/ with the TypeScript
 * compiler and reports a numeric literal for a type, radius or opacity key,
 * a string literal for `fontWeight`, and any hex or rgb(a) color string.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const APP = path.resolve(import.meta.dirname, '..')
const FOLDERS = ['app', 'src/ui']
const NUMERIC_KEYS = new Set(['fontSize', 'lineHeight', 'letterSpacing', 'borderRadius', 'opacity'])
const HEX = /^#[0-9a-f]{3,8}$/i
const RGB = /^rgba?\(/i

type Finding = { line: number; key: string; text: string }

const BAD = `
const styles = StyleSheet.create({
  title: { fontSize: 17, fontWeight: '600', lineHeight: 22, letterSpacing: 0.2 },
  card: { borderRadius: 12, opacity: 0.7 },
  pressable: { opacity: pressed ? 0.7 : 1, fontSize: big ? 20 : 17 }
})
export const Inline = () => (
  <View style={{ backgroundColor: '#fff', color: 'rgba(0,0,0,0.25)' }} />
)
`

const GOOD = `
const styles = StyleSheet.create({
  title: { ...TYPE.body },
  card: { borderRadius: RADIUS.group, borderWidth: StyleSheet.hairlineWidth }
})
export const Inline = ({ size, pressed, progress }) => (
  <View
    style={{
      borderRadius: size / 2,
      opacity: pressed ? OPACITY.pressed : 1
    }}
  >
    <View style={{ opacity: 0 }} />
    <View style={{ opacity: progress.get() }} />
    <Text>#hashtag</Text>
    <Text>#deface</Text>
    <Text>{'#hashtag'}</Text>
  </View>
)
`

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined
}

function numericValue(node: ts.Expression): number | undefined {
  if (ts.isNumericLiteral(node)) {
    return Number(node.text)
  }
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return -Number(node.operand.text)
  }
  return undefined
}

/** The value itself, or each branch of a conditional, through parentheses. Operators and calls are not entered. */
function literalBranches(node: ts.Expression): ts.Expression[] {
  if (ts.isParenthesizedExpression(node)) {
    return literalBranches(node.expression)
  }
  if (ts.isConditionalExpression(node)) {
    return [...literalBranches(node.whenTrue), ...literalBranches(node.whenFalse)]
  }
  return [node]
}

function findRawStyleValues(source: string, fileName: string): Finding[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: Finding[] = []
  const report = (node: ts.Node, key: string): void => {
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
    found.push({ line, key, text: node.getText(file) })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const key = propertyName(node.name)
      if (key && (NUMERIC_KEYS.has(key) || key === 'fontWeight')) {
        for (const value of literalBranches(node.initializer)) {
          const number = numericValue(value)
          const raw = key === 'fontWeight' ? ts.isStringLiteral(value) || number !== undefined : number !== undefined
          if (raw && !(key === 'opacity' && (number === 0 || number === 1))) {
            report(value, key)
          }
        }
      }
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (HEX.test(node.text) || RGB.test(node.text)) {
        const parent = node.parent
        const key =
          ts.isPropertyAssignment(parent) && propertyName(parent.name)
            ? propertyName(parent.name)!
            : ts.isJsxAttribute(parent)
              ? parent.name.getText(file)
              : 'color'
        report(node, key)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found.sort((a, b) => a.line - b.line)
}

function tsxFiles(folder: string): string[] {
  return readdirSync(folder).flatMap(name => {
    const full = path.join(folder, name)
    if (statSync(full).isDirectory()) {
      return tsxFiles(full)
    }
    return name.endsWith('.tsx') ? [full] : []
  })
}

function scanApp(): Map<string, Finding[]> {
  const result = new Map<string, Finding[]>()
  for (const file of FOLDERS.flatMap(folder => tsxFiles(path.join(APP, folder))).sort()) {
    const relative = path.relative(APP, file).split(path.sep).join('/')
    result.set(relative, findRawStyleValues(readFileSync(file, 'utf8'), file))
  }
  return result
}

describe('design tokens', () => {
  it('finds each banned form', () => {
    const found = findRawStyleValues(BAD, 'bad.tsx')
    expect(found.map(({ key }) => key)).toEqual([
      'fontSize',
      'fontWeight',
      'lineHeight',
      'letterSpacing',
      'borderRadius',
      'opacity',
      'opacity',
      'fontSize',
      'fontSize',
      'backgroundColor',
      'color'
    ])
    expect(found).toHaveLength(11)
  })

  it('lets tokens and computed values through', () => {
    expect(findRawStyleValues(GOOD, 'good.tsx')).toEqual([])
  })

  it(
    'app and shared UI use tokens',
    () => {
      const offenders = [...scanApp()]
        .flatMap(([file, found]) => found.map(({ line, key, text }) => `${file}:${line} ${key} ${text}`))
      expect(offenders, `use a role from src/theme/tokens.ts:\n${offenders.join('\n')}`).toEqual([])
    },
    30000
  )
})
