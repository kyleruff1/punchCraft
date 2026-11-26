/**
 * The glove check page imports the app's REAL punch stream, adapter, decoder
 * and Web Bluetooth transport — that is its whole point. So that import graph
 * has to stay runnable in a plain browser page: one `react-native`, Expo or
 * native-BLE import anywhere along it and the page stops loading, with nothing
 * else in the repo noticing. This bundles the page the way `serve.mjs` does and
 * looks at what went in.
 */
import path from 'node:path'

import { build } from 'esbuild'

import { bundleOptions } from '../bundle.mjs'

const dir = path.join(__dirname, '..')

describe('the glove check bundle', () => {
  let result
  let inputs

  beforeAll(async () => {
    result = await build({
      ...bundleOptions(dir),
      write: false,
      metafile: true,
      sourcemap: false,
    })
    inputs = Object.keys(result.metafile.inputs)
  })

  it('builds for a browser with no errors or warnings', () => {
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.outputFiles).toHaveLength(1)
  })

  it('contains the real stream, adapter, decoder and transport — not copies', () => {
    expect(inputs).toEqual(
      expect.arrayContaining([
        'src/protocol/PunchStream.ts',
        'src/protocol/fightcamp-v1/FightCampV1Adapter.ts',
        'src/protocol/fightcamp-v1/FightCampV1Decoder.ts',
        'src/protocol/fightcamp-v1/FightCampV1Keepalive.ts',
        'src/ble/BleManagerWebBluetoothImpl.ts',
        'src/ble/bondDiagnosis.ts',
      ]),
    )
  })

  it('pulls in nothing from node_modules: no React Native, Expo or native BLE', () => {
    expect(inputs.filter((file) => file.includes('node_modules'))).toEqual([])
    expect(inputs.filter((file) => /BlePlx|react|expo/i.test(file))).toEqual([])
  })
})
