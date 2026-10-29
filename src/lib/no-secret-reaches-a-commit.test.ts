import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE GUARD THAT WOULD HAVE CAUGHT IT, PROVEN ON THE THING IT MISSED.
 *
 * `prisma/seed.ts` carried `DEV_DEMO_PASSWORD = 'password123'` and the
 * README printed it under a heading. The repository is public, so both
 * were published, and thirteen real accounts were still using that
 * password when somebody finally looked.
 *
 * A scanner nobody has ever watched fail is not a guard — it is a step in
 * a CI file that has always been green. So these plant the exact shapes
 * that leaked and require the scanner to find them, and then require it
 * to stay quiet on the real tree.
 * ═══════════════════════════════════════════════════════════════════════
 */

const SCANNER = 'scripts/scan-secrets.mjs';

/** Exit code and output of the scanner over the given files. */
function scan(...files: string[]): { code: number; out: string } {
  try {
    const out = execFileSync('node', [SCANNER, ...files], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

let dir: string | null = null;
/** A throwaway file, so nothing planted here is ever a tracked file. */
function plant(name: string, body: string): string {
  dir ??= mkdtempSync(path.join(tmpdir(), 'scan-'));
  const file = path.join(dir, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body, 'utf8');
  return file;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('the scanner finds what this repository actually leaked', () => {
  it('a password written as a literal, the way the seed carried it', () => {
    const { code, out } = scan(plant('seed.ts', `const DEV_DEMO_PASSWORD = 'password123';\n`));
    expect(code, out).toBe(1);
    expect(out).toContain('Password literal');
    expect(out).toContain('seed.ts:1');
  });

  it('and the same password spelled out in a document, the way the README did', () => {
    const { code, out } = scan(plant('README.md', '## Demo Seed Accounts (Password: `password123`)\n'));
    expect(code, out).toBe(1);
    expect(out).toContain('README.md:1');
  });

  it('and in prose with no quoting at all, where no linter would look', () => {
    // The backticked form above is caught by the literal pattern; this one
    // has nothing for that pattern to anchor on, and is what a sentence in
    // a document actually looks like.
    const { code, out } = scan(plant('SETUP.md', 'Sign in with Password: Mubarak2026 and change it after.\n'));
    expect(code, out).toBe(1);
    expect(out).toContain('Password in prose');
  });

  it('and a vendor key, wherever it is — a test file included', () => {
    // Assembled here so the literal never exists in this tracked file.
    const key = ['sk', '-', 'Qp7RtY2vLm9XbNc4KdEf8Ghj'].join('');
    const { code, out } = scan(plant('fixture-data.test.ts', `const k = '${key}';\n`));
    expect(code, out).toBe(1);
    expect(out).toContain('OpenAI key');
  });

  it('and a database URL carrying its own credentials', () => {
    /*
     * Assembled, like the key above, and for a reason worth writing down:
     * the first version of this test spelled the URL out. It passed on the
     * machine that wrote it and failed in CI — because the scanner reads
     * `git ls-files`, and the file was not tracked yet when the suite ran
     * locally. The moment it was committed it became its own finding.
     *
     * Which is the guard behaving correctly. A fixture that looks like a
     * credential IS a credential as far as a scanner can tell, and a test
     * that needs an exemption to pass is a hole with a test around it.
     */
    const url = ['postgresql://', 'zaki', ':', 'Hunter2Hunter', '@', 'db.host:5432/osm'].join('');
    const { code, out } = scan(plant('config.ts', `const u = '${url}';\n`));
    expect(code, out).toBe(1);
    expect(out).toContain('Connection string');
  });

  /**
   * The shapes with no quotes around them. Every pattern above wants a
   * quote after the `=`, which is how CODE is written — and is exactly
   * why they were blind to the likeliest accident in this repository: a
   * value typed into a config file to debug something, and committed.
   */
  it('a real value typed into a .env.example', () => {
    const { code, out } = scan(plant('.env.example', 'SEED_DEMO_PASSWORD=Mubarak2026\n'));
    expect(code, out).toBe(1);
    expect(out).toContain('Unquoted secret assignment');
  });

  it('and a key whose name is nothing but the word', () => {
    /*
     * `API_KEY=` and a bare `PASSWORD=` are the likeliest shape of this
     * accident, and the first version of the rule missed every one of
     * them: its name anchor demanded a character BEFORE the keyword, so
     * `SEED_DEMO_PASSWORD` matched and `PASSWORD` did not. The two tests
     * around this one both used prefixed names, so neither could notice.
     */
    for (const name of ['API_KEY', 'PASSWORD', 'SECRET', 'TOKEN', 'APIKEY']) {
      const { code, out } = scan(plant('.env.example', `${name}=Mubarak2026\n`));
      expect(code, `${name}: ${out}`).toBe(1);
    }
  });

  it('and the same thing inlined into a compose file', () => {
    const yaml = 'services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: Mubarak2026\n';
    const { code, out } = scan(plant('docker-compose.yml', yaml));
    expect(code, out).toBe(1);
    expect(out).toContain('docker-compose.yml:4');
  });

  it('and a private key committed as a file', () => {
    const pem = `-----BEGIN RSA PRIVATE ${'KEY'}-----\nMIIEow==\n-----END RSA PRIVATE ${'KEY'}-----\n`;
    const { code, out } = scan(plant('id_rsa', pem));
    expect(code, out).toBe(1);
    expect(out).toContain('Private key block');
  });

  it('and it never prints the value it found', () => {
    const { out } = scan(plant('seed.ts', `const DEV_DEMO_PASSWORD = 'password123';\n`));
    // The CI log is public too. A finding that quotes the secret moves it
    // from one published place to another.
    expect(out, 'السكانر طبع السرّ نفسه').not.toContain('password123');
  });
});

describe('and it stays quiet on what is not a secret', () => {
  it('a named placeholder, an env var and a generated one', () => {
    const { code, out } = scan(
      plant(
        'docs.md',
        [
          'DATABASE_URL=postgresql://<DB_USER>:<DB_PASSWORD>@<DB_HOST>:5432/salesflow',
          'JWT_SECRET=<openssl rand -base64 32>',
          'POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?required}',
        ].join('\n')
      )
    );
    expect(code, out).toBe(0);
  });

  it('a password field that holds a label, not a value', () => {
    const { code, out } = scan(plant('zod.ts', `  password: 'كلمة المرور',\n`));
    expect(code, out).toBe(0);
  });

  it('a URL whose name happens to end in token', () => {
    const { code, out } = scan(plant('oauth.ts', `  tokenUrl: 'https://graph.facebook.com/v21.0/oauth/access_token',\n`));
    expect(code, out).toBe(0);
  });

  it('a compose file that does it right', () => {
    const yaml = [
      'POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?required}',
      'JWT_SECRET=',
      'API_TOKEN: # set in Coolify',
    ].join('\n');
    const { code, out } = scan(plant('docker-compose.yml', yaml));
    expect(code, out).toBe(0);
  });

  it('and the unquoted shape inside ordinary code, where it is not that shape at all', () => {
    // `password: someVariable` is how objects are written. The unquoted
    // rule applies only to files whose grammar is `NAME: value`.
    const { code, out } = scan(plant('handler.ts', '  const body = { password: hashedInput };\n'));
    expect(code, out).toBe(0);
  });

  it('and a sha-256 vector in a test file', () => {
    const { code, out } = scan(
      plant('hash.test.ts', `expect(h).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');\n`)
    );
    expect(code, out).toBe(0);
  });
});

describe('and the tree that ships is clean', () => {
  it('every tracked file passes', () => {
    // This is the assertion the CI step makes. It is here too so the
    // failure arrives in the suite, beside the change that caused it,
    // rather than four minutes later in a workflow log.
    const { code, out } = scan();
    expect(code, out).toBe(0);
    expect(out).toContain('Secret scan clean');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE GAPS THE REVIEWS FOUND IN THE SCANNER ITSELF (RV19 – RV24, C2).
 *
 * A guard is only as good as the shapes it has been watched failing on.
 * Each test below plants one shape the scanner used to wave through and
 * requires it to be reported — and, beside it, one look-alike it must
 * still leave alone, so the fix is not just «shout at more».
 * ═══════════════════════════════════════════════════════════════════════
 */
describe('RV19 — a neighbour on the same line cannot excuse a secret', () => {
  // Assembled, as above: the literal must never exist in this tracked file.
  const KEY = ['sk', '-', 'Qp7RtY2vLm9XbNc4KdEf8Ghj'].join('');

  it('a real key followed by a «test» comment is still a finding', () => {
    const { code, out } = scan(plant('client.ts', `const k = '${KEY}'; // test-only, remove later\n`));
    expect(code, out).toBe(1);
    expect(out).toContain('OpenAI key');
  });

  it('a real key on the same line as an example.com address is still a finding', () => {
    const { code, out } = scan(plant('client.ts', `fetch('https://example.com/v1', { key: '${KEY}' });\n`));
    expect(code, out).toBe(1);
  });

  it('two keys on one line, the first a fixture: the second is reported', () => {
    const real = ['sk', '-', 'Zx8CvBn3MaSd6FgHj9KlQw2E'].join('');
    // The first key says what it is in its own text, the second does not.
    const fixture = ['sk', '-', 'test', '-', 'Qp7RtY2vLm9XbNc4KdEf8Ghj'].join('');
    const { code, out } = scan(plant('client.ts', `const a = '${fixture}', b = '${real}';\n`));
    expect(code, out).toBe(1);
    expect(scan(plant('client2.ts', `const a = '${fixture}';\n`)).code).toBe(0);
  });

  it('but a value that says what it is, in its own text, is still let through', () => {
    const fixture = ['sk', '-', 'test', '-', 'Qp7RtY2vLm9XbNc4KdEf8Ghj'].join('');
    const { code, out } = scan(plant('client.ts', `const k = '${fixture}';\n`));
    expect(code, out).toBe(0);
  });

  it('and a signature published as an example is not a key', () => {
    const sig = 'a247d08e21565cfba9892352002c8d22cf8bf3a2790185101508df467f7633c0';
    const { code, out } = scan(plant('delivery.json', `{ "signature_example": "sha256=${sig}" }\n`));
    expect(code, out).toBe(0);
  });

  it('while thirty-two bare hex characters in source are still reported', () => {
    const { code, out } = scan(plant('config.ts', `const id = 'a247d08e21565cfba9892352002c8d22';\n`));
    expect(code, out).toBe(1);
    expect(out).toContain('Meta App Secret');
  });
});

describe('RV20 — a JSON key is a name with a quote after it', () => {
  it('"password": "value" is a finding', () => {
    const { code, out } = scan(plant('settings.json', '{ "password": "Mubarak2026" }\n'));
    expect(code, out).toBe(1);
    expect(out).toContain('Password literal');
  });

  it('and so are the other names, single-quoted too', () => {
    for (const name of ['apiKey', 'client_secret', 'access_token']) {
      const { code, out } = scan(plant('settings.json', `{ '${name}': 'Mubarak2026' }\n`));
      expect(code, `${name}: ${out}`).toBe(1);
    }
  });

  it('a JSON field that holds a label is not', () => {
    const { code, out } = scan(plant('labels.json', '{ "password": "كلمة المرور" }\n'));
    expect(code, out).toBe(0);
  });
});

describe('RV22 — a Dockerfile speaks NAME=value too', () => {
  it('ENV with a real-looking value is a finding', () => {
    const { code, out } = scan(plant('Dockerfile', 'FROM node:24-alpine\nENV DB_PASSWORD=Mubarak2026\n'));
    expect(code, out).toBe(1);
    expect(out).toContain('Dockerfile:2');
  });

  it('ARG with one is too', () => {
    const { code, out } = scan(plant('Dockerfile', 'ARG NPM_TOKEN=Mubarak2026abc\n'));
    expect(code, out).toBe(1);
  });

  it('a placeholder and an ordinary ENV are not', () => {
    const body = ['ENV JWT_SECRET=build-time-placeholder-secret-value', 'ENV NODE_ENV=production', 'ENV PORT=3000'].join('\n');
    const { code, out } = scan(plant('Dockerfile', `${body}\n`));
    expect(code, out).toBe(0);
  });

  it('and the real Dockerfile passes', () => {
    const { code, out } = scan('Dockerfile');
    expect(code, out).toBe(0);
  });
});

describe('RV23 — «not-used» no longer excuses a value', () => {
  it('a value that merely contains it is judged like any other', () => {
    const yaml = 'services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: Mubarak2026-not-used\n';
    const { code, out } = scan(plant('docker-compose.yml', yaml));
    expect(code, out).toBe(1);
  });

  it('the CI build secret is written as a placeholder instead', () => {
    const { code, out } = scan('.github/workflows/ci.yml');
    expect(code, out).toBe(0);
  });
});

describe('RV24 — only the YAML that keeps secret-shaped lines is read as such', () => {
  it('a Kubernetes-style file with ordinary words is left alone', () => {
    const { code, out } = scan(
      plant('deploy/service.yaml', ['spec:', '  imagePullSecret: my-registry-cred', '  apiKey: header', '  token: bearer-header'].join('\n') + '\n')
    );
    expect(code, out).toBe(0);
  });

  it('a CI workflow is still read, and a real value in it is a finding', () => {
    const { code, out } = scan(plant('.github/workflows/ci.yml', 'env:\n  JWT_SECRET: Mubarak2026Real\n'));
    expect(code, out).toBe(1);
  });
});

describe('C2 — an OpenAI-style key with dashes in it', () => {
  it('sk-proj-… is a finding, in a test file too', () => {
    const key = ['sk', '-', 'proj', '-', 'Ab3dEf9hJk2mNp4qRs7tUvWx1yZ'].join('');
    const { code, out } = scan(plant('fixture-data.test.ts', `const k = '${key}';\n`));
    expect(code, out).toBe(1);
    expect(out).toContain('OpenAI-style key');
  });

  it('so is an OpenRouter key, with underscores and an inner dash', () => {
    const key = ['sk', '-', 'or', '-', 'v1', '-', 'f3a9c2d4e6b8a0c1d2e3f4a5b6c7d8e9'].join('');
    const { code, out } = scan(plant('openrouter.ts', `const k = '${key}';\n`));
    expect(code, out).toBe(1);
  });

  it('a kebab-case word that happens to end in «sk» is not (the left boundary)', () => {
    const { code, out } = scan(
      plant('notes.ts', "const a = 'risk-assessment-and-mitigation-plan-2026'; const b = 'task-force-assessment-document-v2';\n")
    );
    expect(code, out).toBe(0);
  });

  it('and a long sk- slug with no digit in it is not', () => {
    const { code, out } = scan(plant('notes.ts', "const css = 'sk-the-quick-brown-fox-jumps-over-the-lazy-dog';\n"));
    expect(code, out).toBe(0);
  });

  it('a short one is not either', () => {
    const { code, out } = scan(plant('notes.ts', "const css = 'sk-a-1';\n"));
    expect(code, out).toBe(0);
  });
});
