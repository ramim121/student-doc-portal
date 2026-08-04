/**
 * Applies every SQL migration in supabase/migrations/ to the target database,
 * in filename order, each inside a single transaction with ON_ERROR_STOP.
 *
 *   node scripts/apply-migrations.mjs
 *
 * Requires SUPABASE_DB_URL in .env (Supabase Dashboard > Project Settings >
 * Database > Connection string > URI) and `psql` on PATH.
 *
 * Every migration is idempotent, so re-running is safe and is the intended way
 * to heal a database that is only partially migrated.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, requireEnv, repoRoot } from './_env.mjs';

loadEnv();
const { SUPABASE_DB_URL } = requireEnv(['SUPABASE_DB_URL']);

const psqlProbe = spawnSync('psql', ['--version'], { encoding: 'utf8' });
if (psqlProbe.error) {
  console.error(
    'psql was not found on PATH.\n' +
      'Install the PostgreSQL client tools, or paste each file in\n' +
      'supabase/migrations/ into the Supabase SQL Editor in filename order.',
  );
  process.exit(1);
}
console.log(`Using ${psqlProbe.stdout.trim()}`);

const migrationsDir = join(repoRoot, 'supabase', 'migrations');
// Timestamp prefixes sort lexically, which is the required apply order.
const files = readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort();
if (!files.length) {
  console.error(`No .sql files found in ${migrationsDir}`);
  process.exit(1);
}

console.log(`Applying ${files.length} migrations\n`);

for (const file of files) {
  process.stdout.write(`  ${file} ... `);
  const result = spawnSync(
    'psql',
    [
      SUPABASE_DB_URL,
      '-v', 'ON_ERROR_STOP=1',
      '--single-transaction',
      '--quiet',
      '--no-psqlrc',
      '-f', join(migrationsDir, file),
    ],
    { encoding: 'utf8' },
  );

  if (result.status !== 0) {
    console.log('FAILED');
    if (result.stdout?.trim()) console.error(result.stdout.trim());
    if (result.stderr?.trim()) console.error(result.stderr.trim());
    console.error(`\nStopped at ${file}. Nothing from this file was committed.`);
    process.exit(1);
  }

  console.log('ok');
  // NOTICE lines are expected (DROP ... IF EXISTS against a fresh database).
  const noise = result.stderr
    ?.split('\n')
    .filter((line) => line.trim() && !/NOTICE/.test(line))
    .join('\n');
  if (noise?.trim()) console.log(`      ${noise.trim().replace(/\n/g, '\n      ')}`);
}

console.log('\nAll migrations applied. Next: node scripts/seed-dev-data.mjs');
