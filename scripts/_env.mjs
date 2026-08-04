import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Minimal dotenv reader. Values already present in process.env win, so a shell
 * export can override the file without editing it.
 */
export function loadEnv(fileName = '.env') {
  let raw = '';
  try {
    raw = readFileSync(join(repoRoot, fileName), 'utf8');
  } catch {
    return process.env;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return process.env;
}

/** Throws with an actionable message listing only the missing key names. */
export function requireEnv(keys) {
  const missing = keys.filter((key) => !process.env[key]?.trim());
  if (missing.length) {
    throw new Error(
      'Missing required environment values in Student-doc-portal/.env:\n' +
        missing.map((key) => `  - ${key}`).join('\n'),
    );
  }
  return Object.fromEntries(keys.map((key) => [key, process.env[key].trim()]));
}

/** Reports presence without ever printing a secret. */
export function reportEnv(keys) {
  for (const key of keys) {
    console.log(`  ${process.env[key]?.trim() ? 'set    ' : 'MISSING'}  ${key}`);
  }
}

export { repoRoot };
