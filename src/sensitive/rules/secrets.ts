/**
 * Secret detection rules. Patterns are derived from the gitleaks default rule
 * set (https://github.com/gitleaks/gitleaks, MIT License, Copyright (c) 2019
 * Zachary Rice), rewritten as JavaScript regexes and trimmed to providers a
 * developer's coding sessions are likely to touch.
 *
 * Every rule lists lowercase keywords; its regex only runs on text that
 * contains one of them (the gitleaks prefilter), which is what keeps a scan of
 * tens of millions of characters fast.
 */
import type { Confidence } from '../types.ts'
import { looksLikePlaceholder, shannonEntropy } from '../validators.ts'

export type SecretRule = {
  id: string
  /** Human-readable type, shown in the report. */
  type: string
  keywords: string[]
  regex: RegExp
  /** Capture group holding the secret; 0 = whole match. */
  group?: number
  /** Minimum Shannon entropy of the captured value. */
  entropy?: number
  confidence: Confidence
}

export const RULES_VERSION =
  'frisk-secrets-1 (derived from gitleaks v8 defaults)'

const B = String.raw`(?:^|[^A-Za-z0-9_])`
const E = String.raw`(?=$|[^A-Za-z0-9_])`

function rule(
  id: string,
  type: string,
  keywords: string[],
  source: string,
  opts: {
    group?: number
    entropy?: number
    confidence?: Confidence
    flags?: string
  } = {},
): SecretRule {
  return {
    id,
    type,
    keywords,
    regex: new RegExp(source, `g${opts.flags ?? ''}`),
    group: opts.group ?? 1,
    entropy: opts.entropy,
    confidence: opts.confidence ?? 'high',
  }
}

export const SECRET_RULES: SecretRule[] = [
  rule(
    'private-key',
    'private key',
    ['private key'],
    // A real key body is hundreds of base64 characters; `...` placeholders in .env.example are not.
    String.raw`(-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----(?:\\n|\s)*(?:[A-Za-z0-9+/=]|\\n|\s){200,}?(?:-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----|$))`,
  ),
  rule(
    'aws-access-key',
    'AWS access key',
    ['akia', 'asia', 'abia', 'acca', 'a3t'],
    `${B}((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})${E}`,
  ),
  rule(
    'aws-secret-key',
    'AWS secret key',
    ['aws'],
    String.raw`aws.{0,20}?(?:secret|key).{0,20}?['"=:\s]{1,4}([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])`,
    { flags: 'i', entropy: 3.5 },
  ),
  rule(
    'gcp-api-key',
    'Google API key',
    ['aiza'],
    `${B}(AIza[A-Za-z0-9_-]{35})${E}`,
  ),
  rule(
    'gcp-service-account',
    'Google service account key',
    ['private_key_id'],
    String.raw`"private_key_id"\s*:\s*"([a-f0-9]{40})"`,
  ),
  rule(
    'azure-storage-key',
    'Azure storage account key',
    ['accountkey'],
    String.raw`AccountKey=([A-Za-z0-9+/]{86}==)`,
    { flags: 'i' },
  ),
  rule(
    'azure-ad-client-secret',
    'Azure AD client secret',
    ['q~'],
    `${B}([A-Za-z0-9_~.]{3}\\dQ~[A-Za-z0-9_~.-]{31,34})${E}`,
  ),
  rule('github-pat', 'GitHub token', ['ghp_'], `${B}(ghp_[A-Za-z0-9]{36})${E}`),
  rule(
    'github-oauth',
    'GitHub token',
    ['gho_'],
    `${B}(gho_[A-Za-z0-9]{36})${E}`,
  ),
  rule(
    'github-app-token',
    'GitHub token',
    ['ghu_', 'ghs_'],
    `${B}((?:ghu|ghs)_[A-Za-z0-9]{36})${E}`,
  ),
  rule(
    'github-refresh-token',
    'GitHub token',
    ['ghr_'],
    `${B}(ghr_[A-Za-z0-9]{36,76})${E}`,
  ),
  rule(
    'github-fine-grained-pat',
    'GitHub token',
    ['github_pat_'],
    `${B}(github_pat_[A-Za-z0-9_]{82})${E}`,
  ),
  rule(
    'gitlab-pat',
    'GitLab token',
    ['glpat-'],
    `${B}(glpat-[A-Za-z0-9_-]{20,})${E}`,
  ),
  rule(
    'slack-bot-token',
    'Slack token',
    ['xoxb-'],
    `${B}(xoxb-[0-9]{10,13}-[0-9]{10,13}-?[A-Za-z0-9]{20,32})${E}`,
  ),
  rule(
    'slack-user-token',
    'Slack token',
    ['xoxp-', 'xoxe-', 'xoxa-'],
    `${B}(xox[pea](?:-[0-9]{10,13}){3}-[A-Za-z0-9]{28,34})${E}`,
  ),
  rule(
    'slack-app-token',
    'Slack token',
    ['xapp-'],
    `${B}(xapp-\\d-[A-Z0-9]{9,12}-\\d{12,14}-[a-f0-9]{60,70})${E}`,
  ),
  rule(
    'slack-webhook',
    'Slack webhook URL',
    ['hooks.slack.com'],
    String.raw`(https?://hooks\.slack\.com/(?:services|workflows|triggers)/[A-Za-z0-9+/_-]{20,})`,
  ),
  rule(
    'stripe-key',
    'Stripe secret key',
    ['sk_live', 'rk_live', 'sk_prod', 'rk_prod'],
    `${B}((?:sk|rk)_(?:live|prod)_[A-Za-z0-9]{10,99})${E}`,
  ),
  rule(
    'stripe-test-key',
    'Stripe test key',
    ['sk_test', 'rk_test'],
    `${B}((?:sk|rk)_test_[A-Za-z0-9]{10,99})${E}`,
    { confidence: 'medium' },
  ),
  rule(
    'twilio-api-key',
    'Twilio API key',
    ['twilio'],
    String.raw`twilio[\s\S]{0,80}?\b(SK[0-9a-fA-F]{32})\b`,
    { flags: 'i' },
  ),
  rule(
    'sendgrid-key',
    'SendGrid API key',
    ['sg.'],
    `${B}(SG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43})${E}`,
  ),
  rule(
    'anthropic-key',
    'Anthropic API key',
    ['sk-ant-'],
    `${B}(sk-ant-(?:api03|admin01)-[A-Za-z0-9_-]{80,100})${E}`,
  ),
  rule(
    'openai-key',
    'OpenAI API key',
    ['t3blbkfj'],
    `${B}(sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,})${E}`,
  ),
  rule(
    'openai-project-key',
    'OpenAI API key',
    ['sk-proj-', 'sk-svcacct-'],
    `${B}(sk-(?:proj|svcacct)-[A-Za-z0-9_-]{40,200})${E}`,
  ),
  rule(
    'huggingface-token',
    'Hugging Face token',
    ['hf_'],
    `${B}(hf_[A-Za-z]{34})${E}`,
  ),
  rule('npm-token', 'npm token', ['npm_'], `${B}(npm_[A-Za-z0-9]{36})${E}`),
  rule(
    'pypi-token',
    'PyPI token',
    ['pypi-ageich'],
    `${B}(pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,})${E}`,
  ),
  rule(
    'docker-pat',
    'Docker Hub token',
    ['dckr_pat_'],
    `${B}(dckr_pat_[A-Za-z0-9_-]{27,})${E}`,
  ),
  rule(
    'datadog-key',
    'Datadog key',
    ['datadog', 'dd_api', 'dd_app'],
    String.raw`(?:datadog|dd)[_ -]?(?:api|app(?:lication)?)[_ -]?key[\s\S]{0,8}?['"=:\s]{1,4}([a-f0-9]{32,40})\b`,
    { flags: 'i' },
  ),
  rule(
    'sentry-token',
    'Sentry token',
    ['sntrys_', 'sntryu_'],
    `${B}(sntry[su]_[A-Za-z0-9+/=_]{40,})`,
  ),
  rule(
    'linear-key',
    'Linear API key',
    ['lin_api_'],
    `${B}(lin_api_[A-Za-z0-9]{40})${E}`,
  ),
  rule(
    'shopify-token',
    'Shopify token',
    ['shpat_', 'shpca_', 'shppa_', 'shpss_'],
    `${B}(shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32})${E}`,
  ),
  rule(
    'digitalocean-token',
    'DigitalOcean token',
    ['dop_v1_', 'doo_v1_'],
    `${B}(do[op]_v1_[a-f0-9]{64})${E}`,
  ),
  rule(
    'supabase-token',
    'Supabase token',
    ['sbp_'],
    `${B}(sbp_[a-f0-9]{40})${E}`,
  ),
  rule(
    'vault-token',
    'HashiCorp Vault token',
    ['hvs.', 'hvb.'],
    `${B}(hv[sb]\\.[A-Za-z0-9_-]{90,})`,
  ),
  rule(
    'doppler-token',
    'Doppler token',
    ['dp.pt.', 'dp.st.'],
    `${B}(dp\\.(?:pt|st|sa|ct)\\.[A-Za-z0-9]{40,44})${E}`,
  ),
  rule(
    'planetscale-token',
    'PlanetScale token',
    ['pscale_'],
    `${B}(pscale_(?:tkn|pw|oauth)_[A-Za-z0-9=._-]{32,64})${E}`,
  ),
  rule(
    'grafana-token',
    'Grafana token',
    ['glsa_', 'glc_'],
    `${B}(gl(?:sa|c)_[A-Za-z0-9+/_=]{32,})`,
  ),
  rule(
    'newrelic-key',
    'New Relic key',
    ['nrak-'],
    `${B}(NRAK-[A-Z0-9]{27})${E}`,
  ),
  rule(
    'postman-key',
    'Postman API key',
    ['pmak-'],
    `${B}(PMAK-[a-f0-9]{24}-[a-f0-9]{34})${E}`,
  ),
  rule(
    'atlassian-token',
    'Atlassian API token',
    ['atatt3'],
    `${B}(ATATT3[A-Za-z0-9_=-]{100,})`,
  ),
  rule(
    'notion-token',
    'Notion token',
    ['ntn_', 'secret_'],
    `${B}(ntn_[0-9]{11}[A-Za-z0-9]{35}|secret_[A-Za-z0-9]{43})${E}`,
  ),
  rule(
    'figma-token',
    'Figma token',
    ['figd_'],
    `${B}(figd_[A-Za-z0-9_-]{40,})${E}`,
  ),
  rule(
    'age-secret-key',
    'age secret key',
    ['age-secret-key-1'],
    String.raw`(AGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58})`,
  ),
  rule(
    'jwt',
    'JSON web token',
    ['eyj'],
    `${B}(eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,})${E}`,
    { confidence: 'medium' },
  ),
  rule(
    'url-credentials',
    'credentials in a URL',
    ['://'],
    // Local hosts (localhost, docker service names) carry dev passwords, not secrets.
    String.raw`\b[a-z][a-z0-9+.-]{1,20}://[^\s/:@'"]{1,64}:([^\s/@'"]{3,128})@(?!(?:localhost|127\.|0\.0\.0\.0|host\.docker\.internal|db|postgres|mysql|redis|mongo|rabbitmq|minio)(?:[:/\s'"]|$))[A-Za-z0-9.-]+`,
    { flags: 'i' },
  ),
  rule(
    'generic-secret',
    'secret in an assignment',
    ['key', 'token', 'secret', 'password', 'passwd', 'pwd', 'credential'],
    String.raw`[A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_.-]*['"]?\s{0,3}(?::=|=>|=|:)\s{0,3}['"]?([A-Za-z0-9_\-+/=.~!@#$%^&*]{12,128})['"]?(?=$|[\s,;'"}\])])`,
    { flags: 'i', entropy: 3.5, confidence: 'low' },
  ),
]

/** Whether a captured value should be dropped as a false positive. */
const DEV_PASSWORDS = new Set([
  'postgres',
  'password',
  'secret',
  'admin',
  'root',
  'test',
  'dev',
  'pass',
  'changeme',
  'guest',
  'user',
])

export function rejectSecretValue(rule: SecretRule, value: string): boolean {
  if (rule.entropy !== undefined && shannonEntropy(value) < rule.entropy)
    return true
  // Doc examples (AKIA…EXAMPLE), `sk_live_abcdef…`, `xxxx`: placeholders for every rule.
  if (looksLikePlaceholder(value)) return true
  if (rule.id === 'url-credentials' && DEV_PASSWORDS.has(value.toLowerCase()))
    return true
  if (rule.id === 'generic-secret') {
    // A variable reference, property access or identifier, not a value.
    if (
      /^(process\.env|os\.environ|env\.|self\.|this\.|config\.|args\.|opts\.|options\.)/.test(
        value,
      )
    )
      return true
    if (/^[A-Za-z_$][\w$]*(\.[\w$]+)+$/.test(value)) return true
    // Generated secrets mix letters and digits; words and identifiers don't.
    if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) return true
  }
  return false
}
