import { describe, expect, test } from 'bun:test'
import { packageManifest } from './npm-manifest.ts'

const info = { version: '1.2.3', license: 'MIT', description: 'd' }

describe('npm manifest', () => {
  test('one package, versioned, with both commands', () => {
    const m = packageManifest(info)
    expect(m.name).toBe('friskme')
    expect(m.version).toBe('1.2.3')
    expect(m.bin).toEqual({ frisk: 'bin/frisk.js', friskme: 'bin/frisk.js' })
  })

  test('installs nothing else: the bundle carries every dependency', () => {
    const m = packageManifest(info)
    expect(m.dependencies).toBeUndefined()
    expect(m.optionalDependencies).toBeUndefined()
    expect(m.os).toBeUndefined()
    expect(m.cpu).toBeUndefined()
  })

  test('requires a Node with zstd in node:zlib', () => {
    expect(packageManifest(info).engines).toEqual({ node: '>=22.15' })
  })
})
