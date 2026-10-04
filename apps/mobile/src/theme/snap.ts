/**
 * Pure helper for moving a number onto a scale of steps. No React Native
 * imports.
 */

/**
 * The step nearest to `value`. A value exactly halfway between two steps takes
 * the smaller one, so nothing grows. A value below the smallest step takes the
 * smallest, and a value above the largest takes the largest. With no steps the
 * value comes back unchanged.
 */
export function snapToStep(value: number, steps: readonly number[]): number {
  let nearest = value
  let nearestDistance = Infinity
  for (const step of steps) {
    const distance = Math.abs(step - value)
    if (distance < nearestDistance || (distance === nearestDistance && step < nearest)) {
      nearest = step
      nearestDistance = distance
    }
  }
  return nearest
}
