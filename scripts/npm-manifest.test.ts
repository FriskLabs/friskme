import { describe, expect, test } from 'bun:test'
import {
  launcherManifest,
  platformManifest,
  platformPackageName,
} from './npm-manifest.ts'
import { TARGETS } from './targets.ts'

const info = { version: '1.2.3', license: 'MIT', description: 'd' }

describe('npm manifests', () => {
  test('launcher depends on every platform package at the same version', () => {
    const m = launcherManifest(info, TARGETS)
    expect(m.name).toBe('friskme')
    expect(m.version).toBe('1.2.3')
    expect(m.optionalDependencies).toEqual(
      Object.fromEntries(TARGETS.map((t) => [`friskme-${t.id}`, '1.2.3'])),
    )
  })

  test('launcher exposes both frisk and friskme commands', () => {
    expect(launcherManifest(info, TARGETS).bin).toEqual({
      frisk: 'bin/frisk.js',
      friskme: 'bin/frisk.js',
    })
  })

  test('platform packages match process.platform and process.arch', () => {
    for (const t of TARGETS) {
      const m = platformManifest(info, t)
      expect(m.name).toBe(platformPackageName(t))
      expect(`${(m.os as string[])[0]}-${(m.cpu as string[])[0]}`).toBe(t.id)
      expect(m.libc).toEqual(t.os === 'linux' ? ['glibc'] : undefined)
    }
  })

  test('the launcher knows every target', async () => {
    const src = await Bun.file(
      new URL('../npm/launcher/frisk.js', import.meta.url),
    ).text()
    for (const t of TARGETS) expect(src).toContain(`'${t.id}'`)
  })
})
