/// <reference types="node" />
/**
 * Type, radius, opacity, color, spacing and size values come from
 * src/theme/tokens.ts and the theme, not from literals in a screen or a
 * shared component. The scan parses every `.tsx` file under app/ and
 * src/ui/ with the TypeScript compiler and reports:
 *
 * - a numeric literal for a type, radius or opacity key, a string literal for
 *   `fontWeight`, and any hex or rgb(a) color string (the `token` rule);
 * - a numeric literal other than `0` for a spacing key (`padding*`,
 *   `margin*`, `gap`, `rowGap`, `columnGap`) or a size key (`width`, `height`,
 *   the min and max forms, `top`, `right`, `bottom`, `left`), a numeric
 *   literal for the `size` prop of a JSX element, and a module-level `const`
 *   with a numeric initializer other than `0` and `1` whose name says it is a
 *   size, radius, spacing, opacity or type value (the `step` rule).
 *
 * Both branches of a conditional are checked. Computed values and `0` pass.
 *
 * BASELINE lists the files that still hold values the `step` rule rejects. It
 * only shrinks: a file leaves it when it is clean, and a test fails until it
 * does. GEOMETRY lists the files whose remaining values are drag or motion
 * geometry rather than design values, each with its reason.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const APP = path.resolve(import.meta.dirname, '..')
const FOLDERS = ['app', 'src/ui']
const NUMERIC_KEYS = new Set(['fontSize', 'lineHeight', 'letterSpacing', 'borderRadius', 'opacity'])
const SPACING_KEY = /^(padding|margin)(Top|Bottom|Left|Right|Horizontal|Vertical|Start|End)?$|^(gap|rowGap|columnGap)$/
const SIZE_KEYS = new Set(['width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'top', 'right', 'bottom', 'left'])
const STEP_CONSTANT = /SIZE|RADIUS|WIDTH|HEIGHT|PADDING|GAP|INSET|SPACING|MARGIN|OPACITY|LEADING|LINE_HEIGHT|WEIGHT|FONT/
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
  'app/new-agent.tsx',
  'app/notifications.tsx',
  'app/search.tsx',
  'app/settings/design-system/appearance.tsx',
  'app/settings/index.tsx',
  'src/ui/ActionMenu.tsx',
  'src/ui/Button.tsx',
  'src/ui/Card.tsx',
  'src/ui/Field.tsx',
  'src/ui/Group.tsx',
  'src/ui/ListRow.tsx',
  'src/ui/MarkdownText.tsx',
  'src/ui/Page.tsx',
  'src/ui/Row.tsx',
  'src/ui/RowContent.tsx',
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
  'src/ui/design-system/ComponentSamples.tsx',
  'src/ui/design-system/ContrastSample.tsx',
  'src/ui/design-system/FoundationSamples.tsx',
  'src/ui/design-system/Swatch.tsx',
  'src/ui/design-system/TypeSample.tsx',
  'src/ui/home-list/EditBar.tsx',
  'src/ui/home-list/HomeRow.tsx',
  'src/ui/home-list/HomeSectionHeader.tsx',
  'src/ui/home-list/HomeTopBar.tsx',
  'src/ui/home-list/PinnedArea.tsx',
  'src/ui/home-list/SectionGhostRow.tsx',
  'src/ui/home-list/SelectionCircle.tsx'
])

/** A file goes here only when every value the `step` rule flags in it is drag or motion geometry; the reason says which. */
const GEOMETRY: ReadonlyMap<string, string> = new Map<string, string>([])

/** `token`: a type, radius, opacity or color value. `step`: a spacing, size, size prop or size constant. */
type Rule = 'token' | 'step'
type Finding = { rule: Rule; line: number; key: string; text: string }

const BAD = `
const styles = StyleSheet.create({
  title: { fontSize: 17, fontWeight: '600', lineHeight: 22, letterSpacing: 0.2 },
  card: { borderRadius: 12, opacity: 0.7 },
  pressable: { opacity: pressed ? 0.7 : 1, fontSize: big ? 20 : 17 },
  box: {
    padding: 6,
    marginTop: big ? 40 : 10,
    gap: 14,
    width: 18,
    minHeight: 50,
    top: 62
  }
})
const SEND_SIZE = 38
const MENU_RADIUS = 16
const HOVER_OPACITY = 0.35
export const Inline = () => (
  <View style={{ backgroundColor: '#fff', color: 'rgba(0,0,0,0.25)' }}>
    <Icon size={22} />
    <Avatar size={big ? 60 : 30} />
  </View>
)
`

const GOOD = `
const MAX = 1
const CIRCLE_COLUMN = SPACE.huge
const DURATION = 220
const styles = StyleSheet.create({
  title: { ...TYPE.body },
  card: { borderRadius: RADIUS.large, borderWidth: StyleSheet.hairlineWidth },
  box: {
    padding: SPACE.small,
    marginTop: big ? SPACE.large : 0,
    top: 0,
    width: '100%',
    minHeight: RULE.touch
  }
})
export const Inline = ({ size, gutter, pressed, progress }) => (
  <View
    style={{
      borderRadius: size / 2,
      width: size / 2,
      height: Math.round(size * 0.68),
      opacity: pressed ? OPACITY.strong : 1
    }}
  >
    <View style={{ opacity: 0 }} />
    <View style={{ opacity: progress.get() }} />
    <View style={{ width: gutter + CIRCLE_COLUMN }} />
    <Icon size={ICON_SIZE.medium} />
    <Icon size={big ? ICON_SIZE.large : ICON_SIZE.small} />
    <Avatar size={size} />
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

/** The expression without parentheses and type assertions around it. */
function unwrap(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
    ? unwrap(node.expression)
    : node
}

/** The value itself, or each branch of a conditional, through parentheses. Operators and calls are not entered. */
function literalBranches(node: ts.Expression): ts.Expression[] {
  const value = unwrap(node)
  if (ts.isConditionalExpression(value)) {
    return [...literalBranches(value.whenTrue), ...literalBranches(value.whenFalse)]
  }
  return [value]
}

function findRawStyleValues(source: string, fileName: string): Finding[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: (Finding & { position: number })[] = []
  const report = (node: ts.Node, key: string, rule: Rule): void => {
    const position = node.getStart(file)
    found.push({ rule, line: file.getLineAndCharacterOfPosition(position).line + 1, key, text: node.getText(file), position })
  }
  const reportNumbers = (expression: ts.Expression, key: string, allowed: readonly number[]): void => {
    for (const value of literalBranches(expression)) {
      const number = numericValue(value)
      if (number !== undefined && !allowed.includes(number)) {
        report(value, key, 'step')
      }
    }
  }
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) {
      for (const { name, initializer } of statement.declarationList.declarations) {
        if (ts.isIdentifier(name) && initializer && STEP_CONSTANT.test(name.text)) {
          const value = unwrap(initializer)
          const number = numericValue(value)
          if (number !== undefined && number !== 0 && number !== 1) {
            report(value, name.text, 'step')
          }
        }
      }
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const key = propertyName(node.name)
      if (key && (NUMERIC_KEYS.has(key) || key === 'fontWeight')) {
        for (const value of literalBranches(node.initializer)) {
          const number = numericValue(value)
          const raw = key === 'fontWeight' ? ts.isStringLiteral(value) || number !== undefined : number !== undefined
          if (raw && !(key === 'opacity' && (number === 0 || number === 1))) {
            report(value, key, 'token')
          }
        }
      }
      if (key && (SPACING_KEY.test(key) || SIZE_KEYS.has(key))) {
        reportNumbers(node.initializer, key, [0])
      }
    }
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(file) === 'size' &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression
    ) {
      reportNumbers(node.initializer.expression, 'size', [])
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
        report(node, key, 'token')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found.sort((a, b) => a.position - b.position).map(({ position: _position, ...finding }) => finding)
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

const offender = (file: string, { line, key, text }: Finding): string => `${file}:${line} ${key} ${text}`

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
      'padding',
      'marginTop',
      'marginTop',
      'gap',
      'width',
      'minHeight',
      'top',
      'SEND_SIZE',
      'MENU_RADIUS',
      'HOVER_OPACITY',
      'backgroundColor',
      'color',
      'size',
      'size',
      'size'
    ])
    expect(found).toHaveLength(24)
    expect(found.filter(({ rule }) => rule === 'step').map(({ text }) => text)).toEqual([
      '6',
      '40',
      '10',
      '14',
      '18',
      '50',
      '62',
      '38',
      '16',
      '0.35',
      '22',
      '60',
      '30'
    ])
  })

  it('lets tokens and computed values through', () => {
    expect(findRawStyleValues(GOOD, 'good.tsx')).toEqual([])
  })

  it(
    'app and shared UI use the type, radius, opacity and color tokens',
    () => {
      const offenders = [...scanApp()].flatMap(([file, found]) =>
        found.filter(({ rule }) => rule === 'token').map(finding => offender(file, finding))
      )
      expect(offenders, `use a role from src/theme/tokens.ts:\n${offenders.join('\n')}`).toEqual([])
    },
    30000
  )

  it(
    'app and shared UI use the spacing and size steps',
    () => {
      const offenders = [...scanApp()]
        .filter(([file]) => !BASELINE.has(file) && !GEOMETRY.has(file))
        .flatMap(([file, found]) => found.filter(({ rule }) => rule === 'step').map(finding => offender(file, finding)))
      expect(
        offenders,
        `use a step from src/theme/tokens.ts, or a named rule for a length that is neither a step nor geometry:\n${offenders.join('\n')}`
      ).toEqual([])
    },
    30000
  )

  it(
    'the baseline only lists files that still need work',
    () => {
      const scan = scanApp()
      const stale = [...BASELINE].filter(file => !(scan.get(file) ?? []).some(({ rule }) => rule === 'step'))
      expect(stale, `remove from BASELINE, these files are clean:\n${stale.join('\n')}`).toEqual([])
    },
    30000
  )

  it(
    'the geometry list only holds files that still have such a value, each with a reason',
    () => {
      const scan = scanApp()
      const stale = [...GEOMETRY.keys()].filter(file => !(scan.get(file) ?? []).some(({ rule }) => rule === 'step'))
      expect(stale, `remove from GEOMETRY, these files are clean:\n${stale.join('\n')}`).toEqual([])
      const noReason = [...GEOMETRY].filter(([, reason]) => reason.trim() === '' || reason.includes('\n')).map(([file]) => file)
      expect(noReason, `give each file one line saying which drag or motion value it holds:\n${noReason.join('\n')}`).toEqual([])
      const both = [...GEOMETRY.keys()].filter(file => BASELINE.has(file))
      expect(both, `a file is in BASELINE or GEOMETRY, not both:\n${both.join('\n')}`).toEqual([])
    },
    30000
  )

  it('keeps the baseline sorted', () => {
    expect([...BASELINE]).toEqual([...BASELINE].sort())
    expect([...GEOMETRY.keys()]).toEqual([...GEOMETRY.keys()].sort())
  })
})
