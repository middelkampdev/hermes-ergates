/// <reference types="node" />
/**
 * Code comments and test titles give the reason, not a planning id: a reader
 * has no upgrade plan or review ledger at hand, so a bug, decision, fact,
 * ruling or review finding number from one tells them nothing. ADR numbers (docs/08),
 * docs section numbers, Hermes file:line references and upstream issue
 * numbers stay.
 *
 * The files are parsed with the TypeScript compiler, so a `//` inside a
 * string, a template literal, a regular expression or JSX text is not taken
 * for a comment, and a comment next to one is not missed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const APP = path.resolve(import.meta.dirname, '..')
const FOLDERS = ['app', 'src', 'test']
const PLAN_ID = new RegExp(
  [
    String.raw`\broadmap\b|\breview focus\b|\.superpowers\b|\bimplementer-rules\b`,
    String.raw`\brulings? \d+(?:(?:,| and) \d+)*\b|\bruling,? (?:Critical|Important|Minor) \d+[a-z]?`,
    String.raw`\bfacts? \d+(?:(?:,| and) \d+)*\b`,
    String.raw`\breview (?:issue|finding|point|comment)s? #?\d+`
  ].join('|'),
  'i'
)
const PLAN_ID_CASED = new RegExp(
  [
    String.raw`\b(?:[Dd]ecisions?|[Cc]ontracts?) [CD]\d+\b|\b[CD]\d{1,2}\b|\bPlan \d+\b|\bTask \d+\b|\b[Bb]ug \d+\b`,
    String.raw`\([IM]\d{1,2}\b|\((?:Critical|Important|Minor) \d+[a-z]?\)|\b(?:Critical|Important|Minor) \d+(?:\([a-z]\)|[a-z]\))`
  ].join('|')
)
const TEST_FUNCTIONS = new Set(['describe', 'it', 'test'])

type Found = { line: number; text: string }

function namesPlanningId(text: string): boolean {
  return PLAN_ID.test(text) || PLAN_ID_CASED.test(text)
}

function sourceFiles(folder: string): string[] {
  return readdirSync(folder).flatMap(name => {
    const full = path.join(folder, name)
    if (statSync(full).isDirectory()) {
      return sourceFiles(full)
    }
    return /\.tsx?$/.test(name) ? [full] : []
  })
}

function parse(file: string, text = readFileSync(file, 'utf8')): ts.SourceFile {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
}

function lineOf(source: ts.SourceFile, position: number): number {
  return source.getLineAndCharacterOfPosition(position).line + 1
}

/**
 * Every comment, one entry per line. A comment is trivia in front of a token;
 * JSX text and JSDoc nodes are skipped because their text is not trivia.
 */
function comments(source: ts.SourceFile): Found[] {
  const text = source.getFullText()
  const ranges = new Map<number, ts.CommentRange>()
  const visit = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) {
      return
    }
    const children = node.getChildren(source)
    if (children.length === 0 && node.kind !== ts.SyntaxKind.JsxText) {
      const leading = ts.getLeadingCommentRanges(text, node.pos) ?? []
      const trailing = ts.getTrailingCommentRanges(text, node.pos) ?? []
      for (const range of [...leading, ...trailing]) {
        ranges.set(range.pos, range)
      }
    }
    children.forEach(visit)
  }
  visit(source)
  return [...ranges.values()]
    .sort((a, b) => a.pos - b.pos)
    .flatMap(range =>
    text
      .slice(range.pos, range.end)
      .split('\n')
      .map((line, offset) => ({ line: lineOf(source, range.pos) + offset, text: line }))
  )
}

function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) {
    return expression.text
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isCallExpression(expression)) {
    return calleeName(expression.expression)
  }
  return undefined
}

/** The title of every `describe`, `it` and `test` call, including `.each(...)`, `.skip` and `.only`. */
function testTitles(source: ts.SourceFile): Found[] {
  const found: Found[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && TEST_FUNCTIONS.has(calleeName(node.expression) ?? '')) {
      const title = node.arguments[0]
      if (title && (ts.isStringLiteral(title) || ts.isTemplateLiteral(title))) {
        found.push({ line: lineOf(source, title.getStart(source)), text: title.getText(source) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function offenders(read: (source: ts.SourceFile) => Found[]): string[] {
  return FOLDERS.flatMap(folder => sourceFiles(path.join(APP, folder)))
    .filter(file => !file.endsWith('plain-comments.test.ts'))
    .flatMap(file =>
      read(parse(file))
        .filter(({ text }) => namesPlanningId(text))
        .map(({ line, text }) => `${path.relative(APP, file)}:${line}: ${text.trim()}`)
    )
}

describe('planning ids', () => {
  it(
    'appear in no code comment',
    () => {
      expect(offenders(comments)).toEqual([])
    },
    30000
  )

  it(
    'appear in no test title',
    () => {
      expect(offenders(testTitles)).toEqual([])
    },
    30000
  )

  it(
    'are looked for in every comment and title, and nowhere else',
    () => {
      const source = parse(
        'sample.tsx',
        [
          '// first line',
          'const url = `https://${host}/api` // after a template',
          'const slash = /\\/\\//g /* after a regex */',
          'const view = <Text>see https://example.com</Text>',
          'const empty = <View>{/* inside JSX */}</View>',
          "it('a title', () => {})",
          'call(',
          '  a,',
          '  // before a closing paren',
          ')',
          '/**',
          ' * a JSDoc block',
          ' */',
          'export {}',
          '// last line'
        ].join('\n')
      )
      expect(comments(source).map(({ line, text }) => `${line} ${text.trim()}`)).toEqual([
        '1 // first line',
        '2 // after a template',
        '3 /* after a regex */',
        '5 /* inside JSX */',
        '9 // before a closing paren',
        '11 /**',
        '12 * a JSDoc block',
        '13 */',
        '15 // last line'
      ])
      expect(testTitles(source)).toEqual([{ line: 6, text: "'a title'" }])
    },
    30000
  )

  it.each([
    'roadmap bug 7',
    '(roadmap decision D10)',
    'the C3 code',
    'Review Focus 3',
    'Plan 5 Task 7',
    'see .superpowers/sdd',
    'implementer-rules',
    'finding (I3)',
    'finding (M13)',
    'precomputed once (review issue 4)',
    'Review finding #2',
    'review point 3',
    'review comments 12',
    '(spec 5.4, ruling 11)',
    'ruling 12',
    'Ruling 12: the last turn',
    'rulings 5 and 6',
    'rulings 3, 4 and 7',
    '(Critical 1a)',
    '(Important 2)',
    'Critical 1(a)',
    'ruling, Critical 1a',
    '(ruling, Critical 1a)',
    'Ruling, Critical 1b: the turn',
    '(spec 12.3 anchor, ruling Critical 1b)',
    'Critical 1b).',
    'The Hermes texts of fact 2',
    'Fact 7 says',
    'facts 3 and 4'
  ])('are found in %j', text => {
    expect(namesPlanningId(text)).toBe(true)
  })

  it.each([
    'ADR-031',
    'docs/11 section 4.1',
    'spec 12.3',
    'hermes_cli/plugins.py:397-406',
    'HTTP 400',
    'SHA-256',
    'Hermes issue #26847',
    'fixed upstream in issue #123',
    'a GitHub issue',
    'the page it was ISSUED at',
    'a review comment on the pull request',
    'the critical path',
    'a minor version bump',
    'a court ruling',
    "the judge's ruling was final",
    'the same-direction ruling',
    'Important 3 steps remain',
    'bump to Minor 12',
    'Critical 5 users were affected',
    'a fact the code shows',
    'in fact, 2 calls'
  ])(
    'leave %j alone',
    text => {
      expect(namesPlanningId(text)).toBe(false)
    }
  )
})
