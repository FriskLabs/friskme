#!/usr/bin/env node
// Launcher for the `friskme` npm package. npm installs exactly one
// `friskme-<os>-<arch>` optional dependency that holds the compiled frisk
// binary; this script finds it and runs it with the same arguments.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const SUPPORTED = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']
const RELEASES = 'https://github.com/FriskLabs/frisk-cli/releases'

const platform = `${process.platform}-${process.arch}`

function fail(message) {
  process.stderr.write(`frisk: ${message}\n`)
  process.exit(1)
}

if (!SUPPORTED.includes(platform)) {
  fail(
    `no build for ${platform}. Supported: ${SUPPORTED.join(', ')}.\n` +
      `See ${RELEASES} for the binaries.`,
  )
}

let binary
try {
  binary = createRequire(import.meta.url).resolve(
    `friskme-${platform}/bin/frisk`,
  )
} catch {
  fail(
    `the friskme-${platform} package is missing.\n` +
      'It is an optional dependency, so it is skipped by --no-optional, ' +
      '--omit=optional, or on Linux without glibc (such as Alpine).\n' +
      `Reinstall friskme with optional dependencies, or download the binary from ${RELEASES}.`,
  )
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' })
if (result.error) fail(`could not run ${binary}: ${result.error.message}`)
if (result.signal) process.kill(process.pid, result.signal)
process.exit(result.status ?? 1)
