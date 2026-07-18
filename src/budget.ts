/**
 * Token budgeting and work chunking.
 *
 * Ported from gym-copilot, which needed both to generate multi-week training
 * programs: a long program blows the token ceiling in one call, so it estimates
 * a budget from the amount of work requested and splits the request when that
 * work exceeds a threshold.
 *
 * **Only the mechanism is here.** gym's own functions are domain-shaped —
 * `estimateProgramTokenBudget(startDate, endDate, workoutsPerWeek)` and
 * `shouldChunkProgram(...)` speak weeks and workouts. Lifting those verbatim
 * would put training-program concepts inside a package that must not know about
 * any app's domain. So the generic core lives here and each app keeps a thin
 * wrapper that converts its own nouns into a unit count.
 *
 * Nothing here is AI-specific either; it is arithmetic about request sizing.
 * It lives in this package because that is where the consumers are.
 */

/**
 * How many output tokens to request for a job of `units` work items.
 *
 * `base` covers the fixed envelope (JSON scaffolding, preamble), `perUnit` the
 * marginal cost of each item, and the result is clamped so a tiny job still
 * gets a workable budget and a huge one doesn't exceed what the model allows.
 */
export type TokenBudgetSpec = {
  /** Fixed overhead, in tokens. */
  base: number
  /** Marginal tokens per work item. */
  perUnit: number
  /** Floor, so a small job still gets room to answer. */
  min: number
  /** Ceiling, typically the model's own output limit. */
  max: number
}

export function estimateTokenBudget(
  units: number,
  spec: TokenBudgetSpec,
): number {
  const safeUnits = Number.isFinite(units) && units > 0 ? units : 0
  return Math.min(
    spec.max,
    Math.max(spec.min, spec.base + safeUnits * spec.perUnit),
  )
}

/**
 * Whether a job should be split rather than attempted in one request.
 *
 * The caller decides what a "unit" is — gym counts training sessions.
 */
export function shouldChunk(units: number, limitPerChunk: number): boolean {
  return units > limitPerChunk
}

/**
 * How many units belong in one chunk, given how many arrive per group.
 *
 * gym's case: `limitPerChunk` sessions, `unitsPerGroup` workouts per week —
 * the answer is how many whole weeks fit in a chunk. Never returns less than
 * 1, so a group larger than the limit still makes progress rather than
 * looping forever on an empty chunk.
 */
export function groupsPerChunk(
  limitPerChunk: number,
  unitsPerGroup: number,
): number {
  if (unitsPerGroup <= 0) return 1
  return Math.max(1, Math.ceil(limitPerChunk / unitsPerGroup))
}

/** Total chunks needed to cover `units` at `limitPerChunk` each. */
export function chunkCount(units: number, limitPerChunk: number): number {
  if (limitPerChunk <= 0) return 1
  return Math.max(1, Math.ceil(units / limitPerChunk))
}
