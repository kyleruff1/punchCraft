/**
 * The PC app's server and the smoke test's small parts. The run itself —
 * `npm run pc:smoke` — needs a browser and is not part of this suite.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { findBrowser } from '../cdp.mjs'
import { punchesIn } from '../smoke.mjs'
import {
  buildWebApp,
  builtSha,
  checkoutSha,
  parseRange,
  resolveRequest,
  serveWebApp,
} from '../webApp.mjs'

/** A real request. (`fetch` under jest-expo is React Native's stand-in.) */
const get = (url) =>
  new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
      })
      .on('error', reject)
  })

let root
beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'pc-app-test-'))
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>app</title>')
  mkdirSync(path.join(root, 'assets', 'node_modules', 'sql.js'), { recursive: true })
  writeFileSync(path.join(root, 'assets', 'node_modules', 'sql.js', 'engine.wasm'), 'wasm')
  writeFileSync(path.join(root, 'assets', 'a b.wav'), 'riff')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('resolveRequest', () => {
  const page = () => path.join(root, 'index.html')

  it('serves a file that exists, percent-encoding and all', () => {
    expect(resolveRequest(root, '/assets/a%20b.wav')).toEqual({
      status: 200,
      file: path.join(root, 'assets', 'a b.wav'),
    })
  })

  it("answers one of the app's own screens with the page", () => {
    expect(resolveRequest(root, '/')).toEqual({ status: 200, file: page() })
    expect(resolveRequest(root, '/settings')).toEqual({ status: 200, file: page() })
    expect(resolveRequest(root, '/punchcraft/live')).toEqual({ status: 200, file: page() })
    // A directory is not a file to serve.
    expect(resolveRequest(root, '/assets')).toEqual({ status: 200, file: page() })
  })

  it('answers a missing file with 404, never with the page', () => {
    expect(resolveRequest(root, '/assets/gone.wasm')).toEqual({ status: 404 })
    expect(resolveRequest(root, '/favicon.ico')).toEqual({ status: 404 })
  })

  it('does not leave the build directory', () => {
    const outside = path.join(root, '..', 'outside.txt')
    writeFileSync(outside, 'secret')
    try {
      for (const attempt of [
        '/../outside.txt',
        '/%2e%2e/outside.txt',
        '/assets/../../outside.txt',
      ]) {
        const found = resolveRequest(root, attempt)
        expect(found.file ?? '').not.toContain('outside.txt')
        expect([403, 404]).toContain(found.status)
      }
    } finally {
      rmSync(outside, { force: true })
    }
  })

  it('answers a path that is not valid encoding with 400', () => {
    expect(resolveRequest(root, '/%E0%A4%A')).toEqual({ status: 400 })
  })
})

describe('serveWebApp', () => {
  let served
  beforeAll(async () => {
    served = await serveWebApp({ root, port: 0 })
  })
  afterAll(() => served.close())

  it('listens on the loopback address only', () => {
    expect(served.url).toBe(`http://127.0.0.1:${served.port}/`)
  })

  it('serves WebAssembly as WebAssembly, uncached', async () => {
    const res = await get(`${served.url}assets/node_modules/sql.js/engine.wasm`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/wasm')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body).toBe('wasm')
  })

  it('serves the page for a screen, and a 404 for a missing asset', async () => {
    const screen = await get(`${served.url}punchcraft/live`)
    expect(screen.headers['content-type']).toContain('text/html')
    expect(screen.body).toContain('<title>app</title>')
    expect((await get(`${served.url}assets/gone.wav`)).status).toBe(404)
  })
})

describe('buildWebApp', () => {
  it('refuses to clear a directory outside the repo’s own dist/', async () => {
    await expect(buildWebApp({ outDir: root })).rejects.toThrow(/refusing to build outside/)
    // …and did not touch it.
    expect(resolveRequest(root, '/').status).toBe(200)
  })
})

describe('findBrowser', () => {
  const env = { PROGRAMFILES: 'C:/PF', 'PROGRAMFILES(X86)': 'C:/PF86', LOCALAPPDATA: 'C:/Local' }
  const edge = path.win32.join('C:/PF86', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  const chrome = path.win32.join('C:/PF', 'Google', 'Chrome', 'Application', 'chrome.exe')

  it('prefers Chrome, falls back to Edge, and says when there is neither', () => {
    expect(findBrowser(env, 'win32', (f) => f === chrome || f === edge)).toBe(chrome)
    expect(findBrowser(env, 'win32', (f) => f === edge)).toBe(edge)
    expect(findBrowser(env, 'win32', () => false)).toBeNull()
    expect(findBrowser({}, 'win32', () => true)).toBeNull()
    expect(findBrowser({}, 'plan9', () => true)).toBeNull()
  })

  it('takes PC_SMOKE_BROWSER at its word, if the file is there', () => {
    const named = { ...env, PC_SMOKE_BROWSER: '/opt/brave' }
    expect(findBrowser(named, 'linux', (f) => f === '/opt/brave')).toBe('/opt/brave')
    expect(findBrowser(named, 'linux', () => false)).toBeNull()
  })
})

describe('punchesIn', () => {
  it('reads the count before the slash, past the tile’s label', () => {
    expect(punchesIn('PUNCHES\n12 / 237')).toBe(12)
    expect(punchesIn('PUNCHES\n1,204 / 2,000')).toBe(1204)
    expect(punchesIn('PUNCHES\n0 / 237')).toBe(0)
    expect(punchesIn(undefined)).toBe(0)
    expect(punchesIn('PUNCHES')).toBe(0)
  })
})

describe('which commit a build says it is', () => {
  let out
  const bundle = (text) => {
    const scripts = path.join(out, '_expo', 'static', 'js', 'web')
    mkdirSync(scripts, { recursive: true })
    writeFileSync(path.join(scripts, 'entry-abc.js'), text)
  }
  beforeEach(() => {
    out = mkdtempSync(path.join(os.tmpdir(), 'pc-app-sha-'))
  })
  afterEach(() => rmSync(out, { recursive: true, force: true }))

  it('reads the commit out of the app config baked into the bundle', () => {
    // As the exporter writes it: JSON inside a string, its quotes escaped.
    const escaped = JSON.stringify(
      JSON.stringify({ name: 'punchCraft', extra: { gitSha: '08719905', releaseChannel: 'dev' } }),
    )
    bundle(`__d(function(){process.env.APP_MANIFEST=${escaped}})`)
    expect(builtSha(out)).toBe('08719905')
  })

  it('reads it whether or not the quotes are escaped', () => {
    bundle('var config={"extra":{"gitSha":"1a2b3c4"}}')
    expect(builtSha(out)).toBe('1a2b3c4')
  })

  it('reads a build made where there was no git', () => {
    bundle('var config={"extra":{"gitSha":"unknown"}}')
    expect(builtSha(out)).toBe('unknown')
  })

  it('says nothing for a folder with no build, or a build that names no commit', () => {
    expect(builtSha(out)).toBeNull()
    bundle('console.log("no config here")')
    expect(builtSha(out)).toBeNull()
  })

  it('names the checkout’s commit the way the app config does', () => {
    expect(checkoutSha()).toMatch(/^[0-9a-f]{7,40}$/)
    // Not a git checkout: the same word `app.config.ts` falls back to.
    expect(checkoutSha(out)).toBe('unknown')
  })
})

describe('Range requests — how a browser resumes an audio file it suspended', () => {
  it('reads one range out of a header', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    // Past the end is clipped to it; the last bytes of a short file are all of it.
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 })
  })

  it('sends the whole file when there is no range it can use', () => {
    for (const header of [undefined, '', 'bytes=-', 'items=0-5', 'bytes=0-5,10-15', 'bytes=a-b']) {
      expect(parseRange(header, 1000)).toBeNull()
    }
  })

  it('says so when the range is outside the file', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=600-500', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable')
  })

  describe('from the server', () => {
    const BYTES = 'abcdefghijklmnopqrstuvwxyz'
    let served
    let dir
    /** A real request with headers. (`fetch` under jest-expo is React Native's stand-in.) */
    const request = (headers) =>
      new Promise((resolve, reject) => {
        http
          .get(`${served.url}clip.wav`, { headers }, (res) => {
            let body = ''
            res.setEncoding('utf8')
            res.on('data', (chunk) => (body += chunk))
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
          })
          .on('error', reject)
      })
    beforeAll(async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), 'pc-app-range-'))
      writeFileSync(path.join(dir, 'index.html'), '<!doctype html>')
      writeFileSync(path.join(dir, 'clip.wav'), BYTES)
      served = await serveWebApp({ root: dir, port: 0 })
    })
    afterAll(async () => {
      await served.close()
      rmSync(dir, { recursive: true, force: true })
    })

    it('says how long a file is, and that it takes ranges', async () => {
      const whole = await request({})
      expect(whole.status).toBe(200)
      expect(whole.body).toBe(BYTES)
      expect(whole.headers['content-length']).toBe('26')
      expect(whole.headers['accept-ranges']).toBe('bytes')
    })

    it('answers a range with that part of the file', async () => {
      const part = await request({ Range: 'bytes=5-9' })
      expect(part.status).toBe(206)
      expect(part.body).toBe('fghij')
      expect(part.headers['content-range']).toBe('bytes 5-9/26')
      expect(part.headers['content-length']).toBe('5')
      const rest = await request({ Range: 'bytes=20-' })
      expect(rest.body).toBe('uvwxyz')
      expect(rest.headers['content-range']).toBe('bytes 20-25/26')
    })

    it('refuses a range outside the file, and says how long the file is', async () => {
      const outside = await request({ Range: 'bytes=26-' })
      expect(outside.status).toBe(416)
      expect(outside.headers['content-range']).toBe('bytes */26')
    })
  })
})
