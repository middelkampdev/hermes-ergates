/**
 * A clarify card answers each question on its own: a tapped choice, typed
 * text, or both for a multi-select question. A question left open is sent as
 * skipped (`null`), the way Hermes Desktop answers the same request.
 */
import { describe, expect, it } from 'vitest'

import type { ClarifyQuestion } from '@/gateway/types'

import { answerParts, canConfirm, clarifyAnswers, pickChoice, typeAnswer, type ClarifyDraft } from './clarify-answers'

const pick: ClarifyQuestion = { qid: 'q0', question: 'Which region?', choices: ['Europe (Recommended)', 'America'], multi_select: false }
const many: ClarifyQuestion = { qid: 'q1', question: 'Which permissions?', choices: ['read', 'write'], multi_select: true }
const open: ClarifyQuestion = { qid: 'q2', question: 'What should the report be called?', choices: [], multi_select: false }

describe('clarifyAnswers', () => {
  it('answers a single-choice question with the tapped choice, without the Recommended label', () => {
    const draft = pickChoice({}, pick, 'Europe (Recommended)')

    expect(clarifyAnswers([pick], draft)).toEqual({ q0: 'Europe' })
  })

  it('lets typed text replace a tapped choice, and a tapped choice replace typed text, on a single-choice question', () => {
    const typed = typeAnswer(pickChoice({}, pick, 'America'), pick, 'Asia')
    expect(clarifyAnswers([pick], typed)).toEqual({ q0: 'Asia' })

    const tapped = pickChoice(typed, pick, 'America')
    expect(clarifyAnswers([pick], tapped)).toEqual({ q0: 'America' })
  })

  it('answers a multi-select question with the tapped choices and the typed text, as a JSON list', () => {
    let draft: ClarifyDraft = pickChoice({}, many, 'read')
    draft = typeAnswer(draft, many, '  delete ')
    draft = pickChoice(draft, many, 'write')
    draft = pickChoice(draft, many, 'read')

    expect(clarifyAnswers([many], draft)).toEqual({ q1: JSON.stringify(['write', 'delete']) })
  })

  it('answers a question without choices with the typed text', () => {
    expect(clarifyAnswers([open], typeAnswer({}, open, 'October costs'))).toEqual({ q2: 'October costs' })
  })

  it('sends every question, with null for one left open or only given spaces', () => {
    const draft = typeAnswer(pickChoice({}, pick, 'America'), open, '   ')

    expect(clarifyAnswers([pick, many, open], draft)).toEqual({ q0: 'America', q1: null, q2: null })
  })
})

describe('clarifyAnswers with answers another client locked', () => {
  it('leaves out an open question another client already answered, so Hermes keeps that answer', () => {
    const draft = typeAnswer({}, open, 'October costs')

    expect(clarifyAnswers([pick, many, open], draft, { q0: 'Europe', q1: null })).toEqual({ q2: 'October costs' })
  })

  it('sends the answer of this phone for a locked question it answered too', () => {
    expect(clarifyAnswers([pick], pickChoice({}, pick, 'America'), { q0: 'Europe' })).toEqual({ q0: 'America' })
  })
})

describe('canConfirm', () => {
  it('needs at least one answered question; the others are sent as skipped', () => {
    expect(canConfirm([pick, open], {})).toBe(false)
    expect(canConfirm([pick, open], typeAnswer({}, open, '   '))).toBe(false)
    expect(canConfirm([pick, open], typeAnswer({}, open, 'October costs'))).toBe(true)
  })
})

describe('answerParts', () => {
  it('shows a tapped choice as chosen and anything else as typed text', () => {
    expect(answerParts(pick, 'Europe')).toEqual({ choices: ['Europe (Recommended)'], typed: null, skipped: false })
    expect(answerParts(pick, 'Asia')).toEqual({ choices: [], typed: 'Asia', skipped: false })
  })

  it('reads a multi-select answer as its chosen choices and its typed extras', () => {
    expect(answerParts(many, JSON.stringify(['write', 'delete', 'admin']))).toEqual({ choices: ['write'], typed: 'delete, admin', skipped: false })
  })

  it('reads a multi-select answer that is no JSON list as typed text', () => {
    expect(answerParts(many, 'read and write')).toEqual({ choices: [], typed: 'read and write', skipped: false })
  })

  it('says a question was skipped only when its answer is null, and nothing when no answer is known', () => {
    expect(answerParts(open, null)).toEqual({ choices: [], typed: null, skipped: true })
    expect(answerParts(open, undefined)).toEqual({ choices: [], typed: null, skipped: false })
  })
})
