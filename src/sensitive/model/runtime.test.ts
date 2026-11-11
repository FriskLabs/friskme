import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { missingFiles, modelPaths } from './download.ts'
import { RUNTIME_BINDINGS, RUNTIME_LIBS } from './manifest.ts'
import { selfCommand } from './ner.ts'

describe('runtime files', () => {
  /** A sparse file of the pinned size; missingFiles checks sizes only. */
  const place = (path: string, size: number) => {
    writeFileSync(path, '')
    truncateSync(path, size)
  }

  test('the runtime counts as missing until both library and binding are there', () => {
    const root = mkdtempSync(join(tmpdir(), 'frisk-rt-'))
    const paths = modelPaths(root, 'linux-x64')
    mkdirSync(paths.runtimeDir, { recursive: true })
    expect(missingFiles(paths, 'linux-x64').runtime).toBe(true)
    // An install from before the binding was downloaded: library only.
    place(paths.runtimeLib, RUNTIME_LIBS['linux-x64'].size)
    expect(missingFiles(paths, 'linux-x64').runtime).toBe(true)
    place(paths.runtimeBinding, RUNTIME_BINDINGS['linux-x64'].size - 1)
    expect(missingFiles(paths, 'linux-x64').runtime).toBe(true)
    place(paths.runtimeBinding, RUNTIME_BINDINGS['linux-x64'].size)
    expect(missingFiles(paths, 'linux-x64').runtime).toBe(false)
  })

  test('library and binding come from the same platform directory', () => {
    for (const p of Object.keys(
      RUNTIME_LIBS,
    ) as (keyof typeof RUNTIME_LIBS)[]) {
      const lib = RUNTIME_LIBS[p].tarPath
      const binding = RUNTIME_BINDINGS[p].tarPath
      expect(binding.slice(0, binding.lastIndexOf('/'))).toBe(
        lib.slice(0, lib.lastIndexOf('/')),
      )
    }
  })
})

describe('selfCommand', () => {
  const node = '/usr/bin/node'

  test('compiled binary: the binary is the CLI', () => {
    expect(
      selfCommand(['__ner-worker', 'm'], 'file:///$bunfs/root/frisk', node),
    ).toEqual([node, '__ner-worker', 'm'])
  })

  test('npm bundle: run the bundle file itself', () => {
    const url = pathToFileURL('/lib/node_modules/friskme/bin/frisk.js').href
    expect(selfCommand(['__ner-worker'], url, node)).toEqual([
      node,
      '/lib/node_modules/friskme/bin/frisk.js',
      '__ner-worker',
    ])
  })

  test('from source: run bin.ts, not the script that started the process', () => {
    const url = pathToFileURL('/repo/src/sensitive/model/ner.ts').href
    expect(selfCommand(['__ner-worker'], url, node)).toEqual([
      node,
      join('/repo/src/bin.ts'),
      '__ner-worker',
    ])
  })
})
