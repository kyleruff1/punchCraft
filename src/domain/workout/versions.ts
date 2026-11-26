/**
 * Versioned constants that gate recalculation (D14).
 *
 * Every one of these is persisted alongside the data it produced, so a
 * stored workout can be recomputed after the logic changes without touching
 * raw events (D8, spec §8.6). They live in one module so that bumping a
 * version is a visible, deliberate edit rather than a literal buried in a
 * repository call.
 *
 * **Bump the version whenever the output changes for the same input.** A
 * silent behaviour change with an unchanged version is the failure these
 * exist to prevent: historical rows would then be indistinguishable from
 * new ones while meaning something different.
 */

/**
 * The workout generator. Same recipe + this version + seed must reproduce an
 * identical plan (R18, doc §16). Bump on any change to template selection,
 * theme planning, or block arrangement.
 *
 * - `1.3.0` — a repeat phase whose gap clamps at its ceiling now takes the
 *   reps that fill its time share, so a low punch goal no longer leaves a
 *   round's last 40-60 s without content (D26). The version also seeds
 *   selection, so every generated workout differs from its `1.2.0` plan
 *   for the same recipe and seed — not only the low-goal ones.
 * - `1.3.1` — two more ways a round stopped before its bell. The coverage
 *   repair pass is bounded by progress instead of by a count of passes, so
 *   a sprint-tempo round no longer stops 5-7 s short. And the "settle in"
 *   announcement for a long same-move stretch is paid for a rep at a time,
 *   with the round topped up afterwards, instead of by dropping whole
 *   trailing blocks — which had cost low-variety recipes (a combination cap
 *   of 2 is enough) their last 15-25 s. Same reseeding caveat as above.
 */
export const GENERATOR_VERSION = '1.3.1'

/**
 * Schema of the persisted `WorkoutRecipe` object in `workout_recipes.params_json`.
 * Bump when a field is added, removed, or changes meaning.
 */
export const RECIPE_SCHEMA_VERSION = 1

/**
 * The combo-plausibility model (§28.4, M37-02). Bump when a signal is added
 * or removed, or when the weights change — stored `combo_results` carry this
 * so an improved model can recompute history.
 */
export const CONFIDENCE_VERSION = '1.0.0'

/**
 * Derived session metrics (spec §8.6). Bump when a metric's formula changes.
 *
 * - `1.1.0` — `cue_results.offset_ms` and `timingWindowPct` are computed on
 *   the round's work clock. Under `1.0.0` the offset was a monotonic receive
 *   stamp minus a work-elapsed moment, which is the app's uptime at round
 *   start rather than a timing error: every `1.0.0` offset is meaningless and
 *   `timingWindowPct` was always 0. Those rows cannot be recalculated — the
 *   work clock's anchor was never stored — so a reader must treat `offset_ms`
 *   as absent wherever `calculation_version` is `1.0.0`.
 */
export const CALCULATION_VERSION = '1.1.0'
