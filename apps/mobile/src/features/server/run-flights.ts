/**
 * The run of one kind a connection has going, shared by every caller: a call
 * while it is going joins it instead of starting another. Whether the
 * connection's other kind of run is going is the caller's to ask
 * (`runningKind` in `pending-setup.ts`, which sees both).
 */

import { trackRun, type RunKind } from './pending-setup'

interface Flight<Step, Status, Outcome> {
  promise: Promise<Outcome>
  /** The latest status of each step that has reported, in the order the steps first reported. */
  statuses: Map<Step, Status>
  listeners: ((step: Step, status: Status) => void)[]
}

export class Flights<Step, Status, Outcome> {
  private readonly going = new Map<string, Flight<Step, Status, Outcome>>()

  constructor(private readonly kind: RunKind) {}

  /**
   * The outcome of the run going for the connection, or null when none is.
   * `onStep` first gets the latest status of every step that has reported,
   * then every later transition.
   */
  join(connectionId: string, onStep: (step: Step, status: Status) => void): Promise<Outcome> | null {
    const flight = this.going.get(connectionId)
    if (flight === undefined) {
      return null
    }
    flight.statuses.forEach((status, step) => onStep(step, status))
    flight.listeners.push(onStep)
    return flight.promise
  }

  /**
   * Starts the run `work` begins and records it until its promise settles.
   * `work` reports each transition through the function it is given.
   * `goingBack` tells the connection's other kind of caller what is running.
   */
  start(
    connectionId: string,
    onStep: (step: Step, status: Status) => void,
    work: (report: (step: Step, status: Status) => void) => Promise<Outcome>,
    goingBack = false
  ): Promise<Outcome> {
    const statuses = new Map<Step, Status>()
    const listeners = [onStep]
    const promise = work((step, status) => {
      statuses.set(step, status)
      listeners.forEach(listener => listener(step, status))
    })
    this.going.set(connectionId, { promise, statuses, listeners })
    trackRun(connectionId, this.kind, goingBack, promise)
    const forget = () => {
      this.going.delete(connectionId)
    }
    void promise.then(forget, forget)
    return promise
  }
}
