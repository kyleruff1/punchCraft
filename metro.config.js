const { getDefaultConfig } = require('expo/metro-config')

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname)

// The PC version's database engine is WebAssembly (`src/storage/database.web.ts`
// imports sql.js's `.wasm` and gets back the URL it is served at). Only the
// web build reaches that import; the tablet's bundle is unchanged.
config.resolver.assetExts.push('wasm')

module.exports = config
