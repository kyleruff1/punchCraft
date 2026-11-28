// The ceremonies: the walkout before round 1, and in each rest the line that
// opens it and the countdown that closes it.
//
// Each is a native playlist the app builds ahead of time and logs as it
// builds it — `intro loaded`, `recovery loaded`, `round warning prepared` —
// with how many tracks it has, how long it runs, and (for a rest line) which
// script it is. When it starts the app logs that too. A manifest says what
// each of those lines should read (`ceremony-plan.ts`); this holds a capture
// to it.
//
// What is judged is what the app BUILT and that it STARTED it. Whether it was
// heard is the sound check's business, where there is one.
//
// A countdown opens with one of fifteen lines picked at random. The app logs
// which, so the check is by arithmetic: the logged length less that opener's
// own must be the length of everything after it.
//
// A log is not always whole. A PC page's records are; a device's logcat drops
// lines under load. So a ceremony with no line at all fails a capture that
// loses nothing, and only warns on a device — unless the app itself logged
// that the playlist failed. A line that IS there and reads wrong fails
// anywhere.
import { extractField, numField } from './logcat.mjs'

/** How far before a rest's own boundary record its ceremonies' lines may fall. */
const REST_HEAD_SLACK_MS = 1000

/**
 * @typedef {object} CeremonyEvent
 * @property {string} type
 * @property {number} ts
 * @property {number} [segments]
 * @property {number} [plannedMs]
 * @property {number} [tracks]
 * @property {string} [scriptId]
 * @property {number} [round]
 * @property {string} [opener]
 * @property {number} [totalMs]
 * @property {string} [tag]
 */

/**
 * @typedef {object} CeremonyVerdict
 * @property {'walkout' | 'rest-line' | 'countdown'} kind
 * @property {number | null} roundIndex the round it follows, 0-based; null for the walkout
 * @property {'matched' | 'mismatch' | 'absent' | 'not-started' | 'unjudged' | 'unchecked'} state
 * @property {string[]} problems what read wrong, one line each
 * @property {Record<string, unknown> | null} expected
 * @property {Record<string, unknown> | null} observed
 * @property {boolean} appSaidFailed the app logged a playlist failure for it
 */

const FAILURE_MESSAGES = ["'playlist creation failed'", "'playlist play failed'", "'round warning play failed'"]
const CEREMONY_TAGS = ['workout.intro', 'workout.recovery', 'workout.warn']

/**
 * A ceremony's log record as an event, or null when the record is not one.
 * (`intro playing` is parsed by the verifier itself, as it always was.)
 *
 * @param {string} body
 * @param {number} ts
 * @returns {CeremonyEvent | null}
 */
export function parseCeremonyRecord(body, ts) {
  const built = { plannedMs: numField(body, 'plannedMs'), tracks: numField(body, 'tracks') }
  if (body.includes("'intro loaded'")) {
    return { type: 'intro.loaded', ts, segments: numField(body, 'segments'), ...built }
  }
  if (body.includes("'recovery loaded'")) {
    return { type: 'recovery.loaded', ts, scriptId: extractField(body, 'scriptId'), ...built }
  }
  if (body.includes("'recovery playing'")) {
    return { type: 'recovery.playing', ts, scriptId: extractField(body, 'scriptId') }
  }
  if (body.includes("'round warning prepared'")) {
    return {
      type: 'warn.prepared',
      ts,
      round: numField(body, 'round'),
      opener: extractField(body, 'opener'),
      totalMs: numField(body, 'totalMs'),
      ...built,
    }
  }
  if (body.includes("'round warning playing'")) {
    return { type: 'warn.playing', ts, round: numField(body, 'round') }
  }
  if (FAILURE_MESSAGES.some((message) => body.includes(message))) {
    const tag = CEREMONY_TAGS.find((t) => body.includes(t))
    if (tag) return { type: 'ceremony.failed', ts, tag }
  }
  return null
}

/**
 * The line that describes what played: the last build before the ceremony
 * started, or the last build of all when it never did. A ceremony can be
 * built more than once before it starts, and only the last one is heard.
 *
 * @param {CeremonyEvent[]} builds
 * @param {CeremonyEvent | undefined} started
 */
function buildThatPlayed(builds, started) {
  const before = started ? builds.filter((e) => e.ts <= started.ts) : builds
  return before.at(-1) ?? builds.at(-1)
}

/**
 * @param {CeremonyVerdict['kind']} kind
 * @param {number | null} roundIndex
 * @param {Record<string, unknown> | null} expected
 * @returns {CeremonyVerdict}
 */
const blank = (kind, roundIndex, expected) => ({
  kind,
  roundIndex,
  state: 'unjudged',
  problems: [],
  expected,
  observed: null,
  appSaidFailed: false,
})

/**
 * @param {CeremonyVerdict} verdict
 * @param {CeremonyEvent | undefined} build
 * @param {CeremonyEvent | undefined} started
 * @param {string[]} problems
 * @param {boolean} appSaidFailed
 */
function settle(verdict, build, started, problems, appSaidFailed) {
  verdict.appSaidFailed = appSaidFailed
  if (!build) {
    verdict.state = 'absent'
    verdict.problems = [
      appSaidFailed ? 'the app logged that its playlist failed' : 'no line for it in the capture',
    ]
    return verdict
  }
  const { type: _type, ts: _ts, ...fields } = build
  verdict.observed = fields
  if (problems.length > 0) {
    verdict.state = 'mismatch'
    verdict.problems = problems
  } else if (!started) {
    verdict.state = 'not-started'
    verdict.problems = [
      appSaidFailed ? 'built, and the app logged that it failed to play' : 'built, and never started',
    ]
  } else {
    verdict.state = 'matched'
  }
  return verdict
}

/**
 * `name: logged, where the manifest says expected` for each field that differs.
 *
 * A field the line does not carry at all is not compared: the line is from a
 * build that did not log it yet (`tracks`, before 2026-09), and that is not
 * the ceremony being wrong.
 *
 * @param {Record<string, unknown>} expected
 * @param {Record<string, unknown>} observed
 */
function differences(expected, observed) {
  const out = []
  for (const [name, want] of Object.entries(expected)) {
    if (observed[name] !== undefined && observed[name] !== want) out.push(`${name}: ${String(observed[name])}, where the manifest says ${String(want)}`)
  }
  return out
}

/**
 * Judge a capture's ceremonies against its manifest.
 *
 * `rounds` is the verifier's own account of each round: where it began
 * (`t0Ts`) and, when its closing boundary was captured, where it ended
 * (`endTs`). A rest is judged only when the capture holds it whole — the
 * round before it ended and the round after it began — because a countdown
 * is not due until the rest's last seconds.
 *
 * A manifest without ceremonies (one written before they had expectations)
 * judges nothing.
 *
 * @param {CeremonyEvent[]} events every parsed event of the capture, in order
 * @param {{ ceremonies?: { walkout?: any, countdownOpeners?: Record<string, number> }, rounds?: any[] }} manifest
 * @param {Array<{ t0Ts: number | null, endTs: number | null }>} rounds
 * @returns {CeremonyVerdict[]}
 */
export function judgeCeremonies(events, manifest, rounds) {
  const spec = manifest.ceremonies
  if (!spec) return []
  /** @type {CeremonyVerdict[]} */
  const verdicts = []
  const failedIn = (/** @type {string} */ tag, /** @type {number} */ from, /** @type {number} */ to) =>
    events.some((e) => e.type === 'ceremony.failed' && e.tag === tag && e.ts >= from && e.ts <= to)

  if (spec.walkout) {
    const want = spec.walkout
    const verdict = blank('walkout', null, want)
    const bell = rounds[0]?.t0Ts ?? null
    if (bell !== null) {
      const inLobby = (/** @type {CeremonyEvent} */ e) => e.ts <= bell
      const started = events.find((e) => e.type === 'intro.playing' && inLobby(e))
      const build = buildThatPlayed(
        events.filter((e) => e.type === 'intro.loaded' && inLobby(e)),
        started,
      )
      const problems = build
        ? differences({ segments: want.segments.length, plannedMs: want.plannedMs, tracks: want.tracks }, build)
        : []
      settle(verdict, build, started, problems, failedIn('workout.intro', -Infinity, bell))
    }
    verdicts.push(verdict)
  }

  const openers = spec.countdownOpeners ?? {}
  for (const [index, round] of (manifest.rounds ?? []).entries()) {
    if (!round.rest) continue
    const roundIndex = round.roundIndex ?? index
    const from = rounds[index]?.endTs ?? null
    const to = rounds[index + 1]?.t0Ts ?? null
    const whole = from !== null && to !== null
    const inRest = (/** @type {CeremonyEvent} */ e) => whole && e.ts >= from - REST_HEAD_SLACK_MS && e.ts <= to

    {
      const want = round.rest.restLine
      const verdict = blank('rest-line', roundIndex, want)
      if (whole) {
        const started = events.find((e) => e.type === 'recovery.playing' && inRest(e))
        const build = buildThatPlayed(
          events.filter((e) => e.type === 'recovery.loaded' && inRest(e)),
          started,
        )
        if (want === null) {
          // No script was authored for this rest: the app plays a walkthrough
          // picked from the workout's seed, which has no expectation.
          verdict.state = 'unchecked'
          if (build) verdict.observed = { scriptId: build.scriptId }
        } else {
          const problems = build
            ? differences({ scriptId: want.scriptId, plannedMs: want.plannedMs, tracks: want.tracks }, build)
            : []
          settle(verdict, build, started, problems, failedIn('workout.recovery', from - REST_HEAD_SLACK_MS, to))
        }
      }
      verdicts.push(verdict)
    }

    const want = round.rest.countdown
    if (!want) continue
    const verdict = blank('countdown', roundIndex, want)
    if (whole) {
      const started = events.find((e) => e.type === 'warn.playing' && inRest(e))
      const build = buildThatPlayed(
        events.filter((e) => e.type === 'warn.prepared' && inRest(e)),
        started,
      )
      const problems = []
      if (build) {
        problems.push(...differences({ round: want.round, tracks: want.tracks }, build))
        const openerMs = build.opener === undefined ? undefined : openers[build.opener]
        if (openerMs === undefined) {
          problems.push(`opener: ${String(build.opener)}, which is not one of the ${Object.keys(openers).length} the manifest lists`)
        } else if ((build.totalMs ?? NaN) - openerMs !== want.afterOpenerMs) {
          problems.push(
            `length after the opener: ${(build.totalMs ?? NaN) - openerMs} ms (${build.totalMs} less ${build.opener}'s ${openerMs}), where the manifest says ${want.afterOpenerMs}`,
          )
        }
      }
      settle(verdict, build, started, problems, failedIn('workout.warn', from - REST_HEAD_SLACK_MS, to))
    }
    verdicts.push(verdict)
  }
  return verdicts
}

/**
 * What the ceremonies do to a capture's verdict.
 *
 * A line that reads wrong is a failure — unless the capture and the manifest
 * are not provably the same build's (`suppressed`: a stale or unidentified
 * timeline), where it can only warn, as the verifier's other manifest gates
 * do. A ceremony with no line, or built and never started, fails a capture
 * that loses nothing (`lossless`) or one where the app said its playlist
 * failed; on a device it warns, because logcat drops lines.
 *
 * @param {CeremonyVerdict[]} verdicts
 * @param {{ lossless: boolean, suppressed: boolean }} options
 */
export function ceremonyHealth(verdicts, { lossless, suppressed }) {
  const judged = verdicts.filter((v) => v.state !== 'unjudged' && v.state !== 'unchecked')
  const mismatched = judged.filter((v) => v.state === 'mismatch')
  const missing = judged.filter((v) => v.state === 'absent' || v.state === 'not-started')
  const hard =
    !suppressed && (mismatched.length > 0 || missing.some((v) => lossless || v.appSaidFailed))
  return {
    ceremoniesDescribed: verdicts.length,
    ceremoniesJudged: judged.length,
    ceremoniesMatched: judged.filter((v) => v.state === 'matched').length,
    ceremoniesMismatched: mismatched.length,
    ceremoniesMissing: missing.length,
    hard,
    soft: !hard && (mismatched.length > 0 || missing.length > 0),
  }
}

/** `walkout`, `rest line after round 1`, `countdown into round 2`. */
export function ceremonyName(/** @type {CeremonyVerdict} */ verdict) {
  if (verdict.kind === 'walkout' || verdict.roundIndex === null) return 'walkout'
  return verdict.kind === 'rest-line'
    ? `rest line after round ${verdict.roundIndex + 1}`
    : `countdown into round ${verdict.roundIndex + 2}`
}

const STATE_TEXT = {
  matched: 'as planned',
  mismatch: '**not what the manifest says**',
  absent: '**not in the capture**',
  'not-started': '**built, never started**',
  unjudged: 'not judged — the capture does not hold it whole',
  unchecked: 'not checked — no script was authored for this rest',
}

/**
 * The report's section: one row per ceremony, and what read wrong beneath.
 *
 * @param {CeremonyVerdict[]} verdicts
 * @returns {string[]} lines; empty when the manifest describes no ceremony
 */
export function renderCeremonies(verdicts) {
  if (verdicts.length === 0) return []
  const lines = ['', '## Ceremonies', '', '| Ceremony | Result | What the app built |', '|---|---|---|']
  for (const verdict of verdicts) {
    const built = verdict.observed
      ? Object.entries(verdict.observed)
          .filter(([, value]) => value !== undefined)
          .map(([name, value]) => `${name} ${String(value)}`)
          .join(' · ')
      : '—'
    lines.push(`| ${ceremonyName(verdict)} | ${STATE_TEXT[verdict.state]} | ${built} |`)
  }
  const wrong = verdicts.filter((v) => v.problems.length > 0)
  if (wrong.length > 0) {
    lines.push('')
    for (const verdict of wrong) {
      for (const problem of verdict.problems) lines.push(`- **${ceremonyName(verdict)}** — ${problem}`)
    }
  }
  return lines
}

/** `7 of 7 ceremonies`, from a verifier report; '' when the report does not say. */
export function ceremoniesText(/** @type {any} */ report) {
  const health = report?.health
  if (!health || !Number.isInteger(health.ceremoniesJudged) || health.ceremoniesDescribed === 0) return ''
  return `${health.ceremoniesMatched} of ${health.ceremoniesJudged} ceremonies`
}
