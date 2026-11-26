#!/usr/bin/env node
// Builds the app for a browser and serves it on this machine only.
//
//   npm run pc:app                 build, then serve on http://127.0.0.1:8788/
//   npm run pc:app -- --no-build   serve the last build as it is
//   PORT=9000 npm run pc:app
//
// See tools/pc/app/README.md for what the PC version does and does not do.
import process from 'node:process'

import { buildWebApp, DEFAULT_PORT, isBuilt, OUT_DIR, serveWebApp } from './webApp.mjs'

const build = !process.argv.includes('--no-build')
const port = Number(process.env.PORT ?? DEFAULT_PORT)

if (build) {
  console.info('Building the app for the browser (a few minutes the first time)...\n')
  await buildWebApp()
} else if (!isBuilt()) {
  console.error(`No build in ${OUT_DIR}. Run without --no-build first.`)
  process.exit(1)
}

const served = await serveWebApp({ port })
console.info(`\npunchCraft, PC version: ${served.url}\n`)
console.info('Open that address in Chrome or Edge. It runs on simulated punches;')
console.info('the gloves are not connected from here yet. Ctrl-C stops the server.\n')

const stop = async () => {
  await served.close()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
