/**
 * reload-tablet — the parts that can be tested without a tablet.
 *
 * The script's device half (force-stop, relaunch, wait for the ready record)
 * has NOT been watched working: it was written with nothing attached. What
 * is covered here is every decision it makes from text — which process holds
 * Metro's port, whether that process may be stopped, which device to use,
 * whether Metro and the app are up.
 */
import {
  DEFAULT_PORT,
  devicesFromAdb,
  imageNameFromTasklist,
  isNodeImage,
  listenersFromNetstat,
  metroIsUp,
  parseArgs,
  sawReady,
} from '../reload-tablet.mjs'

describe('parseArgs', () => {
  it('restarts Metro and the app by default', () => {
    expect(parseArgs([])).toMatchObject({ metro: true, dryRun: false, port: DEFAULT_PORT })
  })

  it('reads its flags', () => {
    expect(
      parseArgs(['--no-metro', '--dry-run', '--port=8090', '--device=abc', '--ready-timeout=30']),
    ).toMatchObject({
      metro: false,
      dryRun: true,
      port: 8090,
      device: 'abc',
      readyTimeoutMs: 30_000,
    })
  })

  it.each([['--bogus'], ['--port=0'], ['--port=eighty'], ['--ready-timeout=-1']])(
    'refuses %s rather than guessing',
    (arg) => {
      expect(() => parseArgs([arg])).toThrow()
    },
  )
})

describe('finding what holds Metro’s port', () => {
  const NETSTAT = [
    '',
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1432',
    '  TCP    0.0.0.0:8081           0.0.0.0:0              LISTENING       23108',
    '  TCP    [::]:8081              [::]:0                 LISTENING       23108',
    '  TCP    127.0.0.1:18081        0.0.0.0:0              LISTENING       777',
    '  TCP    192.168.1.20:52144     192.168.1.30:8081      ESTABLISHED     23108',
  ].join('\r\n')

  it('returns each listener on the port once', () => {
    expect(listenersFromNetstat(NETSTAT, 8081)).toEqual([23108])
  })

  it('is not fooled by a port that merely ends the same way, or by a remote port', () => {
    expect(listenersFromNetstat(NETSTAT, 18081)).toEqual([777])
    expect(listenersFromNetstat(NETSTAT, 81)).toEqual([])
    expect(listenersFromNetstat(NETSTAT, 52144)).toEqual([])
  })

  it('returns nothing when the port is free', () => {
    expect(listenersFromNetstat(NETSTAT, 9999)).toEqual([])
    expect(listenersFromNetstat('', 8081)).toEqual([])
  })
})

describe('only ever stopping a Node process', () => {
  it('reads the image name from tasklist output', () => {
    expect(imageNameFromTasklist('"node.exe","23108","Console","1","98,432 K"\r\n')).toBe(
      'node.exe',
    )
    expect(imageNameFromTasklist('INFO: No tasks are running which match the criteria.')).toBeNull()
  })

  it.each([['node.exe'], ['node'], ['NODE.EXE']])('allows %s', (name) => {
    expect(isNodeImage(name)).toBe(true)
  })

  it.each([['nodemon.exe'], ['chrome.exe'], ['java.exe'], [''], [null]])('refuses %p', (name) => {
    expect(isNodeImage(name)).toBe(false)
  })
})

describe('choosing a device', () => {
  it('lists only devices that are ready', () => {
    const out = [
      'List of devices attached',
      '192.168.1.40:5555\tdevice',
      'emulator-5554\toffline',
      'R58M\tunauthorized',
      '',
    ].join('\n')
    expect(devicesFromAdb(out)).toEqual(['192.168.1.40:5555'])
  })

  it('lists nothing when nothing is attached', () => {
    expect(devicesFromAdb('List of devices attached\n\n')).toEqual([])
  })
})

describe('knowing when things are up', () => {
  it('recognises Metro’s status reply', () => {
    expect(metroIsUp('packager-status:running')).toBe(true)
    expect(metroIsUp('<html>502</html>')).toBe(false)
    expect(metroIsUp(undefined)).toBe(false)
  })

  it('recognises the app’s ready record in logcat', () => {
    const line = "I/ReactNativeJS( 8286): '[INFO] workout.app.ready', 'app ready', { fonts: true }"
    expect(sawReady(line)).toBe(true)
    expect(sawReady("I/ReactNativeJS( 8286): Running \"main\"")).toBe(false)
  })
})
