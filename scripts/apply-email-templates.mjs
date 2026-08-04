/**
 * Uploads the branded auth email templates in supabase/templates/ to the
 * Supabase project.
 *
 *   node scripts/apply-email-templates.mjs
 *
 * Requires SUPABASE_MANAGEMENT_TOKEN. That is an operator credential: it is
 * never needed by the running application, so it must not be added to Vercel.
 *
 * Why these templates matter beyond looks: Supabase's stock templates link to
 * `{{ .ConfirmationURL }}`, which resolves through /auth/v1/verify and hands
 * the session back in a URL *fragment*. A server route cannot read a fragment,
 * so app/auth/callback/route.ts saw no `code` and rejected every link with
 * "The authentication link is invalid or has expired". These templates use the
 * `token_hash` form instead, which the callback verifies with verifyOtp.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, requireEnv, repoRoot } from './_env.mjs';

loadEnv();
const { NEXT_PUBLIC_SUPABASE_URL, SUPABASE_MANAGEMENT_TOKEN } = requireEnv([
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_MANAGEMENT_TOKEN',
]);

const projectRef = new URL(NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0];
const templateDir = join(repoRoot, 'supabase', 'templates');
const read = (name) => readFileSync(join(templateDir, name), 'utf8');

const payload = {
  mailer_subjects_confirmation: 'Confirm your StudyDock email address',
  mailer_templates_confirmation_content: read('confirmation.html'),
  mailer_subjects_recovery: 'Reset your StudyDock password',
  mailer_templates_recovery_content: read('recovery.html'),
};

console.log(`Project: ${projectRef}`);
for (const [key, value] of Object.entries(payload)) {
  console.log(`  ${key.padEnd(40)} ${value.length} chars`);
}

const endpoint = `https://api.supabase.com/v1/projects/${projectRef}/config/auth`;
const response = await fetch(endpoint, {
  method: 'PATCH',
  headers: {
    Authorization: `Bearer ${SUPABASE_MANAGEMENT_TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(payload),
});

if (!response.ok) {
  console.error(`\nFAILED: HTTP ${response.status}`);
  console.error((await response.text()).slice(0, 500));
  process.exit(1);
}

// Read back, so the run proves what landed rather than what was sent.
const stored = await (
  await fetch(endpoint, { headers: { Authorization: `Bearer ${SUPABASE_MANAGEMENT_TOKEN}` } })
).json();

console.log('\nApplied. Verifying stored values:');
let ok = true;
for (const [key, value] of Object.entries(payload)) {
  const matches = stored[key] === value;
  if (!matches) ok = false;
  console.log(`  ${matches ? 'ok      ' : 'MISMATCH'} ${key}`);
}

if (!ok) process.exit(1);
console.log('\nBoth templates stored exactly as written.');
