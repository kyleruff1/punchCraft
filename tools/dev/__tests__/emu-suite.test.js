/**
 * emu-suite — the parts that decide, without a device.
 *
 * What is tested here is every place the script says no: the wrong device,
 * the wrong build, a database root has left its mark on. The parts that
 * drive adb are proven by running it (docs/dev-setup.md).
 */
import {
  ARCH,
  avdNameFrom,
  DEFAULT_AVD,
  DEFAULT_PORT,
  deviceRefusal,
  emulatorArgs,
  gradleInvocation,
  grantedIn,
  isAndroidSource,
  needsBuild,
  parseArgs,
  qaModeIsOn,
  qaModeSql,
  QA_VALUE,
  rootOwned,
  serialFor,
  shaFromSum,
  suiteArguments,
} from '../emu-suite.mjs'

describe('arguments', () => {
  it('keeps its own flags and passes the rest to the verify suite', () => {
    const opts = parseArgs([
      '--only=quick-one-two',
      '--no-build',
      '--first-round-only',
      '--keep-running',
      '--vocab=both',
    ])
    expect(opts).toMatchObject({
      build: false,
      keepRunning: true,
      prepare: false,
      avd: DEFAULT_AVD,
      port: DEFAULT_PORT,
    })
    expect(opts.suiteArgs).toEqual(['--only=quick-one-two', '--first-round-only', '--vocab=both'])
  })

  it('refuses --device: the device is the emulator it manages', () => {
    expect(() => parseArgs(['--device=emulator-5554'])).toThrow(/--device is not taken here/)
    expect(() => parseArgs(['--device'])).toThrow(/--device is not taken here/)
  })

  it('takes only an emulator port above the first one', () => {
    // 5554 is the first emulator a PC starts — here, another project's.
    expect(() => parseArgs(['--port=5554'])).toThrow(/--port/)
    expect(() => parseArgs(['--port=5557'])).toThrow(/--port/)
    expect(() => parseArgs(['--port=80'])).toThrow(/--port/)
    expect(parseArgs(['--port=5558']).port).toBe(5558)
  })

  it('takes only a plain AVD name', () => {
    expect(() => parseArgs(['--avd=a b; rm -rf'])).toThrow(/--avd/)
    expect(parseArgs(['--avd=punchcraft-emu-2']).avd).toBe('punchcraft-emu-2')
  })
})

describe('the emulator', () => {
  it('is named by its port', () => {
    expect(serialFor(5556)).toBe('emulator-5556')
  })

  it('starts cold, with no window', () => {
    expect(emulatorArgs({ avd: 'punchcraft-emu', port: 5556 })).toEqual([
      '-avd',
      'punchcraft-emu',
      '-no-window',
      '-no-snapshot',
      '-no-boot-anim',
      '-gpu',
      'host',
      '-port',
      '5556',
    ])
  })

  it('reads the AVD name adb reports, with its trailing OK', () => {
    expect(avdNameFrom('punchcraft-emu\r\nOK\r\n')).toBe('punchcraft-emu')
    expect(avdNameFrom('helioscape-dev\nOK\n')).toBe('helioscape-dev')
    expect(avdNameFrom('')).toBeNull()
    expect(avdNameFrom(undefined)).toBeNull()
  })

  it('is used only when it is an emulator, and the one asked for', () => {
    const base = { serial: 'emulator-5556', expectedAvd: 'punchcraft-emu' }
    expect(deviceRefusal({ ...base, isEmulator: true, avdName: 'punchcraft-emu' })).toBeNull()
    expect(deviceRefusal({ ...base, isEmulator: true, avdName: 'helioscape-dev' })).toMatch(
      /is the AVD 'helioscape-dev', not 'punchcraft-emu' — it is left alone/,
    )
    expect(deviceRefusal({ ...base, isEmulator: true, avdName: null })).toMatch(/'unknown'/)
    expect(deviceRefusal({ ...base, isEmulator: false, avdName: 'punchcraft-emu' })).toMatch(
      /is not an emulator/,
    )
  })
})

describe('the build', () => {
  it('is rebuilt when there is no APK, or it is another commit’s, or nobody knows whose', () => {
    expect(
      needsBuild({ apkExists: false, builtFrom: { sha: 'abc1234', arch: ARCH }, head: 'abc1234' }),
    ).toBe(true)
    expect(
      needsBuild({ apkExists: true, builtFrom: { sha: 'abc1234', arch: ARCH }, head: 'def5678' }),
    ).toBe(true)
    expect(needsBuild({ apkExists: true, builtFrom: null, head: 'abc1234' })).toBe(true)
    expect(
      needsBuild({ apkExists: true, builtFrom: { sha: 'abc1234', arch: ARCH }, head: 'unknown' }),
    ).toBe(true)
  })

  it('is rebuilt when the APK on disk is for another processor', () => {
    expect(
      needsBuild({
        apkExists: true,
        builtFrom: { sha: 'abc1234', arch: 'arm64-v8a' },
        head: 'abc1234',
      }),
    ).toBe(true)
  })

  it('is left alone when it is already this commit', () => {
    expect(
      needsBuild({ apkExists: true, builtFrom: { sha: 'abc1234', arch: ARCH }, head: 'abc1234' }),
    ).toBe(false)
  })

  it('asks Gradle for the emulator’s processor on either platform', () => {
    expect(gradleInvocation('win32')).toEqual({
      command: 'gradlew.bat',
      args: ['assembleRelease', '-PreactNativeArchitectures=x86_64', '--console=plain'],
    })
    expect(gradleInvocation('linux').command).toBe('gradlew')
  })

  it('reads a checksum from sha256sum’s output', () => {
    const sum = 'a'.repeat(64)
    expect(shaFromSum(`${sum}  /data/app/x/base.apk\n`)).toBe(sum)
    expect(shaFromSum('sha256sum: /data/app/x/base.apk: No such file')).toBeNull()
  })
})

describe('the verify suite it runs', () => {
  it('is always this emulator, a release build, and this commit', () => {
    expect(suiteArguments(['--only=quick-one-two'], 'emulator-5556')).toEqual([
      '--device=emulator-5556',
      '--expect-release',
      '--require-sha',
      '--only=quick-one-two',
    ])
  })

  it('runs every workout when none was picked', () => {
    expect(suiteArguments(['--vocab=both'], 'emulator-5556')).toEqual([
      '--device=emulator-5556',
      '--expect-release',
      '--require-sha',
      '--all',
      '--vocab=both',
    ])
    expect(suiteArguments(['--all'], 'emulator-5556')).toEqual([
      '--device=emulator-5556',
      '--expect-release',
      '--require-sha',
      '--all',
    ])
  })
})

describe('switching QA mode on', () => {
  it('writes the row the app’s own settings repository writes, and reads it back', () => {
    const sql = qaModeSql('2026-11-28T00:00:00.000Z')
    expect(sql).toContain("VALUES ('qa.mode', '{\"enabled\":true}', '2026-11-28T00:00:00.000Z')")
    expect(sql).toContain('ON CONFLICT(key) DO UPDATE')
    // Folded back into the database file, so root leaves no -wal behind.
    expect(sql).toContain('PRAGMA wal_checkpoint(TRUNCATE);')
    expect(sql).toContain("SELECT 'qa=' || value_json FROM app_settings WHERE key = 'qa.mode';")
  })

  it('believes only the literal value the app reads as on', () => {
    expect(qaModeIsOn(`0|0|0\nqa=${QA_VALUE}\n`)).toBe(true)
    expect(qaModeIsOn('qa={"enabled":"true"}')).toBe(false)
    expect(qaModeIsOn('qa={"enabled":false}')).toBe(false)
    expect(qaModeIsOn('Error: no such table: app_settings')).toBe(false)
    expect(qaModeIsOn('')).toBe(false)
  })

  it('finds what root owns in the app’s database folder', () => {
    const listing = [
      'total 896',
      '-rw------- 1 10209 10209 4096 2026-11-27 16:01 punchcraft.db',
      '-rw------- 1 0 0 32768 2026-11-27 16:13 punchcraft.db-shm',
      '-rw------- 1 0 0 0 2026-11-27 16:13 punchcraft.db-wal',
    ].join('\n')
    expect(rootOwned(listing)).toEqual(['punchcraft.db-shm', 'punchcraft.db-wal'])
    expect(
      rootOwned('total 8\n-rw------- 1 10209 10209 4096 2026-11-27 16:01 punchcraft.db'),
    ).toEqual([])
    expect(rootOwned('')).toEqual([])
  })
})

describe('the Bluetooth permissions', () => {
  const dump = [
    '    runtime permissions:',
    '      android.permission.BLUETOOTH_CONNECT: granted=true, flags=[ USER_SET|USER_SENSITIVE_WHEN_GRANTED]',
    '      android.permission.BLUETOOTH_SCAN: granted=false, flags=[ USER_FIXED|USER_SET]',
  ].join('\n')

  it('are read from dumpsys, one by one', () => {
    expect(grantedIn(dump, 'android.permission.BLUETOOTH_CONNECT')).toBe(true)
    expect(grantedIn(dump, 'android.permission.BLUETOOTH_SCAN')).toBe(false)
    expect(grantedIn(dump, 'android.permission.BLUETOOTH')).toBe(false)
    expect(grantedIn('', 'android.permission.BLUETOOTH_SCAN')).toBe(false)
  })
})

describe('copying android/ into a worktree', () => {
  it('takes the project and leaves its build output', () => {
    for (const source of [
      '',
      'app',
      'app/build.gradle',
      'app/src/main/AndroidManifest.xml',
      'gradle/wrapper/gradle-wrapper.jar',
      'gradlew.bat',
      'app/debug.keystore',
    ]) {
      expect(isAndroidSource(source)).toBe(true)
    }
    for (const output of [
      'build',
      'build/reports/x',
      '.gradle',
      '.gradle/8.14/x',
      '.kotlin',
      'app/build',
      'app/build/outputs/apk/release/app-release.apk',
      'app/.cxx',
      'app/.cxx/RelWithDebInfo/x',
    ]) {
      expect(isAndroidSource(output)).toBe(false)
    }
  })

  it('reads Windows paths the same way', () => {
    expect(isAndroidSource('app\\build\\outputs')).toBe(false)
    expect(isAndroidSource('app\\src\\main')).toBe(true)
  })
})
