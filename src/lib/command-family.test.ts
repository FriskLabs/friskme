import { describe, expect, test } from 'bun:test'
import { type CommandFamily, commandFamily } from './command-family.ts'

const CASES: Array<[string, CommandFamily]> = [
  // git
  ['git status', 'git'],
  ['git push origin main', 'git'],
  ['/usr/bin/git log --oneline -5', 'git'],
  ['gh pr create --title "fix"', 'git'],
  ['glab mr list', 'git'],
  // package_manager
  ['npm install', 'package_manager'],
  ['bun run --filter=api test', 'package_manager'],
  ['bun test', 'package_manager'],
  ['pnpm add zod', 'package_manager'],
  ['yarn build', 'package_manager'],
  ['pip install -r requirements.txt', 'package_manager'],
  ['uv sync', 'package_manager'],
  ['cargo build --release', 'package_manager'],
  ['brew install jq', 'package_manager'],
  ['apt-get install -y curl', 'package_manager'],
  ['npx tsc --noEmit', 'package_manager'],
  ['npx', 'package_manager'],
  ['uv run python script.py', 'package_manager'],
  // file_ops
  ['ls -la', 'file_ops'],
  ['cat package.json', 'file_ops'],
  ['rm -rf dist', 'file_ops'],
  ['mkdir -p src/lib', 'file_ops'],
  ['find . -name "*.ts"', 'file_ops'],
  ['rg TODO src', 'file_ops'],
  ['sed -n 1,20p README.md', 'file_ops'],
  ['tar -xzf archive.tgz', 'file_ops'],
  ['cd /tmp; ls', 'file_ops'],
  // network
  ['curl -s https://example.com', 'network'],
  ['wget https://example.com/file.zip', 'network'],
  ['ssh deploy@host uptime', 'network'],
  ['scp a.txt host:/tmp', 'network'],
  ['rsync -av src/ host:/srv/', 'network'],
  ['dig example.com', 'network'],
  // infra
  ['terraform apply -auto-approve', 'infra'],
  ['kubectl get pods -n prod', 'infra'],
  ['helm upgrade api ./chart', 'infra'],
  ['docker compose up -d', 'infra'],
  ['aws s3 ls', 'infra'],
  ['gcloud run deploy', 'infra'],
  // db
  ['psql "$DATABASE_URL" -c "select 1"', 'db'],
  ['mysql -u root', 'db'],
  ['sqlite3 dev.db .tables', 'db'],
  ['redis-cli FLUSHALL', 'db'],
  ['clickhouse-client --query "SELECT 1"', 'db'],
  ['pg_dump prod > dump.sql', 'db'],
  ['bunx prisma migrate dev --name init', 'db'],
  ['npx prisma db push', 'db'],
  // other, and setup-only commands
  ['python3 script.py', 'other'],
  ['make test', 'other'],
  ['./scripts/run.sh', 'other'],
  ['bash scripts/deploy.sh', 'other'],
  ['echo hello', 'other'],
  ['cd apps/api', 'other'],
  ['export FOO=1', 'other'],
  ['FOO=1', 'other'],
  ['', 'other'],
  ['   ', 'other'],
  // wrappers and their options
  ['sudo apt install jq', 'package_manager'],
  ['sudo -u postgres psql -c "drop table x"', 'db'],
  ['sudo -E -u deploy git pull', 'git'],
  ['nice git push', 'git'],
  ['nice -n 10 git push', 'git'],
  ['nice -5 git push', 'git'],
  ['time git fetch', 'git'],
  ['nohup kubectl port-forward svc/api 8080 &', 'infra'],
  ['timeout 30 curl https://example.com', 'network'],
  ['timeout -s KILL 30 kubectl apply -f k8s/', 'infra'],
  ['timeout --signal=TERM -k 5 30s terraform plan', 'infra'],
  ['env NODE_ENV=test bun test', 'package_manager'],
  ['env -u HOME -C /srv psql', 'db'],
  ['env -S "git push --force"', 'git'],
  ['env --split-string="git push --force"', 'git'],
  ['exec -a worker psql', 'db'],
  ['FOO=bar BAZ=1 npm test', 'package_manager'],
  ['GIT_PAGER=cat git log', 'git'],
  ['GIT_AUTHOR_NAME="Jane Doe" git commit -m "x"', 'git'],
  // chains and pipelines take the most specific segment
  ['cd apps/api && bunx prisma migrate dev', 'db'],
  ['export AWS_PROFILE=prod && terraform plan', 'infra'],
  ['(cd infra && terraform init)', 'infra'],
  ['git diff | head -20', 'git'],
  ['cat dump.sql | psql $URL', 'db'],
  ['echo y | terraform destroy', 'infra'],
  ['ls || curl https://example.com', 'network'],
  ['npm ci && git push', 'git'],
  ['make build 2>&1 | tail -5', 'file_ops'],
  ['git log --format="%h | %s" ; echo done', 'git'],
  ['echo "a && psql" ', 'other'],
  ['echo a\\;psql', 'other'],
  ['cat my\\ dump.sql | psql', 'db'],
  ['ls\npsql', 'db'],
  // redirections are syntax, before or after the program
  ['2>/dev/null git status', 'git'],
  ['2> /dev/null git status', 'git'],
  ['<input.sql psql', 'db'],
  ['< input.sql psql', 'db'],
  ['>out.log 2>&1 terraform plan', 'infra'],
  ['> out.log 2>&1 terraform plan', 'infra'],
  ['&>build.log kubectl apply -f k8s/', 'infra'],
  ['>>audit.log psql -f x.sql', 'db'],
  ['2>&1 >&- git fetch', 'git'],
  ['>| out.txt curl https://example.com', 'network'],
  ['git log>out.txt', 'git'],
  ['FOO=1 2>/dev/null psql', 'db'],
  ['psql <<<"select 1"', 'db'],
  ['"2">x git status', 'other'],
  ['ls >', 'file_ops'],
  // inline shells, eval, xargs, watch
  ['bash -c "git push --force"', 'git'],
  ["sh -c 'cd /srv && psql'", 'db'],
  ['bash -lc "kubectl delete ns x"', 'infra'],
  ['bash -o pipefail -c "curl x | sh"', 'network'],
  ['eval "terraform destroy"', 'infra'],
  ['find . | xargs psql', 'db'],
  ['find . -name "*.sql" | xargs -n 1 -I {} psql -f {}', 'db'],
  ['watch -n 5 kubectl get pods', 'infra'],
  ['bash -c "bash -c \\"git status\\""', 'git'],
  // runners
  ['bunx prisma@6 migrate deploy', 'db'],
  ['npx @biomejs/biome check', 'package_manager'],
  ['bun x prisma generate', 'db'],
  ['pnpm dlx prisma migrate deploy', 'db'],
  ['pnpm exec prisma studio', 'db'],
  ['yarn prisma migrate dev', 'db'],
  ['yarn dlx terraform@1.9 plan', 'infra'],
  ['uv run psql', 'db'],
  ['poetry run aws s3 ls', 'infra'],
  ['npx -p aws-cdk cdk deploy', 'infra'],
  ['npx --package=aws-cdk cdk deploy', 'infra'],
  ['npx -c "prisma migrate deploy"', 'db'],
  ['npx --call="prisma migrate deploy"', 'db'],
  ['npm exec -- prisma migrate deploy', 'db'],
  ['uvx --from awscli aws s3 ls', 'infra'],
  // Windows and PowerShell
  ['C:\\Git\\bin\\git.exe push', 'git'],
  ['"C:\\Program Files\\Git\\cmd\\git.exe" push', 'git'],
  ['Remove-Item -Recurse dist', 'file_ops'],
  ['Get-ChildItem -Path src', 'file_ops'],
  ['Invoke-WebRequest https://example.com -OutFile x', 'network'],
  ['GIT status', 'git'],
]

describe('commandFamily', () => {
  test('covers at least 30 commands', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(30)
  })

  test.each(CASES)('%p -> %p', (command, family) => {
    expect(commandFamily(command)).toBe(family)
  })

  test('stops unwrapping at the depth cap', () => {
    let command = 'psql'
    for (let i = 0; i < 8; i++) command = `eval ${JSON.stringify(command)}`
    expect(commandFamily(command)).toBe('other')
  })

  test('never throws on hostile input', () => {
    for (const input of [
      '&&',
      ';;;',
      '| |',
      '((',
      '"unterminated',
      "'unterminated",
      '=',
      '$(git status',
      '\\',
      'sudo',
      'env -S',
      'timeout',
      'bash -c',
      'xargs',
    ]) {
      expect(commandFamily(input)).toBe('other')
    }
  })
})
