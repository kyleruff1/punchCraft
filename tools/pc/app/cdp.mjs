// A minimal Chrome DevTools Protocol client: find a Chromium browser, start
// it headless on a throwaway profile, and drive one page.
//
// Node 22 and later have WebSocket built in, so this adds no dependency —
// which is the point: a smoke test that needs a 300 MB browser download to
// run does not get run.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

/**
 * Where Chrome or Edge is installed, or null. `PC_SMOKE_BROWSER` wins.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [platform]
 * @param {(file: string) => boolean} [exists]
 * @returns {string | null}
 */
export function findBrowser(env = process.env, platform = process.platform, exists = existsSync) {
  if (env.PC_SMOKE_BROWSER) return exists(env.PC_SMOKE_BROWSER) ? env.PC_SMOKE_BROWSER : null
  const win = (root, ...rest) => (root ? path.win32.join(root, ...rest) : null)
  const candidates = {
    win32: [
      win(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      win(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      win(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      win(env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      win(env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
    ],
  }
  return (candidates[platform] ?? []).find((file) => file !== null && exists(file)) ?? null
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Start the browser headless on a fresh profile and find its debugging port.
 *
 * The profile is a new temporary directory, removed on close: the run sees
 * no saved database, no extensions and none of the user's own browsing —
 * and leaves nothing of its own behind.
 *
 * @param {string} executable
 * @returns {Promise<{ wsUrl: string, close: () => Promise<void> }>}
 */
export async function launchBrowser(executable) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'punchcraft-smoke-'))
  const child = spawn(
    executable,
    [
      '--headless=new',
      // Port 0: the browser picks a free one and writes it to the profile.
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      // A person presses Start before any sound plays; a script does not, and
      // without this every clip is refused as autoplay.
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--window-size=1280,800',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  const close = async () => {
    child.kill()
    // The browser lets go of its profile a moment after it exits.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await rm(profile, { recursive: true, force: true })
        return
      } catch {
        await sleep(300)
      }
    }
  }
  const portFile = path.join(profile, 'DevToolsActivePort')
  for (let waited = 0; waited < 20_000; waited += 100) {
    if (child.exitCode !== null) break
    if (existsSync(portFile)) {
      const [port, wsPath] = (await readFile(portFile, 'utf8')).trim().split(/\r?\n/)
      if (port && wsPath) return { wsUrl: `ws://127.0.0.1:${port}${wsPath}`, close }
    }
    await sleep(100)
  }
  await close()
  throw new Error(`the browser did not open a debugging port: ${executable}`)
}

/**
 * Open a page and return the few verbs the smoke test needs.
 *
 * Everything the page complains about is collected as it happens: uncaught
 * exceptions and unhandled rejections, anything written with `console.error`
 * (the app's own `logger.error` among them), and failed requests.
 *
 * @param {string} wsUrl the browser's debugging address, from `launchBrowser`
 */
export async function openPage(wsUrl) {
  const socket = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('could not reach the browser')), {
      once: true,
    })
  })

  let nextId = 1
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
  const pending = new Map()
  /** @type {Array<(method: string, params: any) => void>} */
  const listeners = []
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id === undefined) {
      for (const listener of listeners) listener(message.method, message.params)
      return
    }
    const waiter = pending.get(message.id)
    pending.delete(message.id)
    if (!waiter) return
    if (message.error) waiter.reject(new Error(`${message.error.message} (${message.error.code})`))
    else waiter.resolve(message.result)
  })

  let sessionId
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  sessionId = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId

  /** @type {string[]} every console line: the app's log, one record per line */
  const consoleLines = []
  /** @type {string[]} */
  const problems = []
  /**
   * Features the browser withheld because no person has touched the page —
   * haptics, here. True of a script and of nobody else, so these are counted
   * and reported, not failed on.
   * @type {string[]}
   */
  const withheld = []
  // An object argument arrives as a preview of its fields — which, for the
  // app's log records, is the part worth reading.
  const text = (arg) =>
    arg.type === 'object' && arg.preview
      ? `{${arg.preview.properties.map((p) => `${p.name}: ${p.value}`).join(', ')}}`
      : (arg.value ?? arg.description ?? arg.unserializableValue ?? `<${arg.type}>`)
  listeners.push((method, params) => {
    if (method === 'Runtime.consoleAPICalled') {
      const line = params.args.map(text).join(' ')
      consoleLines.push(line)
      if (params.type === 'error') problems.push(`console.error: ${line}`)
    } else if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails
      problems.push(`${details.text} ${details.exception?.description ?? ''}`.trim())
    } else if (method === 'Log.entryAdded' && params.entry.source === 'intervention') {
      withheld.push(params.entry.text)
    } else if (method === 'Log.entryAdded' && params.entry.level === 'error') {
      problems.push(`${params.entry.source}: ${params.entry.text} ${params.entry.url ?? ''}`.trim())
    }
  })
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')

  /** Run an expression in the page; a promise it returns is awaited. */
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      const { text: why, exception } = result.exceptionDetails
      throw new Error(`in the page: ${why} ${exception?.description ?? ''}`.trim())
    }
    return result.result.value
  }

  /** Poll an expression until it is truthy; say what was awaited if it never is. */
  const waitFor = async (what, expression, timeoutMs = 20_000) => {
    const deadline = performance.now() + timeoutMs
    for (;;) {
      // A navigation in flight has no page to ask; that is "not yet".
      const value = await evaluate(expression).catch(() => undefined)
      if (value) return value
      if (performance.now() > deadline) {
        throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`)
      }
      await sleep(250)
    }
  }

  return {
    consoleLines,
    problems,
    withheld,
    evaluate,
    waitFor,
    goto: (url) => send('Page.navigate', { url }),
    /** Whether the app has logged a record with this code since `from`. */
    logged: (code, from = 0) => consoleLines.slice(from).some((line) => line.includes(code)),
    close: () => socket.close(),
  }
}

export { sleep }
