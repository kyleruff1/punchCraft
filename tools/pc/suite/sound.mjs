// What the sound tap heard, set beside what the app says it played.
//
// The tap (`soundTap.mjs`) reports plays and stretches of sound per `<audio>`
// element, on the page's clock. The app's log says which clip each play was,
// when it was scheduled, and when the ring it leads is due. Joining the two
// gives the one number the whole coach is built around, measured instead of
// modelled: how long before its ring a call stopped sounding.
import { fitWorkAxis, roundWindows } from '../../analysis/observed-timing.mjs'
import { fieldsOf, recordsOf } from './capture.mjs'
import {
  bellsAt,
  ceremoniesOf,
  ceremonyFindings,
  isCut,
  isSilent,
  namedClips,
} from './ceremonies.mjs'
import { appStopTimes, clipKind, stopReasonOf } from './plays.mjs'
import { spread } from './stats.mjs'

/**
 * @typedef {object} ElementPlay one call to `play()` on one element, and what followed it
 * @property {number} id the element
 * @property {number} playAtMs when `play()` was called
 * @property {string} src the last part of the element's address
 * @property {ReturnType<typeof clipKind>} kind what it was playing, from that name
 * @property {number} volume the element's volume at the call (0 when muted)
 * @property {number | null} durationMs the element's own length, once known
 * @property {number | null} playingAtMs when the element said it was playing
 * @property {{ startMs: number, endMs: number | null, peak: number | null }[]} sound stretches of sound, in order
 * @property {string | null} stoppedBy `pause`, `ended`, `emptied`, or `replayed` — whichever came first
 * @property {number | null} stoppedAtMs
 * @property {number | null} stoppedPositionMs where the element's playhead was when it stopped
 * @property {string | null} error the media error the element reported while playing it, if it did
 */

/**
 * The tap's events as plays. A play runs from one `play()` on an element to
 * the next `play()` on the same element; a stretch of sound still open when
 * the next play begins is closed there, and carries on as the new play's.
 *
 * @param {any[]} events
 * @returns {ElementPlay[]}
 */
export function playsFrom(events) {
  const ordered = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.id !== undefined && Number.isFinite(event.atMs))
    .sort((a, b) => a.event.atMs - b.event.atMs || a.index - b.index)
  /** @type {Map<number, ElementPlay>} */
  const current = new Map()
  /** @type {ElementPlay[]} */
  const plays = []
  for (const { event } of ordered) {
    if (event.type === 'play') {
      const before = current.get(event.id)
      // An element played again while it is still sounding never falls
      // silent, so the follower reports no new start: the stretch is handed
      // from the old play to the new one at the moment of the play.
      const open = before?.sound.at(-1)
      const stillSounding = open !== undefined && open.endMs === null
      if (stillSounding) open.endMs = event.atMs
      const play = {
        id: event.id,
        playAtMs: event.atMs,
        src: event.src ?? '',
        kind: clipKind(event.src ?? ''),
        volume: event.volume ?? 1,
        durationMs: event.durationMs ?? null,
        playingAtMs: null,
        sound: stillSounding ? [{ startMs: event.atMs, endMs: null, peak: null }] : [],
        stoppedBy: null,
        stoppedAtMs: null,
        stoppedPositionMs: null,
        error: null,
      }
      // Played again before it had stopped: this play's position, taken
      // before the element restarts, is where the last one was cut off.
      if (before && before.stoppedBy === null) {
        before.stoppedBy = 'replayed'
        before.stoppedAtMs = event.atMs
        before.stoppedPositionMs = event.positionMs ?? null
      }
      current.set(event.id, play)
      plays.push(play)
      continue
    }
    const play = current.get(event.id)
    if (!play) continue
    if (event.type === 'playing') {
      play.playingAtMs ??= event.atMs
      play.durationMs ??= event.durationMs ?? null
    } else if (event.type === 'error') {
      // The element's own word that it could not play: a media error.
      play.error ??= event.error ?? 'a media error'
    } else if (event.type === 'sound-start') {
      play.sound.push({ startMs: event.atMs, endMs: null, peak: null })
    } else if (event.type === 'sound-end') {
      const open = play.sound.at(-1)
      if (open && open.endMs === null) {
        open.endMs = event.atMs
        open.peak = event.peak ?? null
      }
    } else if (event.type === 'pause' || event.type === 'ended' || event.type === 'emptied') {
      if (play.stoppedBy === null) {
        play.stoppedBy = event.type
        play.stoppedAtMs = event.atMs
        play.stoppedPositionMs = event.positionMs ?? null
        play.durationMs ??= event.durationMs ?? null
      }
    }
  }
  return plays
}

/** When a play first sounded, and when it last did; nulls if it never did, or has not stopped. */
export function heardSpan(play) {
  const first = play.sound[0]
  const last = play.sound.at(-1)
  return { firstSoundMs: first ? first.startMs : null, lastSoundMs: last ? last.endMs : null }
}

/**
 * The kinds of element a call or lead-in can be playing on: a downloaded
 * copy, a lead-in played from its file, or — when nothing else answered —
 * the source-less element a download-first player starts on. `other` is a
 * file this suite has no name for.
 */
const CALL_KINDS = ['downloaded', 'lead-in', 'phantom', 'other']

/** How long after the app dispatched a clip its element's `play()` may fall and still be that clip. */
export const PLAY_MATCH_WINDOW_MS = 250
/** How far an element's own length may be from the clip's stated one and still be that clip. */
export const LENGTH_MATCH_MS = 300

/**
 * @typedef {object} HeardClip a call or lead-in the app played, and what was heard of it
 * @property {string | null} playId
 * @property {string | null} traceId
 * @property {string} text
 * @property {string | null} path `fresh` (a player made for this play) or `armed` (one reused)
 * @property {number} statedMs the clip's stated length
 * @property {number} volume the volume it was played at; 0 is a clip ducked on purpose
 * @property {number} dispatchMs when the app sent it to play, on the page's clock
 * @property {number | null} element the element that played it, or null if none could be found
 * @property {number | null} firstSoundMs
 * @property {number | null} lastSoundMs
 * @property {number | null} stoppedShortMs how far short of its end the element's playhead was when it stopped
 * @property {ElementPlay | null} play the element play itself
 */

/**
 * Find, for each call and lead-in the app logged, the element play that was
 * it. Matched on time and length: the app calls `play()` in the same breath
 * as it logs the dispatch.
 *
 * Two elements can answer one dispatch. A player made for a clip it has yet
 * to download starts on an element with no source and swaps to a second one
 * a few milliseconds later; `play()` is called on both, and only the second
 * sounds. So an element that sounded is preferred to one that did not.
 *
 * @param {import('../app/recordTap.mjs').PageRecord[]} records
 * @param {ElementPlay[]} plays
 * @returns {HeardClip[]}
 */
export function heardClips(records, plays) {
  const claimed = new Set()
  const clips = []
  for (const record of recordsOf(records, 'workout.voice.play')) {
    const f = fieldsOf(record)
    if (f.kind !== 'click-script' || !Number.isFinite(f.dispatchMs)) continue
    const candidates = plays
      .filter(
        (play) =>
          !claimed.has(play) &&
          // A bell or a countdown clip can start in the same instant as a
          // call. Its file name says it is not one.
          CALL_KINDS.includes(play.kind) &&
          play.playAtMs >= f.dispatchMs - 5 &&
          play.playAtMs <= f.dispatchMs + PLAY_MATCH_WINDOW_MS &&
          (play.durationMs === null || Math.abs(play.durationMs - f.durationMs) <= LENGTH_MATCH_MS),
      )
      .sort(
        (a, b) =>
          Number(b.sound.length > 0) - Number(a.sound.length > 0) ||
          Math.abs(a.playAtMs - f.dispatchMs) - Math.abs(b.playAtMs - f.dispatchMs),
      )
    const play = candidates[0] ?? null
    if (play) claimed.add(play)
    clips.push({
      playId: f.playId ?? null,
      traceId: f.traceId ?? null,
      text: f.text ?? '',
      path: f.path ?? null,
      statedMs: f.durationMs,
      volume: f.volume ?? 1,
      dispatchMs: f.dispatchMs,
      element: play ? play.id : null,
      play,
      ...(play ? heardSpan(play) : { firstSoundMs: null, lastSoundMs: null }),
      /** How far short of its own end the element's playhead was when it stopped; null if it has not. */
      stoppedShortMs:
        play && play.stoppedPositionMs !== null && play.durationMs !== null
          ? play.durationMs - play.stoppedPositionMs
          : null,
    })
  }
  return clips
}

/**
 * Each heard clip against the schedule: when it was due to be sent, when the
 * ring it leads is due, and so how long the gap between its last sound and
 * that ring was.
 *
 * The ring's time is its *scheduled* time, carried from the work clock to
 * the page's clock by the tablet analyzer's own fit. Not the time the runner
 * logged the ring token: that is a 50 ms loop's telemetry, it runs late on a
 * busy machine, and a check measured against it would get easier to pass
 * the harder the machine was working.
 *
 * @param {import('../app/recordTap.mjs').PageRecord[]} records
 * @param {HeardClip[]} clips
 */
export function clipTimings(records, clips) {
  const tokenDue = recordsOf(records, 'workout.cue.tokenDue').map(fieldsOf)
  const boundaries = recordsOf(records, 'workout.round.boundary').map(fieldsOf)
  const fit = fitWorkAxis(tokenDue, boundaries)
  const windows = roundWindows(boundaries, tokenDue)
  const dispatches = recordsOf(records, 'workout.clickScript.dispatch').map(fieldsOf)
  return clips.map((clip) => {
    // A trace id is the slot and its work time, so it repeats every round:
    // the dispatch nearest in time is the one.
    const dispatch = dispatches
      .filter(
        (d) => d.traceId === clip.traceId && Math.abs(d.monotonicTimeMs - clip.dispatchMs) < 2_000,
      )
      .sort(
        (a, b) =>
          Math.abs(a.monotonicTimeMs - clip.dispatchMs) -
          Math.abs(b.monotonicTimeMs - clip.dispatchMs),
      )[0]
    const round = dispatch
      ? windows.find(
          (w) => dispatch.monotonicTimeMs >= w.startMs && dispatch.monotonicTimeMs < w.endMs,
        )
      : undefined
    const offsetMs = round ? (fit.get(round.roundIndex)?.offsetMs ?? null) : null
    const onPage = (workMs) =>
      offsetMs === null || !Number.isFinite(workMs) ? null : workMs + offsetMs
    const ringDueMs = dispatch ? onPage(dispatch.firstNodeMs) : null
    const dueToSendMs = dispatch ? onPage(dispatch.dispatchAtMs) : null
    const heard = clip.firstSoundMs !== null && clip.lastSoundMs !== null
    return {
      ...clip,
      kind: dispatch?.kind ?? null,
      slot: dispatch?.slot ?? null,
      roundIndex: round?.roundIndex ?? null,
      intendedBreathMs: dispatch?.breathMs ?? null,
      dispatchLateMs: dispatch?.lateMs ?? null,
      /** Last sound to the ring's scheduled time. Zero or less: still sounding when the ring was due. */
      breathMs: heard && ringDueMs !== null ? ringDueMs - clip.lastSoundMs : null,
      /** First sound after the app sent the clip to play. Through the tap: see `soundTap.mjs`. */
      startAfterDispatchMs: clip.firstSoundMs === null ? null : clip.firstSoundMs - clip.dispatchMs,
      /** First sound after the clip was *due* to be sent: the dispatch's lateness and the start, together. */
      startAfterScheduleMs:
        clip.firstSoundMs === null || dueToSendMs === null ? null : clip.firstSoundMs - dueToSendMs,
      heardMs: heard ? clip.lastSoundMs - clip.firstSoundMs : null,
    }
  })
}

const round1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10)

/** A clip in a few fields, for a list in a report. */
const brief = (clip) => ({
  slot: clip.slot,
  text: clip.text.slice(0, 60),
  roundIndex: clip.roundIndex,
  path: clip.path,
  breathMs: round1(clip.breathMs),
  heardMs: round1(clip.heardMs),
  stoppedShortMs: round1(clip.stoppedShortMs),
  statedMs: clip.statedMs,
  dispatchLateMs: clip.dispatchLateMs,
  element: clip.element,
  stop: clip.stop ?? null,
})

/**
 * What one drive sounded like, as numbers.
 *
 * Only calls and lead-ins are judged — the clips the rings wait on. Bells,
 * the intro, the countdown and the metronome play through other players;
 * they are counted here as `otherPlays` and nothing more is said of them.
 *
 * @param {import('../app/recordTap.mjs').PageRecord[]} records
 * @param {any[]} events the tap's events
 * @param {{ floorMs: number, truncationMs: number }} limits the tablet gate's own thresholds, handed in
 */
export function soundReport(records, events, { floorMs, truncationMs }) {
  const ready = events.find((e) => e.type === 'tap-ready') ?? null
  const plays = playsFrom(events)
  const appStops = appStopTimes(records)
  const clips = clipTimings(records, heardClips(records, plays)).map((clip) => ({
    ...clip,
    /** Why its play stopped; null when no element answered the dispatch. */
    stop: clip.play ? stopReasonOf(clip.play, { appStops, truncationMs }) : null,
  }))
  const claimed = new Set(clips.map((clip) => clip.play))
  // The clips the app plays by name — the bell above all — take their own
  // element plays out of "everything else".
  const named = namedClips(records, plays, { claimed, appStops, truncationMs })
  const boundaries = bellsAt(records, named)
  const place = (b) => ({ transition: b.transition, roundIndex: b.roundIndex })
  const otherNamed = named.filter((clip) => clip.asset !== 'bell')
  const nameOf = (clip) => ({ asset: clip.asset, stoppedShortMs: round1(clip.stoppedShortMs) })
  // The intro, each countdown and each rest line: several clips back to back.
  const ceremonies = ceremonyFindings(
    ceremoniesOf(records, plays, { claimed, appStops, truncationMs }),
    boundaries,
    truncationMs,
  )
  // Everything else the page played. An element that never had a source is
  // not a play of anything.
  const others = plays.filter((play) => !claimed.has(play) && play.kind !== 'phantom')
  // A clip played at volume 0 was ducked on purpose; silence is what it is for.
  const audible = clips.filter((c) => c.volume > 0)
  const silent = audible.filter((c) => c.firstSoundMs === null)
  // Still sounding when the capture stopped: nothing can be said of its end.
  const unfinished = audible.filter((c) => c.firstSoundMs !== null && c.lastSoundMs === null)
  const heard = audible.filter((c) => c.heardMs !== null)
  // Cut short is judged by the playhead, not by the sound: where the element
  // was in the clip when it stopped. What is heard of a clip that played to
  // its end is still 60-150 ms less than the file's length — its own quiet
  // head and tail, under the follower's threshold — and that is not a cut.
  //
  // And short of its end is not yet cut: the app stops some clips itself and
  // says so, and a run ends while something is still playing. A clip is cut
  // when nothing accounts for it — or when its own element was played again.
  const cutShort = audible.filter((c) => c.stop === 'unexplained' || c.stop === 'replayed')
  const calls = heard.filter((c) => c.kind === 'call' && c.breathMs !== null)
  const leadIns = heard.filter((c) => c.kind === 'lead-in')
  const underFloor = calls.filter((c) => c.breathMs < floorMs)
  const byPath = (path) =>
    spread(heard.filter((c) => c.path === path).map((c) => c.startAfterDispatchMs))
  return {
    tap: {
      ready: ready !== null,
      state: ready?.state ?? null,
      sampleRate: ready?.sampleRate ?? null,
      failures: events.filter((e) => e.type === 'tap-failed').map((e) => String(e.error)),
    },
    clips: {
      played: clips.length,
      ducked: clips.length - audible.length,
      heard: heard.length,
      unfinished: unfinished.length,
      silent: silent.map(brief),
      cutShort: cutShort.map(brief),
    },
    calls: {
      n: calls.length,
      /** Last sound to the ring's scheduled time. */
      breath: spread(calls.map((c) => c.breathMs)),
      intendedBreathMs: [...new Set(calls.map((c) => round1(c.intendedBreathMs)))].sort(
        (a, b) => a - b,
      ),
      floorMs,
      underFloor: underFloor.length,
      underFloorRatio:
        calls.length === 0 ? 0 : Math.round((underFloor.length / calls.length) * 1000) / 1000,
      pastRing: calls.filter((c) => c.breathMs <= 0).map(brief),
      tightest: [...calls]
        .sort((a, b) => a.breathMs - b.breathMs)
        .slice(0, 5)
        .map(brief),
    },
    leadIns: { n: leadIns.length },
    /** A bell marks every round start, round end and finish. */
    bells: {
      expected: boundaries.length,
      rung: boundaries.filter((b) => b.bell !== null).length,
      missing: boundaries.filter((b) => b.bell === null).map(place),
      silent: boundaries.filter((b) => b.bell !== null && isSilent(b.bell)).map(place),
      cutShort: boundaries.filter((b) => b.bell !== null && isCut(b.bell)).map(place),
      /** First sound after the boundary it marks. Reported, not judged. */
      afterBoundary: spread(boundaries.map((b) => b.soundsAfterMs)),
    },
    /** The intro, the countdowns and the rest lines (`ceremonyFindings`). */
    ceremonies: {
      found: ceremonies.found,
      broken: ceremonies.broken,
      cutByApp: ceremonies.cutByApp,
      talkedOver: ceremonies.talkedOver,
      mixedVolumes: ceremonies.mixedVolumes,
      /** A countdown's last word to the first sound of its bell. Reported, not judged. */
      countdownToBell: spread(ceremonies.countdownToBellMs),
    },
    /** The other clips the app plays by name: lead-ins it speaks from a file, and the like. */
    named: {
      played: otherNamed.length,
      heard: otherNamed.filter((clip) => clip.firstSoundMs !== null).length,
      silent: otherNamed.filter(isSilent).map(nameOf),
      cutShort: otherNamed.filter(isCut).map(nameOf),
    },
    start: {
      afterDispatch: spread(heard.map((c) => c.startAfterDispatchMs)),
      afterSchedule: spread(heard.map((c) => c.startAfterScheduleMs)),
      fresh: byPath('fresh'),
      armed: byPath('armed'),
    },
    length: { truncationMs, heardMinusStated: spread(heard.map((c) => c.heardMs - c.statedMs)) },
    otherPlays: others.length,
    /** Those, by what they were: `{ bell: 3, silence: 6, … }`. */
    otherKinds: others.reduce(
      (tally, play) => ({ ...tally, [play.kind]: (tally[play.kind] ?? 0) + 1 }),
      {},
    ),
  }
}

const cell = (v) => (v === null || v === undefined ? '—' : String(v))
const row = (label, s) =>
  `| ${label} | ${s.n} | ${cell(s.minMs)} | ${cell(s.medianMs)} | ${cell(s.p95Ms)} | ${cell(s.maxMs)} |`

/** The report as text, for the drive's folder. */
export function renderSoundReport(report, title) {
  const { tap, clips, calls, start, length } = report
  const L = [
    `# Sound — ${title}`,
    '',
    tap.ready
      ? `measured in the page · ${tap.sampleRate} Hz · context ${tap.state}`
      : '**the sound tap did not start — nothing below was measured**',
    ...tap.failures.map((f) => `- tap failure: ${f}`),
    '',
    `calls and lead-ins: ${clips.played} played · ${clips.heard} heard · ${clips.silent.length} silent · ${clips.cutShort.length} cut short · ${clips.ducked} ducked on purpose · ${clips.unfinished} still sounding when the capture stopped`,
    `bells: ${report.bells.rung} of ${report.bells.expected} round boundaries rung · ${report.bells.silent.length} silent · ${report.bells.cutShort.length} cut · first sound ${cell(report.bells.afterBoundary.medianMs)} ms after the boundary (most ${cell(report.bells.afterBoundary.maxMs)})`,
    `intro, countdowns and rest lines: ${
      Object.entries(report.ceremonies.found)
        .map(([kind, n]) => `${n} ${kind}`)
        .join(', ') || 'none'
    } · ${report.ceremonies.broken.length} did not play whole · ${report.ceremonies.cutByApp.length} cut off by the app · countdown’s last word → bell ${cell(report.ceremonies.countdownToBell.medianMs)} ms (least ${cell(report.ceremonies.countdownToBell.minMs)})`,
    `clips played by name: ${report.named.played} played · ${report.named.heard} heard · ${report.named.silent.length} silent · ${report.named.cutShort.length} cut`,
    `other plays: ${report.otherPlays}${
      report.otherPlays > 0
        ? ` (${Object.entries(report.otherKinds)
            .map(([kind, n]) => `${n} ${kind}`)
            .join(', ')})`
        : ''
    } — counted, not judged`,
    '',
    '| ms | n | least | median | p95 | most |',
    '|---|---|---|---|---|---|',
    row('last sound → its ring due (calls)', calls.breath),
    row('first sound after dispatch', start.afterDispatch),
    row('… on a player made for the play', start.fresh),
    row('… on a player reused', start.armed),
    row('first sound after its scheduled send', start.afterSchedule),
    row('heard length − stated length', length.heardMinusStated),
    '',
    `intended gap before the ring: ${calls.intendedBreathMs.join(' / ') || '—'} ms · floor ${calls.floorMs} ms: ${calls.underFloor} of ${calls.n} under · **still sounding when the ring was due: ${calls.pastRing.length}**`,
  ]
  const list = (heading, items, line) => {
    if (items.length === 0) return
    L.push('', `## ${heading}`)
    for (const item of items) L.push(`- ${line(item)}`)
  }
  const named = (c) =>
    `${c.slot ?? '(no dispatch record)'} · round ${c.roundIndex === null ? '—' : c.roundIndex + 1} · “${c.text}”`
  list(
    'Silent',
    clips.silent,
    (c) =>
      `${named(c)} — ${c.element === null ? 'no audio element answered the dispatch' : 'its element played and no sound came'}`,
  )
  list(
    'Cut short',
    clips.cutShort,
    (c) =>
      `${named(c)} — stopped with ${cell(c.stoppedShortMs)} ms of its ${c.statedMs} left unplayed`,
  )
  list(
    'Still sounding when the ring was due',
    calls.pastRing,
    (c) => `${named(c)} — ${cell(c.breathMs)} ms`,
  )
  list(
    'Tightest calls',
    calls.tightest,
    (c) =>
      `${named(c)} — ${cell(c.breathMs)} ms before its ring, sent ${cell(c.dispatchLateMs)} ms late`,
  )
  L.push(
    '',
    'Measured where the sound enters the browser’s mixer, against the schedule. The speaker is a further, constant delay. These are this PC’s figures; no tablet constant is set from them.',
    '',
  )
  return L.join('\n')
}

/**
 * The sound report as a verdict.
 *
 * Hard — the coach did something wrong that a person would hear:
 * - a call or lead-in was played at full volume and made no sound;
 * - a clip was stopped before its end, past the allowance;
 * - a call was still sounding when the ring it leads was due.
 *
 * Soft:
 * - more than `floorRatio` of the calls stopped under the floor before their
 *   ring. The floor is a comfort target and the share is the tablet gate's
 *   own; being past the ring has no tolerance at all.
 * - the tap did not start, or could not listen to an element. That is a
 *   broken instrument, not a broken coach: nothing is failed on its word, and
 *   nothing is passed on its silence either.
 *
 * @param {ReturnType<typeof soundReport>} report
 * @param {{ floorRatio: number }} limits
 * @returns {{ verdict: 'PASS' | 'WARN' | 'FAIL', hard: string[], soft: string[] }}
 */
export function soundVerdict(report, { floorRatio }) {
  const hard = []
  const soft = []
  const named = (c) =>
    `${c.slot ?? 'a clip with no dispatch record'}, round ${c.roundIndex === null ? '—' : c.roundIndex + 1}`
  if (!report.tap.ready) {
    // With no tap every clip reads as silent. Say the one true thing instead.
    return {
      verdict: 'WARN',
      hard,
      soft: ['the sound tap did not start, so no clip was listened to'],
    }
  }
  if (report.tap.failures.length > 0) {
    soft.push(
      `the sound tap could not listen to ${report.tap.failures.length} element(s): ${report.tap.failures[0]}`,
    )
  }
  const { silent, cutShort } = report.clips
  if (silent.length > 0) {
    hard.push(`${silent.length} clip(s) were played and made no sound — first: ${named(silent[0])}`)
  }
  if (cutShort.length > 0) {
    const c = cutShort[0]
    hard.push(
      `${cutShort.length} clip(s) were stopped more than ${report.length.truncationMs} ms before their end — first: ${named(c)}, ${c.stoppedShortMs} ms of its ${c.statedMs} left unplayed`,
    )
  }
  const at = (b) => `${b.transition.replace('-entered', '')} of round ${b.roundIndex + 1}`
  const { bells } = report
  const byName = report.named
  if (bells.missing.length > 0) {
    hard.push(
      `${bells.missing.length} round boundary(ies) had no bell — first: ${at(bells.missing[0])}`,
    )
  }
  if (bells.silent.length > 0) {
    hard.push(
      `${bells.silent.length} bell(s) rang and made no sound — first: ${at(bells.silent[0])}`,
    )
  }
  if (bells.cutShort.length > 0) {
    hard.push(
      `${bells.cutShort.length} bell(s) were stopped before their end — first: ${at(bells.cutShort[0])}`,
    )
  }
  if (byName.silent.length > 0) {
    hard.push(
      `${byName.silent.length} named clip(s) were played and made no sound — first: ${byName.silent[0].asset}`,
    )
  }
  if (byName.cutShort.length > 0) {
    const c = byName.cutShort[0]
    hard.push(
      `${byName.cutShort.length} named clip(s) were stopped before their end — first: ${c.asset}, ${c.stoppedShortMs} ms left unplayed`,
    )
  }
  const { broken, cutByApp, talkedOver, mixedVolumes } = report.ceremonies
  if (broken.length > 0) {
    hard.push(
      `${broken.length} ceremony(ies) did not play as the app said — first: ${broken[0].label}: ${broken[0].why}`,
    )
  }
  for (const cut of cutByApp) {
    const lost =
      cut.clipsUnreached > 0
        ? `${cut.clipsUnreached} of its clips never started`
        : `${cut.unplayedMs} ms of it was never heard`
    const how =
      cut.name === 'countdown'
        ? 'the bell cut the'
        : cut.name === 'intro'
          ? 'the round began over the'
          : 'the rest ended over the'
    soft.push(`${how} ${cut.label}: ${lost}`)
  }
  for (const over of talkedOver) {
    soft.push(`the rest line was still sounding ${over.overlapMs} ms into ${over.label}`)
  }
  for (const mixed of mixedVolumes) {
    soft.push(`${mixed.label} played its clips at different volumes (${mixed.volumes.join(', ')})`)
  }
  const { pastRing, underFloor, underFloorRatio, n, floorMs, breath } = report.calls
  if (pastRing.length > 0) {
    const worst = [...pastRing].sort((a, b) => a.breathMs - b.breathMs)[0]
    hard.push(
      `${pastRing.length} call(s) were still sounding when their ring was due — worst: ${named(worst)}, ${Math.abs(worst.breathMs)} ms past it`,
    )
  }
  if (n > 0 && underFloorRatio > floorRatio) {
    soft.push(
      `${underFloor} of ${n} calls (${Math.round(underFloorRatio * 1000) / 10}%) stopped less than ${floorMs} ms before their ring — the least ${breath.minMs} ms`,
    )
  }
  return { verdict: hard.length > 0 ? 'FAIL' : soft.length > 0 ? 'WARN' : 'PASS', hard, soft }
}
