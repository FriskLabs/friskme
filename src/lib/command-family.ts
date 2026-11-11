/**
 * Copied from FriskAI's control-plane monorepo (packages/coding-action-types/src/command-family.ts and coding-action.ts) on 2026-11-11 so frisk
 * builds without workspace packages. It no longer tracks the original: a
 * change there is not picked up here, and vice versa.
 */
export const COMMAND_FAMILIES = [
  'git',
  'package_manager',
  'file_ops',
  'network',
  'infra',
  'db',
  'other',
] as const

export type CommandFamily = (typeof COMMAND_FAMILIES)[number]

/**
 * Program name -> family. Looked up on the program's basename (`/` or `\`),
 * without a `.exe` suffix and case-insensitively, so `/usr/bin/git` and
 * `C:\Git\bin\git.exe` are both `git`. Keys are lowercase.
 */
const PROGRAM_FAMILIES: ReadonlyArray<
  readonly [CommandFamily, readonly string[]]
> = [
  ['git', ['git', 'gh', 'glab', 'hub', 'git-lfs']],
  [
    'package_manager',
    [
      'npm',
      'npx',
      'pnpm',
      'pnpx',
      'yarn',
      'bun',
      'bunx',
      'deno',
      'pip',
      'pip3',
      'pipx',
      'poetry',
      'uv',
      'uvx',
      'conda',
      'cargo',
      'gem',
      'bundle',
      'composer',
      'brew',
      'apt',
      'apt-get',
      'dnf',
      'yum',
      'apk',
    ],
  ],
  [
    'file_ops',
    [
      'ls',
      'cat',
      'head',
      'tail',
      'less',
      'more',
      'cp',
      'mv',
      'rm',
      'mkdir',
      'rmdir',
      'touch',
      'chmod',
      'chown',
      'ln',
      'find',
      'fd',
      'grep',
      'rg',
      'sed',
      'awk',
      'tar',
      'zip',
      'unzip',
      'gzip',
      'gunzip',
      'du',
      'df',
      'stat',
      'wc',
      'tree',
      'file',
      'realpath',
      // PowerShell
      'remove-item',
      'copy-item',
      'move-item',
      'rename-item',
      'new-item',
      'get-item',
      'get-childitem',
      'get-content',
      'set-content',
      'add-content',
    ],
  ],
  [
    'network',
    [
      'curl',
      'wget',
      'http',
      'ssh',
      'scp',
      'sftp',
      'rsync',
      'nc',
      'netcat',
      'telnet',
      'ftp',
      'ping',
      'dig',
      'nslookup',
      'host',
      'traceroute',
      // PowerShell
      'invoke-webrequest',
      'invoke-restmethod',
      'iwr',
      'irm',
    ],
  ],
  [
    'infra',
    [
      'terraform',
      'tofu',
      'pulumi',
      'kubectl',
      'helm',
      'kustomize',
      'eksctl',
      'minikube',
      'kind',
      'docker',
      'docker-compose',
      'podman',
      'aws',
      'gcloud',
      'az',
      'ansible',
      'ansible-playbook',
      'packer',
      'vagrant',
      'cdk',
      'sam',
      'serverless',
    ],
  ],
  [
    'db',
    [
      'psql',
      'pg_dump',
      'pg_restore',
      'createdb',
      'dropdb',
      'mysql',
      'mysqldump',
      'mariadb',
      'sqlite3',
      'mongosh',
      'mongo',
      'redis-cli',
      'clickhouse',
      'clickhouse-client',
      'cqlsh',
      'prisma',
    ],
  ],
]

const FAMILY_BY_PROGRAM: ReadonlyMap<string, CommandFamily> = new Map(
  PROGRAM_FAMILIES.flatMap(([family, programs]) =>
    programs.map((program) => [program, family] as const),
  ),
)

/**
 * When a command has several segments (`|`, `&&`, `||`, `;`), it takes the
 * most specific family among them, in this order. `cat dump.sql | psql` is a
 * db command and `echo y | terraform destroy` an infra one: the segment that
 * reaches a system outranks the one that feeds it.
 */
const FAMILY_PRECEDENCE: readonly CommandFamily[] = [
  'db',
  'infra',
  'git',
  'network',
  'package_manager',
  'file_ops',
  'other',
]

// Segments that only set up the shell or print. They classify nothing on their
// own; a command made only of them is `other`.
const SETUP_PROGRAMS = new Set([
  'cd',
  'pushd',
  'popd',
  'echo',
  'printf',
  'true',
  'false',
  'export',
  'set',
  'unset',
  'source',
  '.',
  ':',
])

type OptionSpec = {
  // Flags whose value is the next word (`-u postgres`).
  valueFlags?: ReadonlySet<string>
  // Value flags whose value is itself a command (`env -S`, `npx -c`).
  commandFlags?: ReadonlySet<string>
  // Positional words between the options and the command (`timeout 30`).
  positionals?: number
  // `NAME=VALUE` words are part of the options (`env`).
  assignments?: boolean
}

const flags = (...values: string[]): ReadonlySet<string> => new Set(values)

// Prefixes that run the rest of the words as the real command.
const WRAPPERS: ReadonlyMap<string, OptionSpec> = new Map([
  [
    'sudo',
    {
      valueFlags: flags(
        '-u',
        '-g',
        '-h',
        '-p',
        '-C',
        '-D',
        '-r',
        '-t',
        '-U',
        '--user',
        '--group',
        '--host',
        '--prompt',
        '--close-from',
        '--chdir',
        '--role',
        '--type',
        '--other-user',
      ),
    },
  ],
  [
    'env',
    {
      valueFlags: flags('-u', '--unset', '-C', '--chdir'),
      commandFlags: flags('-S', '--split-string'),
      assignments: true,
    },
  ],
  ['nice', { valueFlags: flags('-n', '--adjustment') }],
  [
    'timeout',
    {
      valueFlags: flags('-s', '--signal', '-k', '--kill-after'),
      positionals: 1,
    },
  ],
  ['nohup', {}],
  ['time', {}],
  ['command', {}],
  ['exec', { valueFlags: flags('-a') }],
])

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'])
const SHELL_OPTIONS: OptionSpec = { valueFlags: flags('-o', '-O', '+o', '+O') }
const XARGS_OPTIONS: OptionSpec = {
  valueFlags: flags('-I', '-n', '-P', '-L', '-s', '-d', '-E', '-a'),
}
const WATCH_OPTIONS: OptionSpec = { valueFlags: flags('-n', '--interval') }

type RunnerSpec = OptionSpec & {
  // The subcommand that runs a tool (`pnpm dlx`); `null` when the runner runs
  // its first argument directly (`npx`).
  subcommands: ReadonlySet<string> | null
  // The runner also runs a bare bin (`yarn prisma`).
  bareBin?: boolean
}

// Package runners: `bunx prisma ...` is a `prisma` command, so a runner takes
// the family of the tool it runs when that outranks `package_manager`.
const RUNNERS: ReadonlyMap<string, RunnerSpec> = new Map([
  [
    'npx',
    {
      subcommands: null,
      valueFlags: flags('-p', '--package'),
      commandFlags: flags('-c', '--call'),
    },
  ],
  ['bunx', { subcommands: null, valueFlags: flags('-p', '--package') }],
  ['pnpx', { subcommands: null }],
  [
    'uvx',
    {
      subcommands: null,
      valueFlags: flags('--from', '--with', '-p', '--python'),
    },
  ],
  [
    'bun',
    {
      subcommands: flags('x', 'run', 'exec'),
      valueFlags: flags('--filter', '-F', '--cwd'),
    },
  ],
  [
    'npm',
    {
      subcommands: flags('exec', 'x'),
      valueFlags: flags('-p', '--package', '-w', '--workspace'),
      commandFlags: flags('-c', '--call'),
    },
  ],
  [
    'pnpm',
    {
      subcommands: flags('dlx', 'exec'),
      valueFlags: flags('--filter', '-F', '-C', '--dir', '--package'),
    },
  ],
  [
    'yarn',
    {
      subcommands: flags('dlx', 'exec', 'run'),
      bareBin: true,
      valueFlags: flags('-p', '--package', '--cwd'),
    },
  ],
  [
    'uv',
    {
      subcommands: flags('run'),
      valueFlags: flags(
        '--with',
        '--python',
        '-p',
        '--project',
        '--directory',
        '--package',
      ),
    },
  ],
  [
    'poetry',
    {
      subcommands: flags('run'),
      valueFlags: flags('-C', '--directory', '-P', '--project'),
    },
  ],
  [
    'pipx',
    { subcommands: flags('run'), valueFlags: flags('--spec', '--python') },
  ],
])

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
// Nested `bash -c`, `eval`, `xargs`, `watch` and runners stop here.
const MAX_DEPTH = 4

/**
 * The family of a shell command, from a pure pattern table. Every segment of
 * a pipeline or chain is classified and the most specific family wins (see
 * `FAMILY_PRECEDENCE`). Wrappers (`sudo`, `env`, `timeout`, ...), inline shells
 * (`bash -c`, `eval`), `xargs`, `watch` and package runners are unwrapped.
 * Anything unrecognized, empty or malformed is `other`; this never throws.
 */
export function commandFamily(command: string): CommandFamily {
  return familyOfCommand(command, 0)
}

function familyOfCommand(command: string, depth: number): CommandFamily {
  if (depth > MAX_DEPTH) return 'other'
  return mostSpecific(
    lexSegments(command).map((words) => familyOfWords(words, depth)),
  )
}

/** `null` for a segment that only sets up the shell. */
function familyOfWords(
  segment: readonly string[],
  depth: number,
): CommandFamily | null {
  if (depth > MAX_DEPTH) return 'other'
  const words = stripWrappers(segment)
  const first = words[0]
  if (first === undefined) return null
  const program = programName(first)
  if (SETUP_PROGRAMS.has(program)) return null

  if (SHELLS.has(program)) return shellFamily(words, depth)
  if (program === 'eval') {
    return familyOfCommand(words.slice(1).join(' '), depth + 1)
  }
  if (program === 'xargs') {
    const { index } = skipOptions(words, 1, XARGS_OPTIONS)
    return familyOfWords(words.slice(index), depth + 1)
  }
  if (program === 'watch') {
    const { index } = skipOptions(words, 1, WATCH_OPTIONS)
    return familyOfCommand(words.slice(index).join(' '), depth + 1)
  }
  const runner = RUNNERS.get(program)
  if (runner) return runnerFamily(words, runner, depth)

  return FAMILY_BY_PROGRAM.get(program) ?? 'other'
}

/** `bash -c "<cmd>"` is `<cmd>`; `bash script.sh` runs code we cannot see. */
function shellFamily(words: readonly string[], depth: number): CommandFamily {
  let index = 1
  while (index < words.length) {
    const word = words[index] ?? ''
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(word)) {
      return familyOfCommand(words[index + 1] ?? '', depth + 1)
    }
    if (!/^[-+]/.test(word)) break
    index += SHELL_OPTIONS.valueFlags?.has(word) ? 2 : 1
  }
  return 'other'
}

function runnerFamily(
  words: readonly string[],
  spec: RunnerSpec,
  depth: number,
): CommandFamily {
  let index = 1
  if (spec.subcommands !== null) {
    index = skipOptions(words, index, spec).index
    const subcommand = words[index]
    if (subcommand !== undefined && spec.subcommands.has(subcommand)) {
      index += 1
    } else if (!spec.bareBin) {
      return 'package_manager'
    }
  }
  const options = skipOptions(words, index, spec)
  if (options.command !== null) {
    return mostSpecific([
      'package_manager',
      familyOfCommand(options.command, depth + 1),
    ])
  }
  const tool = words[options.index]
  if (tool === undefined) return 'package_manager'
  return mostSpecific([
    'package_manager',
    familyOfWords(
      [withoutVersion(tool), ...words.slice(options.index + 1)],
      depth + 1,
    ),
  ])
}

/** The words from the real program on, env assignments and wrappers removed. */
function stripWrappers(segment: readonly string[]): readonly string[] {
  let words = segment
  let index = 0
  while (index < words.length) {
    const word = words[index] ?? ''
    if (ENV_ASSIGNMENT.test(word)) {
      index += 1
      continue
    }
    const spec = WRAPPERS.get(programName(word))
    if (!spec) break
    const options = skipOptions(words, index + 1, spec)
    if (options.command !== null) {
      // `env -S "a b"` splits its value into the words it runs.
      words = [
        ...lexSegments(options.command).flat(),
        ...words.slice(options.index),
      ]
      index = 0
    } else {
      index = options.index
    }
  }
  return words.slice(index)
}

/**
 * Skips a program's options from `start`. Returns the index of the first word
 * after them (and any positionals), and the value of a command flag if one was
 * given.
 */
function skipOptions(
  words: readonly string[],
  start: number,
  spec: OptionSpec,
): { index: number; command: string | null } {
  let index = start
  let command: string | null = null
  while (index < words.length) {
    const word = words[index] ?? ''
    if (word === '--') {
      index += 1
      break
    }
    if (spec.assignments && ENV_ASSIGNMENT.test(word)) {
      index += 1
      continue
    }
    if (!word.startsWith('-') || word.length === 1) break
    const equals = word.indexOf('=')
    if (word.startsWith('--') && equals !== -1) {
      if (spec.commandFlags?.has(word.slice(0, equals))) {
        command = word.slice(equals + 1)
      }
      index += 1
    } else if (spec.commandFlags?.has(word)) {
      command = words[index + 1] ?? ''
      index += 2
    } else {
      index += spec.valueFlags?.has(word) ? 2 : 1
    }
  }
  return { index: index + (spec.positionals ?? 0), command }
}

function mostSpecific(
  families: ReadonlyArray<CommandFamily | null>,
): CommandFamily {
  for (const family of FAMILY_PRECEDENCE) {
    if (families.includes(family)) return family
  }
  return 'other'
}

/** `prisma@6` -> `prisma`; `@scope/pkg@1.2` -> `@scope/pkg`. */
function withoutVersion(word: string): string {
  return word.replace(/^(@?[^@]+)@[^/]*$/, '$1')
}

function programName(word: string): string {
  const slash = Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\'))
  return word
    .slice(slash + 1)
    .replace(/\.exe$/i, '')
    .toLowerCase()
}

/**
 * Splits a command into segments of words on `|`, `||`, `&&`, `;`, `&`,
 * newlines and subshell parentheses, outside quotes. Quotes are removed from
 * the words (`NAME="a b"` is the one word `NAME=a b`). A backslash escapes only
 * whitespace, quotes, a backslash or an operator, so a Windows path keeps its
 * separators. `$( ... )` stays inside its word. Unterminated quotes run to the
 * end of the input.
 *
 * Redirections are syntax, not words: the operator, its file descriptor and
 * its target are dropped wherever they sit, attached (`2>/dev/null`) or not
 * (`2> /dev/null`), so `<input.sql psql` still finds `psql` as the program.
 */
function lexSegments(input: string): string[][] {
  const segments: string[][] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  // The word has quoted or escaped parts, so it cannot be a bare fd number.
  let quotedWord = false
  let quote: '"' | "'" | null = null
  let substitutionDepth = 0
  // The next word is a redirection's target.
  let dropNextWord = false

  const endWord = () => {
    if (inWord) {
      if (dropNextWord) dropNextWord = false
      else words.push(word)
    }
    word = ''
    inWord = false
    quotedWord = false
  }
  const endSegment = () => {
    endWord()
    dropNextWord = false
    if (words.length > 0) segments.push(words)
    words = []
  }

  for (let index = 0; index < input.length; index++) {
    const char = input.charAt(index)
    const next = input.charAt(index + 1)
    if (quote === "'") {
      if (char === "'") quote = null
      else word += char
      continue
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null
      } else if (char === '\\' && next !== '' && '"\\$`'.includes(next)) {
        word += next
        index += 1
      } else {
        word += char
      }
      continue
    }
    if (substitutionDepth > 0) {
      word += char
      if (char === '(') substitutionDepth += 1
      else if (char === ')') substitutionDepth -= 1
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      inWord = true
      quotedWord = true
    } else if (char === '\\' && next !== '' && /[\s'"\\|&;()<>]/.test(next)) {
      word += next
      inWord = true
      quotedWord = true
      index += 1
    } else if (char === '$' && next === '(') {
      word += '$('
      inWord = true
      substitutionDepth = 1
      index += 1
    } else if (char === '\n') {
      endSegment()
    } else if (/\s/.test(char)) {
      endWord()
    } else if (char === '>' || char === '<' || (char === '&' && next === '>')) {
      // A leading fd number (`2>`) belongs to the operator; anything else
      // before it (`hi>out`) is a word of its own.
      if (quotedWord || !/^\d+$/.test(word)) endWord()
      word = ''
      inWord = false
      quotedWord = false
      let cursor = char === '&' ? index + 1 : index
      const direction = input.charAt(cursor)
      while (input.charAt(cursor) === direction) cursor += 1
      let hasTarget = false
      if (input.charAt(cursor) === '&') {
        // `2>&1`, `>&-`: the target is part of the operator.
        const duplicate = /^(\d+|-)/.exec(input.slice(cursor + 1))
        cursor += 1
        if (duplicate) {
          cursor += duplicate[0].length
          hasTarget = true
        }
      } else if (input.charAt(cursor) === '|') {
        cursor += 1
      }
      index = cursor - 1
      if (!hasTarget) dropNextWord = true
    } else if (char === '|' || char === ';' || char === '(' || char === ')') {
      endSegment()
      if (char === '|' && next === '|') index += 1
    } else if (char === '&') {
      endSegment()
      if (next === '&') index += 1
    } else {
      word += char
      inWord = true
    }
  }
  endSegment()
  return segments
}
