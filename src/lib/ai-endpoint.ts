/**
 * WHERE «A MODEL ON MY OWN SERVER» IS ALLOWED TO POINT.
 *
 * The owner's note: «وإذا بدي أحمّل نموذج محلي ع السيرفر مستقبلاً». Honouring
 * it means one new setting — a base URL the server will POST to — and that
 * single text box is the most dangerous field in this product.
 *
 * WHAT IT CAN BE ABUSED FOR, said plainly, because the mitigation only makes
 * sense against the attack:
 *
 *   EXFILTRATION. Every AI call carries a prompt, and the prompts in this
 *   system carry customer names, phone numbers, addresses, order amounts and
 *   the company's own figures. Anybody who can reach the settings screen and
 *   type a URL can have the SERVER — not their own browser, the server, with
 *   its network position and its outbound allowances — send all of that to a
 *   host they control, one request at a time, for as long as nobody notices.
 *   There is no download, no export, no audit of a bulk read: it looks like
 *   the AI working.
 *
 *   THE CLOUD METADATA SERVICE. `http://169.254.169.254/` answers only to
 *   requests made from inside the instance, and on a default AWS, GCP or
 *   Azure box it hands out the machine's own IAM credentials. A base-URL box
 *   with no rules turns "configure your local model" into "read the server's
 *   cloud keys", and the reply comes back rendered on the settings screen by
 *   the connection test.
 *
 *   THE PRIVATE NETWORK. The server can reach things the internet cannot —
 *   an admin panel on another port, a database's HTTP interface, another
 *   tenant's service. A URL box is a request forger sitting inside the
 *   perimeter (SSRF), and the connection test makes it interactive.
 *
 * SO THE RULE IS THE OPPOSITE OF A BLOCKLIST. A blocklist of "bad" hosts is
 * a list somebody gets around; this refuses everything and then names what is
 * allowed: the loopback address, the private ranges a second machine in the
 * same rack would live on, and names an operator explicitly allowed in the
 * ENVIRONMENT — which takes shell access, not a settings form. A public
 * address is refused outright, because «محلي» does not mean "on the
 * internet", and if it is on the internet it is a vendor and belongs behind a
 * vendor's entry with a vendor's key.
 *
 * Pure, and tested, because a rule about what the server may dial is not a
 * rule anybody should have to re-derive while reading a route.
 */

export type EndpointRefusal =
  | 'EMPTY'
  | 'MALFORMED'
  | 'SCHEME'
  | 'CREDENTIALS'
  | 'METADATA'
  | 'PUBLIC'
  // The «خادم متوافق مع OpenAI» door — see `parseCompatEndpoint`.
  | 'NOT_HTTPS'
  | 'PRIVATE'
  | 'IP_LITERAL'
  | 'BAD_HOST'
  | 'RESERVED_HOST'
  | 'PATH_SECRET'
  | 'MODEL_INVALID';

export type HostKind = 'loopback' | 'private' | 'linklocal' | 'public';

export interface EndpointOk {
  ok: true;
  /** The address as it will be stored: no trailing slash, no fragment, no query. */
  url: string;
  host: string;
  kind: Extract<HostKind, 'loopback' | 'private'> | 'allowlisted';
}

export interface EndpointRefused {
  ok: false;
  code: EndpointRefusal;
  /** What is wrong and what to do, in the reader's own words. */
  message: string;
}

export type EndpointCheck = EndpointOk | EndpointRefused;

const refuse = (code: EndpointRefusal, message: string): EndpointRefused => ({ ok: false, code, message });

/** Each octet of a dotted-quad, or null when it is not one. */
function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map((n) => Number(n));
  // `01.02.03.04` and `999.1.1.1` are not addresses. Anything this does not
  // recognise falls through to `public`, which is refused — fail closed.
  if (parts.some((n) => n > 255)) return null;
  if (m.slice(1).some((s) => s.length > 1 && s.startsWith('0'))) return null;
  return parts;
}

/**
 * WHICH NETWORK A HOST BELONGS TO.
 *
 * Anything unrecognised is `public`, and public is refused — a decimal-encoded
 * address (`http://2130706433/` is 127.0.0.1) or a name this cannot resolve
 * lands there and is turned away rather than guessed at.
 */
export function classifyHost(rawHost: string): HostKind {
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return 'public';

  // IPv4-mapped IPv6 (::ffff:127.0.0.1) is an IPv4 destination wearing a
  // different spelling, and must be judged as the address it actually dials.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (mapped) return classifyHost(mapped[1]);

  /**
   * AND THE SAME ADDRESS IN HEXADECIMAL.
   *
   * `new URL('http://[::ffff:169.254.169.254]/')` normalises the host to
   * `[::ffff:a9fe:a9fe]` — the metadata address, written in a form the
   * dotted-quad branch above does not recognise. It fell through to `public`
   * and was refused, so nothing was ever let through; but it was refused as
   * "not on your network" when the truthful answer is "that is the cloud
   * metadata service". Decoded here so the refusal names what it found.
   */
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (hexMapped) {
    const n = (parseInt(hexMapped[1], 16) << 16) | parseInt(hexMapped[2], 16);
    return classifyHost([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
  }

  if (host === '::1') return 'loopback';
  // Unique-local (fc00::/7) is IPv6's private range; fe80::/10 is its
  // link-local, which is where the metadata service lives on some clouds.
  if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return 'private';
  if (/^fe[89ab][0-9a-f]:/.test(host)) return 'linklocal';

  const v4 = ipv4(host);
  if (v4) {
    const [a, b] = v4;
    if (a === 127) return 'loopback';
    // 169.254.0.0/16 — the cloud metadata range. Named separately from
    // `public` so the refusal can say why rather than «ليس محلياً».
    if (a === 169 && b === 254) return 'linklocal';
    if (a === 10) return 'private';
    if (a === 172 && b >= 16 && b <= 31) return 'private';
    if (a === 192 && b === 168) return 'private';
    // RFC 6598 shared address space — where a WireGuard or Tailscale peer
    // sits. Not routable on the public internet, so a second machine of the
    // owner's can legitimately live here.
    if (a === 100 && b >= 64 && b <= 127) return 'private';
    return 'public';
  }

  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  // Names that cannot exist on the public internet by definition.
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return 'private';

  return 'public';
}

/**
 * The hosts an operator has allowed by hand, from the environment.
 *
 * Deliberately NOT a setting: adding one takes shell access to the server,
 * which is a different and much smaller set of people than "can open the
 * settings screen". The escape hatch exists — a model behind a reverse proxy
 * on a real name is a real deployment — but taking it is an act of
 * administration, not a text box.
 */
export function allowedHosts(env: Record<string, string | undefined> = process.env): string[] {
  return (env.AI_LOCAL_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Check and normalise a local model's address.
 *
 * `allowed` is passed rather than read so the rule is pure and a test does
 * not have to mutate the process environment to describe a deployment.
 */
export function parseLocalEndpoint(raw: string | null | undefined, allowed: string[] = []): EndpointCheck {
  const text = (raw ?? '').trim();
  if (!text) {
    return refuse('EMPTY', 'اكتب عنوان الخادم الذي يشغّل النموذج — مثال: http://localhost:11434');
  }

  const badAddress = refuse(
    'MALFORMED',
    'العنوان غير صالح — اكتبه كاملاً مع البروتوكول والمنفذ، مثال: http://localhost:11434'
  );

  /**
   * «localhost:11434» PARSES, AND NOT AS AN ADDRESS.
   *
   * `new URL('localhost:11434')` succeeds with the protocol `localhost:` and
   * an empty host — so the commonest way to type this box wrong would have
   * been turned away with «لا يُقبل إلا http أو https», which is true and
   * tells the reader nothing about what they actually forgot.
   */
  if (!text.includes('://')) return badAddress;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return badAddress;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    // file:, gopher:, ftp: and friends are how a fetch is turned into a file
    // read or a protocol the server was never meant to speak.
    return refuse('SCHEME', 'لا يُقبل إلا http أو https.');
  }

  if (url.username || url.password) {
    // A secret in a URL ends up in every log line that records the address.
    return refuse('CREDENTIALS', 'لا تضع اسم مستخدم أو كلمة مرور داخل العنوان — ضع المفتاح في خانة المفتاح.');
  }

  const host = url.hostname.toLowerCase();
  const kind = classifyHost(host);

  if (allowed.includes(host)) {
    return { ok: true, url: normalise(url), host, kind: 'allowlisted' };
  }

  if (kind === 'linklocal') {
    return refuse(
      'METADATA',
      'هذا النطاق محجوز لخدمة بيانات الخادم عند مزوّد الاستضافة، وليس عنوان نموذج — مرفوض.'
    );
  }

  if (kind === 'public') {
    return refuse(
      'PUBLIC',
      'العنوان ليس على شبكتك — النموذج المحلي يكون على الخادم نفسه أو على شبكتك الداخلية. مزوّد على الإنترنت يُضاف كمزوّد بمفتاحه.'
    );
  }

  return { ok: true, url: normalise(url), host, kind };
}

/**
 * The address as it is stored.
 *
 * Query and fragment are dropped: they are not part of where a server lives,
 * and carrying them would let a saved address smuggle parameters onto every
 * request the system makes afterwards.
 */
function normalise(url: URL): string {
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

export interface CompatEndpointOk {
  ok: true;
  /** The address as it will be stored: https, no trailing slash, no query, no fragment. */
  url: string;
  host: string;
}

export type CompatEndpointCheck = CompatEndpointOk | EndpointRefused;

/**
 * Names that never resolve on the public internet, or that an operator
 * means to keep private. A suffix match, so `box.lan` and `a.b.corp` both
 * fall here. `example.com` itself is deliberately NOT listed: only the
 * `.example` top level is reserved, and the second-level names are what
 * documentation and tests use.
 */
const RESERVED_SUFFIXES = [
  'local',
  'internal',
  'localhost',
  'home.arpa',
  'arpa',
  'lan',
  'corp',
  'home',
  'intranet',
  'private',
  'localdomain',
  'test',
  'invalid',
  'example',
  'onion',
];

/**
 * LOOKS LIKE A SECRET, SO IT DOES NOT BELONG IN A BOX THAT IS NOT A SECRET BOX.
 *
 * The model name and the address are stored unencrypted, written to the
 * audit, shown to every company that can open the AI screen, and quoted in
 * the text of an error. A key pasted into the wrong box would travel all of
 * those ways, so the shapes a key takes are refused in them.
 */
export function looksLikeSecret(token: string): boolean {
  const t = token.trim();
  // A vendor prefix: sk-…, key_…, gw.…, Bearer …
  if (/^(sk|pk|key|gw|bearer|ghp|gho|xox[baprs])[-_.: ]/i.test(t)) return true;
  // One opaque run — nobody names a model, or a path, with 24 unbroken characters.
  if (/[A-Za-z0-9]{24,}/.test(t)) return true;
  // Groups of letters and digits joined by dashes, the way some gateways print a key.
  if (/^[A-Za-z0-9]{8,}(?:-[A-Za-z0-9]{4,}){2,}$/.test(t)) return true;
  return false;
}

/**
 * CHECK AND NORMALISE THE ADDRESS OF AN OPENAI-COMPATIBLE SERVER ON THE INTERNET.
 *
 * `parseLocalEndpoint` is a BLOCKLIST turned inside out: it accepts what is
 * private. This one takes a name that must be PUBLIC, and a validator that
 * accepts «anything not recognised as private» is the wrong way round —
 * `classifyHost` answers `public` for what it does not understand
 * (`0.0.0.0`, `localhost.`, a Docker service name, `[::7f00:1]`), and here
 * `public` is the accepting branch. So this one ACCEPTS a narrow shape and
 * refuses the rest:
 *
 *   https, and nothing else — the key rides on this request;
 *   no user:password in the address;
 *   no IP literal of any kind, in any spelling (`0x7f000001` and
 *   `2130706433` are turned into 127.0.0.1 by the URL parser and caught
 *   there) — a server with a valid certificate has a name;
 *   a dotted name with a letters-only ending and no trailing dot, so a
 *   one-word Docker name or `localhost.` has no way in;
 *   none of the endings that exist only on a private network.
 *
 * It takes NO allowlist. `AI_LOCAL_ALLOWED_HOSTS` turns a host into «محلي»,
 * and a model that counts as local is one customer data may be sent to; the
 * address here is always an outside party, so nothing in the environment can
 * widen it.
 *
 * The check is on the NAME. A public name that resolves to a private address
 * is not caught here; https (the metadata service speaks plain http), the
 * certificate, the system-administrator-only door and `redirect: 'error'` at
 * the call are what stand behind it.
 */
export function parseCompatEndpoint(raw: string | null | undefined): CompatEndpointCheck {
  const text = (raw ?? '').trim();
  if (!text) {
    return refuse('EMPTY', 'اكتب عنوان الخادم الذي يشغّل النموذج — يبدأ بـ https');
  }

  const badAddress = refuse(
    'MALFORMED',
    'العنوان غير صالح — اكتبه كاملاً مع البروتوكول، يبدأ بـ https'
  );
  if (!text.includes('://')) return badAddress;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return badAddress;
  }

  if (url.protocol !== 'https:') {
    return refuse('NOT_HTTPS', 'لا يُقبل إلا https — المفتاح وطلباتك ما بيمشوا على الإنترنت بلا تشفير.');
  }

  if (url.username || url.password) {
    return refuse('CREDENTIALS', 'لا تضع اسم مستخدم أو كلمة مرور داخل العنوان — ضع المفتاح في خانة المفتاح.');
  }

  const host = url.hostname.toLowerCase();
  const kind = classifyHost(host);

  // An IP literal: bracketed IPv6, or a dotted quad (every other spelling of
  // an IPv4 address was already rewritten to this by the URL parser).
  if (host.startsWith('[') || /^\d+(?:\.\d+)*$/.test(host)) {
    if (kind === 'linklocal') {
      return refuse(
        'METADATA',
        'هذا النطاق محجوز لخدمة بيانات الخادم عند مزوّد الاستضافة، وليس عنوان نموذج — مرفوض.'
      );
    }
    if (kind === 'loopback' || kind === 'private') {
      return refuse('PRIVATE', 'هذا عنوان على شبكتك الداخلية — أضِفه كـ«نموذج على خادمك».');
    }
    return refuse('IP_LITERAL', 'اكتب اسم الخادم لا رقمه — الأرقام لا تُقبل، والشهادة تكون على الاسم.');
  }

  if (kind === 'linklocal') {
    return refuse(
      'METADATA',
      'هذا النطاق محجوز لخدمة بيانات الخادم عند مزوّد الاستضافة، وليس عنوان نموذج — مرفوض.'
    );
  }
  if (kind === 'loopback' || kind === 'private') {
    return refuse('PRIVATE', 'هذا عنوان على شبكتك الداخلية — أضِفه كـ«نموذج على خادمك».');
  }

  const labels = host.split('.');
  const tld = labels[labels.length - 1];
  const wellFormed =
    host.length <= 253 &&
    labels.length >= 2 &&
    labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) &&
    /^[a-z]{2,63}$/.test(tld);
  if (!wellFormed) {
    return refuse(
      'BAD_HOST',
      'اسم الخادم غير صالح — لازم اسم كامل بنقطة، مثل نطاق حقيقي، بلا نقطة في آخره.'
    );
  }

  if (RESERVED_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) {
    return refuse('RESERVED_HOST', 'هذا اسم لا يوجد على الإنترنت العام — مرفوض.');
  }

  // A token pasted into the path would be stored in the clear and shown to
  // every company that can open the screen.
  if (url.pathname.split('/').some((seg) => seg && looksLikeSecret(decodeURIComponentSafe(seg)))) {
    return refuse('PATH_SECRET', 'في العنوان جزء يشبه مفتاحاً — ضع المفتاح في خانة المفتاح لا في العنوان.');
  }

  return { ok: true, url: normalise(url), host };
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * The name a compatible server answers to — `glm-4.6`, `Qwen/Qwen2.5-72B`.
 *
 * Letters, digits and `. _ : / @ -` only, at most 120 characters, and not
 * the shape of a key (see `looksLikeSecret`): the box sits beside the key
 * box and is not encrypted.
 */
export const COMPAT_MODEL_PATTERN = /^[A-Za-z0-9._:/@-]{1,120}$/;

export type CompatModelCheck = { ok: true; model: string } | EndpointRefused;

export function parseCompatModel(raw: string | null | undefined): CompatModelCheck {
  const text = (raw ?? '').trim();
  if (!text) return refuse('EMPTY', 'اكتب اسم النموذج كما يعرّفه خادمك.');
  if (!COMPAT_MODEL_PATTERN.test(text) || looksLikeSecret(text)) {
    return refuse(
      'MODEL_INVALID',
      'اسم النموذج غير صالح — حروف وأرقام ونقطة وشرطة فقط. والمفتاح له خانته، لا تلصقه هنا.'
    );
  }
  return { ok: true, model: text };
}

/**
 * The chat endpoint of a local server.
 *
 * Ollama, vLLM and LM Studio all speak the OpenAI chat-completions shape at
 * `/v1/chat/completions`, which is why the local provider needs no adapter of
 * its own. An operator who has already typed the full path keeps it, because
 * a gateway in front of the model may well serve it somewhere else.
 */
export function chatCompletionsUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}
