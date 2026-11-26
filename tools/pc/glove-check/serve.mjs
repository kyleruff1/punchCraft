#!/usr/bin/env node
// Serves the PC glove check on this machine only.
//
//   npm run pc:glove-check          then open the printed address in Chrome or Edge
//   PORT=9000 npm run pc:glove-check
//
// Web Bluetooth needs a secure context, and a loopback address counts as one —
// so this binds 127.0.0.1 and nothing else: the page is not reachable from the
// network. The bundle is rebuilt in memory on every page load; nothing is
// written to disk, so there is no build output to ignore or to go stale.
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { context } from 'esbuild'

import { bundleOptions } from './bundle.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const HOST = '127.0.0.1'
const port = Number(process.env.PORT ?? 8787)

// `write: false` is what keeps the bundle in memory: without it esbuild
// writes `main.js` beside the sources on every rebuild.
const ctx = await context({ ...bundleOptions(here), write: false, logLevel: 'warning' })

// Fail now, with the compiler's message, rather than on the first page load.
await ctx.rebuild()

const served = await ctx.serve({ servedir: here, host: HOST, port })

console.info(`\npunchCraft glove check: http://${HOST}:${served.port}/\n`)
console.info('Open that address in Chrome or Edge (not Firefox: it has no Web Bluetooth).')
console.info('Blue is left, red is right. Ctrl-C stops the server.\n')

const stop = async () => {
  await ctx.dispose()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
