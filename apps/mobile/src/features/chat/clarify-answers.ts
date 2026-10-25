/**
 * The answers of a clarify card, one per question, built the way Hermes
 * Desktop builds them (apps/desktop/src/components/assistant-ui/clarify/pending.tsx
 * at the pin). A single-choice question takes the tapped choice or the typed
 * text, whichever came last. A multi-select question takes the tapped choices
 * and the typed text together, as a JSON list. A question without choices
 * takes the typed text. A question left open is sent as `null`, which Hermes
 * reads as skipped (tui_gateway/contracts/server_requests.py:34-52). Pure, so
 * Node tests cover it; the card only draws it.
 */

import type { ClarifyQuestion } from '@/gateway/types'

/** One question's answer in progress: the tapped choices and the typed text. */
export interface ClarifyStage {
  choices: string[]
  typed: string
}

/** A card's answers in progress, by question id. */
export type ClarifyDraft = Record<string, ClarifyStage>

const EMPTY_STAGE: ClarifyStage = { choices: [], typed: '' }

const RECOMMENDED = '(Recommended)'

/** A choice without the "(Recommended)" label Hermes adds; the agent wrote it without one. */
function bareChoice(choice: string): string {
  return choice.endsWith(RECOMMENDED) ? choice.slice(0, -RECOMMENDED.length).trim() : choice
}

export function stageOf(draft: ClarifyDraft, qid: string): ClarifyStage {
  return draft[qid] ?? EMPTY_STAGE
}

/** Taps a choice: a single-choice question keeps only it (and drops typed text); a multi-select one toggles it. */
export function pickChoice(draft: ClarifyDraft, question: ClarifyQuestion, choice: string): ClarifyDraft {
  const stage = stageOf(draft, question.qid)
  if (!question.multi_select) {
    return { ...draft, [question.qid]: { choices: [choice], typed: '' } }
  }
  const choices = stage.choices.includes(choice) ? stage.choices.filter(c => c !== choice) : [...stage.choices, choice]
  return { ...draft, [question.qid]: { choices, typed: stage.typed } }
}

/** Types into a question's field: on a single-choice question the text replaces a tapped choice. */
export function typeAnswer(draft: ClarifyDraft, question: ClarifyQuestion, text: string): ClarifyDraft {
  const stage = stageOf(draft, question.qid)
  return { ...draft, [question.qid]: { choices: question.multi_select ? stage.choices : [], typed: text } }
}

function stagedAnswer(question: ClarifyQuestion, stage: ClarifyStage): string | null {
  const typed = stage.typed.trim()
  if (question.multi_select) {
    const combined = [...stage.choices.map(bareChoice), ...(typed ? [typed] : [])]
    return combined.length > 0 ? JSON.stringify(combined) : null
  }
  const choice = stage.choices[0]
  if (choice !== undefined) {
    return bareChoice(choice)
  }
  return typed ? typed : null
}

/**
 * The `answers` of the response frame: every question, `null` for one left
 * open. A question another client already answered (`locked`, from a replayed
 * request) is left out when this phone leaves it open: Hermes keeps a locked
 * answer that the frame does not name, and a `null` would overwrite it
 * (tui_gateway/server_requests.py, the batch-clarify merge).
 */
export function clarifyAnswers(questions: ClarifyQuestion[], draft: ClarifyDraft, locked: Record<string, string | null> = {}): Record<string, string | null> {
  const answers: Record<string, string | null> = {}
  for (const q of questions) {
    const answer = stagedAnswer(q, stageOf(draft, q.qid))
    if (answer !== null || locked[q.qid] === undefined) {
      answers[q.qid] = answer
    }
  }
  return answers
}

/** Whether the card can be sent: at least one question has an answer. */
export function canConfirm(questions: ClarifyQuestion[], draft: ClarifyDraft): boolean {
  return questions.some(q => stagedAnswer(q, stageOf(draft, q.qid)) !== null)
}

/** How an answered card shows one question: the choices it picked, any other text, or that it was skipped. */
export interface AnswerParts {
  choices: string[]
  typed: string | null
  skipped: boolean
}

/**
 * Splits a sent answer into the choices it names and the rest, for the
 * answered card. `null` is a skipped question; `undefined` is a question whose
 * answer the app does not know, which shows nothing.
 */
export function answerParts(question: ClarifyQuestion, answer: string | null | undefined): AnswerParts {
  if (answer === null || answer === undefined) {
    return { choices: [], typed: null, skipped: answer === null }
  }
  const values = question.multi_select ? jsonList(answer) : [answer]
  if (values === null) {
    return { choices: [], typed: answer, skipped: false }
  }
  const choices = question.choices.filter(choice => values.includes(bareChoice(choice)))
  const named = new Set(choices.map(bareChoice))
  const rest = values.filter(value => !named.has(value))
  return { choices, typed: rest.length > 0 ? rest.join(', ') : null, skipped: false }
}

function jsonList(text: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.map(String) : null
  } catch {
    return null
  }
}
