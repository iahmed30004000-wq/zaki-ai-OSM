import { describe, expect, it } from 'vitest';
import {
  allowedHosts,
  chatCompletionsUrl,
  classifyHost,
  looksLikeSecret,
  parseCompatEndpoint,
  parseCompatModel,
  parseLocalEndpoint,
} from './ai-endpoint';

/**
 * These are the tests for the most dangerous text box in the product.
 *
 * Every prompt this system sends carries customer names, phones, addresses
 * and the company's own money. A base URL decides where the SERVER sends
 * them, from inside the network, with no export and no download to notice.
 * So the rule refuses by default and names what is allowed, and every case
 * below is a way somebody would try to get past it.
 */

describe('classifyHost', () => {
  it('knows the loopback address by all its spellings', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', 'ollama.localhost', '::1', '[::1]']) {
      expect(classifyHost(h), h).toBe('loopback');
    }
  });

  it('knows the private ranges a second machine in the rack lives on', () => {
    for (const h of ['10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.40', 'gpu.local', 'box.internal']) {
      expect(classifyHost(h), h).toBe('private');
    }
  });

  it('counts shared address space as private, where a VPN peer sits', () => {
    expect(classifyHost('100.64.0.1')).toBe('private');
    expect(classifyHost('100.127.255.255')).toBe('private');
    // And 100.128.x is ordinary public space again.
    expect(classifyHost('100.128.0.1')).toBe('public');
  });

  it('and 172.15 and 172.32 are NOT private — the range is 16 to 31', () => {
    expect(classifyHost('172.15.0.1')).toBe('public');
    expect(classifyHost('172.32.0.1')).toBe('public');
  });

  it('marks the cloud metadata range as link-local, never private', () => {
    // 169.254.169.254 hands out the machine's own IAM credentials.
    expect(classifyHost('169.254.169.254')).toBe('linklocal');
    expect(classifyHost('169.254.0.1')).toBe('linklocal');
  });

  it('judges an IPv4-mapped IPv6 address by the address it actually dials', () => {
    expect(classifyHost('::ffff:127.0.0.1')).toBe('loopback');
    expect(classifyHost('::ffff:169.254.169.254')).toBe('linklocal');
    expect(classifyHost('::ffff:8.8.8.8')).toBe('public');
  });

  it('knows IPv6 unique-local and link-local apart', () => {
    expect(classifyHost('fd00::1')).toBe('private');
    expect(classifyHost('fc00::1')).toBe('private');
    expect(classifyHost('fe80::1')).toBe('linklocal');
  });

  it('calls everything it does not recognise public, so the rule fails closed', () => {
    // 2130706433 IS 127.0.0.1 in decimal. It is not recognised, so it is
    // refused rather than quietly allowed.
    expect(classifyHost('2130706433')).toBe('public');
    expect(classifyHost('0x7f.0.0.1')).toBe('public');
    expect(classifyHost('127.0.0.01')).toBe('public');
    expect(classifyHost('999.1.1.1')).toBe('public');
    expect(classifyHost('evil.com')).toBe('public');
    expect(classifyHost('')).toBe('public');
  });
});

describe('parseLocalEndpoint — what the server may be pointed at', () => {
  it('accepts a model on the machine itself', () => {
    const r = parseLocalEndpoint('http://localhost:11434');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url).toBe('http://localhost:11434');
      expect(r.kind).toBe('loopback');
    }
  });

  it('accepts a model on the private network', () => {
    const r = parseLocalEndpoint('http://192.168.1.40:8000/v1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe('http://192.168.1.40:8000/v1');
  });

  it('REFUSES a public address — «محلي» does not mean on the internet', () => {
    const r = parseLocalEndpoint('https://api.evil.example/v1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('PUBLIC');
  });

  it('REFUSES the cloud metadata service by name, not as a generic failure', () => {
    // The whole reason this rule exists: this one returns the server's own
    // cloud credentials, and the connection test would render them.
    const r = parseLocalEndpoint('http://169.254.169.254/latest/meta-data/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('METADATA');
  });

  it('REFUSES a scheme that is not http or https', () => {
    for (const bad of ['file:///etc/passwd', 'gopher://127.0.0.1:70/', 'ftp://10.0.0.1/']) {
      const r = parseLocalEndpoint(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.code).toBe('SCHEME');
    }
  });

  it('REFUSES credentials smuggled into the address', () => {
    // A secret in a URL ends up in every log line that records the address.
    const r = parseLocalEndpoint('http://user:pass@127.0.0.1:11434');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('CREDENTIALS');
  });

  /**
   * AN OBFUSCATED ADDRESS IS JUDGED AS THE ADDRESS IT DIALS.
   *
   * `new URL` normalises a decimal or hexadecimal host to its real IPv4
   * form before this rule ever sees it — measured, not assumed. That cuts
   * the whole family of encoding tricks off at the root: the check is
   * always applied to the address the server would actually contact.
   */
  it('sees through a decimal or hex host to the real address', () => {
    // 2130706433 IS 127.0.0.1, and it is genuinely the loopback, so it passes.
    expect(parseLocalEndpoint('http://2130706433:11434').ok).toBe(true);
    expect(parseLocalEndpoint('http://0x7f.0.0.1').ok).toBe(true);

    // And the same trick aimed at the metadata service is still caught —
    // 2852039166 and 0xA9FEA9FE are both 169.254.169.254.
    expect(parseLocalEndpoint('http://2852039166/')).toMatchObject({ code: 'METADATA' });
    expect(parseLocalEndpoint('http://0xA9FEA9FE/')).toMatchObject({ code: 'METADATA' });
  });

  it('and through the IPv6-mapped spelling of the metadata address', () => {
    // The URL parser rewrites this host to [::ffff:a9fe:a9fe].
    expect(parseLocalEndpoint('http://[::ffff:169.254.169.254]/')).toMatchObject({ code: 'METADATA' });
  });

  it('says what to type when the box is empty or the address is nonsense', () => {
    expect(parseLocalEndpoint('')).toMatchObject({ ok: false, code: 'EMPTY' });
    expect(parseLocalEndpoint('   ')).toMatchObject({ ok: false, code: 'EMPTY' });
    expect(parseLocalEndpoint('localhost:11434')).toMatchObject({ ok: false, code: 'MALFORMED' });
    expect(parseLocalEndpoint(null)).toMatchObject({ ok: false, code: 'EMPTY' });
  });

  it('every refusal explains itself, and none leaks the address back', () => {
    const bad = ['', 'not a url', 'file:///etc/passwd', 'http://u:p@127.0.0.1', 'http://169.254.169.254', 'https://evil.example'];
    for (const raw of bad) {
      const r = parseLocalEndpoint(raw);
      expect(r.ok, raw).toBe(false);
      if (!r.ok) expect(r.message.length, raw).toBeGreaterThan(20);
    }
  });

  it('and no refusal is written in Eastern digits', () => {
    const messages = ['', 'x', 'file:///x', 'http://u:p@127.0.0.1', 'http://169.254.169.254', 'https://evil.example']
      .map((raw) => { const r = parseLocalEndpoint(raw); return r.ok ? '' : r.message; })
      .join(' ');
    const eastern = [...messages].filter((c) => c.charCodeAt(0) >= 0x660 && c.charCodeAt(0) <= 0x669);
    expect(eastern).toEqual([]);
  });

  describe('the operator’s allowlist', () => {
    it('lets a named host through, whatever network it is on', () => {
      const r = parseLocalEndpoint('https://models.mycorp.com/v1', ['models.mycorp.com']);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.kind).toBe('allowlisted');
    });

    it('but the allowlist is not a way past the scheme or the credentials rule', () => {
      expect(parseLocalEndpoint('file://models.mycorp.com', ['models.mycorp.com']).ok).toBe(false);
      expect(parseLocalEndpoint('http://u:p@models.mycorp.com', ['models.mycorp.com']).ok).toBe(false);
    });

    it('and it comes from the environment, never from a setting', () => {
      // Adding one takes shell access, which is a much smaller set of people
      // than "can open the settings screen".
      expect(allowedHosts({ AI_LOCAL_ALLOWED_HOSTS: ' A.com , b.com ,, ' }))
        .toEqual(['a.com', 'b.com']);
      expect(allowedHosts({})).toEqual([]);
    });

    it('an empty allowlist allows nothing extra', () => {
      expect(parseLocalEndpoint('https://models.mycorp.com/v1', []).ok).toBe(false);
      expect(parseLocalEndpoint('https://models.mycorp.com/v1').ok).toBe(false);
    });
  });

  describe('what gets stored', () => {
    it('drops the trailing slash, the query and the fragment', () => {
      // A saved address must not smuggle parameters onto every later request.
      const r = parseLocalEndpoint('http://localhost:11434/v1/?key=leak#frag');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.url).toBe('http://localhost:11434/v1');
    });

    it('keeps the port and the path, which are where the server actually is', () => {
      const r = parseLocalEndpoint('http://10.0.0.5:8000/openai/v1');
      if (r.ok) expect(r.url).toBe('http://10.0.0.5:8000/openai/v1');
    });
  });
});

describe('chatCompletionsUrl', () => {
  it('adds the OpenAI-compatible path that local servers all speak', () => {
    expect(chatCompletionsUrl('http://localhost:11434')).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('does not add a second /v1 when one is already there', () => {
    expect(chatCompletionsUrl('http://localhost:8000/v1')).toBe('http://localhost:8000/v1/chat/completions');
  });

  it('and leaves a full path alone — a gateway may serve it elsewhere', () => {
    expect(chatCompletionsUrl('http://localhost:9/custom/chat/completions'))
      .toBe('http://localhost:9/custom/chat/completions');
  });

  it('is not confused by a trailing slash', () => {
    expect(chatCompletionsUrl('http://localhost:11434/')).toBe('http://localhost:11434/v1/chat/completions');
  });
});

/**
 * THE ADDRESS OF A SERVER ON THE INTERNET THAT THE SERVER ITSELF WILL DIAL.
 *
 * `parseLocalEndpoint` accepts what is private and refuses the rest.
 * `parseCompatEndpoint` has the opposite problem — it must accept only a
 * public NAME — and `classifyHost` answers `public` for anything it does not
 * recognise, so a validator written as «refuse private» would let through
 * exactly the spellings nobody thought of. Every refusal below is a way
 * somebody would try, and each has its own assertion that it IS refused.
 */
const codeOf = (raw: string | null | undefined) => {
  const r = parseCompatEndpoint(raw);
  expect(r.ok, String(raw)).toBe(false);
  return r.ok ? null : r.code;
};

describe('parseCompatEndpoint — what is accepted', () => {
  it('a public https name, with the query and fragment dropped and no trailing slash', () => {
    const r = parseCompatEndpoint('https://models.example.com/v1/?token=x#frag');
    expect(r).toEqual({ ok: true, url: 'https://models.example.com/v1', host: 'models.example.com' });
  });

  it('keeps a port and a nested path', () => {
    const r = parseCompatEndpoint('https://glm.example.org:8443/api/paas/v4');
    expect(r.ok && r.url).toBe('https://glm.example.org:8443/api/paas/v4');
  });

  it('chatCompletionsUrl turns it into the chat endpoint', () => {
    const r = parseCompatEndpoint('https://models.example.com/v1');
    expect(r.ok && chatCompletionsUrl(r.url)).toBe('https://models.example.com/v1/chat/completions');
  });
});

describe('parseCompatEndpoint — the scheme and the credentials', () => {
  it('empty and malformed', () => {
    expect(codeOf('')).toBe('EMPTY');
    expect(codeOf(null)).toBe('EMPTY');
    expect(codeOf('models.example.com/v1')).toBe('MALFORMED');
    expect(codeOf('https://')).toBe('MALFORMED');
  });

  it('http is refused — the key rides on this request', () => {
    expect(codeOf('http://models.example.com/v1')).toBe('NOT_HTTPS');
    expect(codeOf('ftp://models.example.com/v1')).toBe('NOT_HTTPS');
    expect(codeOf('file:///etc/passwd')).toBe('NOT_HTTPS');
  });

  it('a user and password inside the address are refused', () => {
    expect(codeOf('https://user:pass@models.example.com/v1')).toBe('CREDENTIALS');
    expect(codeOf('https://user@models.example.com/v1')).toBe('CREDENTIALS');
  });
});

describe('parseCompatEndpoint — every IP literal, in every spelling', () => {
  it('loopback is refused as the private network it is', () => {
    expect(codeOf('https://127.0.0.1/v1')).toBe('PRIVATE');
    expect(codeOf('https://[::1]/v1')).toBe('PRIVATE');
    expect(codeOf('https://localhost/v1')).toBe('PRIVATE');
  });

  it('the cloud metadata address is named for what it is', () => {
    expect(codeOf('https://169.254.169.254/latest/meta-data')).toBe('METADATA');
    expect(codeOf('https://[::ffff:a9fe:a9fe]/')).toBe('METADATA');
  });

  it('the private ranges', () => {
    for (const h of ['10.0.0.5', '192.168.1.2', '172.16.0.1', '100.64.0.1']) {
      expect(codeOf(`https://${h}/v1`), h).toBe('PRIVATE');
    }
  });

  it('the same loopback address written as hexadecimal or as one decimal number', () => {
    // WHATWG rewrites both to 127.0.0.1 before this function sees a host.
    expect(codeOf('https://0x7f000001/v1')).toBe('PRIVATE');
    expect(codeOf('https://2130706433/v1')).toBe('PRIVATE');
    expect(codeOf('https://127.1/v1')).toBe('PRIVATE');
  });

  it('and the addresses classifyHost would have called «public» and let in', () => {
    // Each of these is a reason the accepting branch cannot be «not private».
    for (const h of ['0.0.0.0', '[::]', '[::7f00:1]', '[64:ff9b::7f00:1]', '255.255.255.255', '240.0.0.1', '8.8.8.8', '[2606:4700::1111]']) {
      expect(parseCompatEndpoint(`https://${h}/v1`).ok, h).toBe(false);
    }
    expect(codeOf('https://8.8.8.8/v1')).toBe('IP_LITERAL');
  });
});

describe('parseCompatEndpoint — a name must look like a public name', () => {
  it('a trailing dot is not accepted', () => {
    expect(codeOf('https://localhost./v1')).toBe('BAD_HOST');
    expect(codeOf('https://models.example.com./v1')).toBe('BAD_HOST');
  });

  it('a single word — a Docker service name — is not accepted', () => {
    expect(codeOf('https://salesflow-db/v1')).toBe('BAD_HOST');
    expect(codeOf('https://salesflow-postgres:5432/v1')).toBe('BAD_HOST');
    expect(codeOf('https://ollama/v1')).toBe('BAD_HOST');
  });

  it('an ending that is not letters is not accepted', () => {
    // A numeric ending makes the URL parser read an IPv4 address and fail.
    expect(parseCompatEndpoint('https://models.example.123/v1').ok).toBe(false);
    expect(codeOf('https://models.e/v1')).toBe('BAD_HOST');
    expect(codeOf('https://models.example.c0m/v1')).toBe('BAD_HOST');
  });

  it('the endings that exist only on a private network', () => {
    for (const h of ['box.local', 'gpu.internal', 'router.lan', 'a.b.corp', 'srv.home.arpa', 'x.localhost', 'a.test', 'a.invalid', 'a.example', 'nas.home', 'a.intranet', 'a.localdomain']) {
      expect(parseCompatEndpoint(`https://${h}/v1`).ok, h).toBe(false);
    }
    expect(codeOf('https://box.lan/v1')).toBe('RESERVED_HOST');
  });

  it('an environment allowlist cannot widen it — the function takes none', () => {
    const before = process.env.AI_LOCAL_ALLOWED_HOSTS;
    process.env.AI_LOCAL_ALLOWED_HOSTS = 'box.local,10.0.0.5,models.internal';
    try {
      expect(allowedHosts()).toContain('box.local');
      expect(parseCompatEndpoint('https://box.local/v1').ok).toBe(false);
      expect(parseCompatEndpoint('https://10.0.0.5/v1').ok).toBe(false);
      expect(parseCompatEndpoint('https://models.internal/v1').ok).toBe(false);
      expect(parseCompatEndpoint.length).toBe(1);
    } finally {
      if (before === undefined) delete process.env.AI_LOCAL_ALLOWED_HOSTS;
      else process.env.AI_LOCAL_ALLOWED_HOSTS = before;
    }
  });

  it('a token in the path is refused — it would be stored and shown in the clear', () => {
    expect(codeOf('https://models.example.com/sk-test-3f9a2b7c-1d4e-4b8a-9c0d-aaaaaaaaaaaa/v1')).toBe('PATH_SECRET');
    expect(codeOf('https://models.example.com/v1/Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA')).toBe('PATH_SECRET');
    expect(parseCompatEndpoint('https://models.example.com/compatible-mode/v1').ok).toBe(true);
  });
});

describe('parseCompatModel and looksLikeSecret', () => {
  it('real model names are accepted', () => {
    for (const m of ['glm-4.6', 'Qwen/Qwen2.5-72B-Instruct', 'meta-llama/llama-3.3-70b-instruct:free', 'claude-haiku-4-5-20251001', 'mistral-small-latest']) {
      expect(parseCompatModel(m), m).toEqual({ ok: true, model: m });
    }
  });

  it('empty is refused', () => {
    expect(parseCompatModel('  ').ok).toBe(false);
    expect(parseCompatModel(null).ok).toBe(false);
  });

  it('characters outside the pattern, spaces and 121 characters are refused', () => {
    for (const m of ['glm 4.6', 'glm;rm', 'نموذج', 'a'.repeat(121), 'glm<script>', 'glm\\n4']) {
      expect(parseCompatModel(m).ok, m).toBe(false);
    }
  });

  it('the shape of a key is refused, in whichever format it comes', () => {
    for (const m of [
      'sk-test-aaaa1111-bbbb2222-cccc3333',
      'gw.test-LEAKMARKER-9f8e7d6c5b',
      'key_test_abcdef',
      'Bearer-abc',
      'ghp_abcdefghijklmnop',
      'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
      '3f9a2b7c-1d4e-4b8a-9c0d-5e6f7a8b9c0d',
    ]) {
      const r = parseCompatModel(m);
      expect(r.ok, m).toBe(false);
      expect(r.ok ? '' : r.code).toBe('MODEL_INVALID');
    }
    expect(looksLikeSecret('glm-4.6')).toBe(false);
  });
});
