/**
 * Jest setup: the app's logging is off in tests unless asked for.
 *
 * `logger` writes through a `ConsoleSink` by default. That is right on a
 * device and wrong in a test run: the suite drives the real runner, the real
 * repositories and the real generator thousands of times, and a full run
 * printed 34,471 lines — almost all of it routine `[INFO]` records — with the
 * one failure you were looking for somewhere in the middle.
 *
 * So the sinks are emptied before each test file loads. Nothing is lost:
 *
 * - a suite that asserts on logging installs its own recording sink with
 *   `replaceSinks([...])`, exactly as before;
 * - `JEST_LOGS=1 npx jest path/to/test` restores the console output when you
 *   want to watch a run.
 *
 * Wired through `setupFiles` in jest.config.js, so it runs inside each test
 * file's own module registry — the `logger` it silences is the one the test
 * and the code under test import.
 */
import { replaceSinks } from '@diagnostics/logger'

if (process.env.JEST_LOGS !== '1') replaceSinks([])
