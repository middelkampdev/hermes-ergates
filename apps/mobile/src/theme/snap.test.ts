import { snapToStep } from './snap'

const STEPS = [8, 12, 16]

describe('snapToStep', () => {
  it('keeps a value that is a step', () => {
    expect(snapToStep(12, STEPS)).toBe(12)
  })
  it('takes the nearest step', () => {
    expect(snapToStep(15, STEPS)).toBe(16)
    expect(snapToStep(9, STEPS)).toBe(8)
  })
  it('takes the smaller step when a value is exactly halfway', () => {
    expect(snapToStep(14, STEPS)).toBe(12)
    expect(snapToStep(10, STEPS)).toBe(8)
  })
  it('takes the smallest step below the scale', () => {
    expect(snapToStep(6, STEPS)).toBe(8)
  })
  it('takes the largest step above the scale', () => {
    expect(snapToStep(40, [24, 32])).toBe(32)
  })
  it('does not depend on the order of the steps', () => {
    expect(snapToStep(14, [16, 8, 12])).toBe(12)
  })
  it('returns the value when there are no steps', () => {
    expect(snapToStep(7, [])).toBe(7)
  })
})
