import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE COMPOSE FILE MUST ASK FOR EVERY KEY THE APP CANNOT RUN WITHOUT.
 *
 * `DEPLOY.md` lists three variables as required: the database URL, the
 * session secret and `APP_ENCRYPTION_KEY`. The compose file asked for two.
 * The third was simply absent, so `docker compose up` started an app that
 * could not save a courier password and — since the second factor became
 * mandatory on every role — could not let anyone sign in at all, with
 * nothing at start-up saying why.
 *
 * «Required» in compose means `${NAME:?message}`: the stack refuses to
 * start when it is unset. And never a value: the repository is public.
 * ═══════════════════════════════════════════════════════════════════════
 */

const compose = readFileSync(path.join(process.cwd(), 'docker-compose.yml'), 'utf8');

/** Names written as `NAME: ${NAME:?…}` — the form that refuses to start without them. */
function requiredVars(text: string): string[] {
  return [...text.matchAll(/^\s*([A-Z][A-Z0-9_]*):\s*\$\{\1:\?/gm)].map((m) => m[1]);
}

/** Names given a literal value on the line itself. */
function literalVars(text: string, names: string[]): string[] {
  return names.filter((n) => new RegExp(`^\\s*${n}:\\s*(?!\\$\\{)\\S`, 'm').test(text));
}

const KEYS = ['POSTGRES_PASSWORD', 'JWT_SECRET', 'APP_ENCRYPTION_KEY'];

describe('docker-compose.yml', () => {
  it('refuses to start without the database password, the session secret and the encryption key', () => {
    expect(requiredVars(compose)).toEqual(expect.arrayContaining(KEYS));
  });

  it('gives none of them a value of its own', () => {
    expect(literalVars(compose, KEYS)).toEqual([]);
  });

  it('turns trust in forwarded headers on only when the operator asks, never by default', () => {
    expect(compose).toMatch(/TRUST_PROXY:\s*\$\{TRUST_PROXY:-\}/);
    expect(compose).not.toMatch(/TRUST_PROXY:\s*['"]?true/);
  });
});

describe('and the check is not vacuous', () => {
  it('notices a key that was left out', () => {
    const without = compose
      .split('\n')
      .filter((l) => !l.includes('APP_ENCRYPTION_KEY:'))
      .join('\n');
    expect(requiredVars(without)).not.toContain('APP_ENCRYPTION_KEY');
  });

  it('notices a key that was given a value', () => {
    const typed = compose.replace(/APP_ENCRYPTION_KEY: \$\{[^\n]*\}/, 'APP_ENCRYPTION_KEY: abc123abc123');
    expect(literalVars(typed, KEYS)).toEqual(['APP_ENCRYPTION_KEY']);
    expect(requiredVars(typed)).not.toContain('APP_ENCRYPTION_KEY');
  });

  it('notices a key that is optional rather than required', () => {
    const optional = compose.replace(/\$\{APP_ENCRYPTION_KEY:\?[^}]*\}/, '${APP_ENCRYPTION_KEY:-}');
    expect(requiredVars(optional)).not.toContain('APP_ENCRYPTION_KEY');
  });
});
