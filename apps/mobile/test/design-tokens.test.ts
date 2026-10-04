/// <reference types="node" />
/**
 * Type, radius, opacity and color values come from src/theme/tokens.ts and
 * the theme, not from literals in a screen or a shared component. The scan
 * parses every `.tsx` file under app/ and src/ui/ with the TypeScript
 * compiler and reports a numeric literal for a type, radius or opacity key,
 * a string literal for `fontWeight`, and any hex or rgb(a) color string.
 *
 * BASELINE lists the files that still hold raw values. It only shrinks: a
 * file leaves it when it is clean, and the last test fails until it does.
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

const BASELINE: ReadonlySet<string> = new Set<string>([
  'app/agent/[profile]/edit-capabilities.tsx',
  'app/agent/[profile]/edit-instructions.tsx',
  'app/agent/[profile]/edit-model.tsx',
  'app/agent/[profile]/edit.tsx',
  'app/agent/[profile]/index.tsx',
  'app/agent/[profile]/memory.tsx',
  'app/agent/[profile]/routine.tsx',
  'app/agent/[profile]/routines.tsx',
  'app/agent/[profile]/tools.tsx',
  'app/chat/[profile]/activity.tsx',
  'app/chat/[profile]/exchange.tsx',
  'app/chat/[profile]/index.tsx',
  'app/connect.tsx',
  'app/hidden-bots.tsx',
  'app/index.tsx',
  'app/move-to-section.tsx',
  'app/new-agent.tsx',
  'app/notifications.tsx',
  'app/search.tsx',
  'app/section.tsx',
  'app/settings/index.tsx',
  'src/ui/ActionMenu.tsx',
  'src/ui/Avatar.tsx',
  'src/ui/Button.tsx',
  'src/ui/Field.tsx',
  'src/ui/Group.tsx',
  'src/ui/ListRow.tsx',
  'src/ui/MarkdownText.tsx',
  'src/ui/Page.tsx',
  'src/ui/Row.tsx',
  'src/ui/Sheet.tsx',
  'src/ui/SwitchRow.tsx',
  'src/ui/chat/BotMessageBubble.tsx',
  'src/ui/chat/Bubble.tsx',
  'src/ui/chat/Cards.tsx',
  'src/ui/chat/Composer.tsx',
  'src/ui/chat/ExchangeRow.tsx',
  'src/ui/chat/NoticeRow.tsx',
  'src/ui/chat/ProposalCard.tsx',
  'src/ui/chat/Rows.tsx',
  'src/ui/home-list/EditBar.tsx',
  'src/ui/home-list/HomeRow.tsx',
  'src/ui/home-list/HomeSectionHeader.tsx',
  'src/ui/home-list/HomeTopBar.tsx',
  'src/ui/home-list/PinnedArea.tsx',
  'src/ui/home-list/SectionGhostRow.tsx'
])

type Finding = { line: number; key: string; text: string }

const BAD = `
const styles = StyleSheet.create({
  title: { fontSize: 17, fontWeight: '600', lineHeight: 22, letterSpacing: 0.2 },
  card: { borderRadius: 12, opacity: 0.7 }
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
      const value = node.initializer
      if (key && NUMERIC_KEYS.has(key)) {
        const number = numericValue(value)
        if (number !== undefined && !(key === 'opacity' && (number === 0 || number === 1))) {
          report(node, key)
        }
      } else if (key === 'fontWeight' && (ts.isStringLiteral(value) || numericValue(value) !== undefined)) {
        report(node, key)
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
      'backgroundColor',
      'color'
    ])
    expect(found).toHaveLength(8)
  })

  it('lets tokens and computed values through', () => {
    expect(findRawStyleValues(GOOD, 'good.tsx')).toEqual([])
  })

  it(
    'app and shared UI use tokens',
    () => {
      const offenders = [...scanApp()]
        .filter(([file]) => !BASELINE.has(file))
        .flatMap(([file, found]) => found.map(({ line, key, text }) => `${file}:${line} ${key} ${text}`))
      expect(offenders, `use a role from src/theme/tokens.ts:\n${offenders.join('\n')}`).toEqual([])
    },
    30000
  )

  it(
    'the baseline only lists files that still need work',
    () => {
      const scan = scanApp()
      const stale = [...BASELINE].filter(file => (scan.get(file) ?? []).length === 0)
      expect(stale, `remove from BASELINE, these files are clean:\n${stale.join('\n')}`).toEqual([])
    },
    30000
  )
})
