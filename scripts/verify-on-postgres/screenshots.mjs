/**
 * Takes PNG screenshots of the kit app's pages through a headless Microsoft Edge or Google Chrome that is ALREADY INSTALLED, driven over the
 * DevTools protocol with Node's own `WebSocket` and `fetch` (no npm dependency, no browser download).
 *
 * DEFINITION OF DONE:
 *   1. Signs in through the app's REAL login API as a seeded user and hands the browser the cookies the app returned (the session cookie, and the
 *      country/store cookie from `POST /api/context`) — nothing is forged and no password is typed into a page.
 *   2. Navigates, waits for the load event, then for the page TEXT to contain every marker (`|`-separated), then for the network to settle.
 *   3. A page whose marker never appears, or that ended up on /login or /entry, is a FAILURE: the screenshot is still saved (as `<name>-<size>.FAILED.png`,
 *      for the eyes) and the exit code is 1 — a blank or login-page screenshot is never reported as a proof.
 *   4. One PNG per page per size: 1280x900 desktop and 390x844 mobile (`<out>/<name>-desktop.png`, `<out>/<name>-mobile.png`), viewport only
 *      (`--full` captures the whole page height).
 *   5. The Next dev indicator is hidden by a style injected into the page, so it is not in the picture. Nothing else on the page is touched.
 *
 * Pages (presets; each is one browser tab and one user):
 *   mine      «طلباتي» of the Syria agent of the ON company        /confirmation/mine           marker SY-HELD-NEW|SY-HELD-RETRY
 *   mine-off  «طلباتي» of the OFF company's agent                  /confirmation/mine           marker OFF-HELD-NEW
 *   mine-jo   «طلباتي» of the Jordan agent (ON company)            /confirmation/mine           marker JO-HELD-NEW
 *   settings  the key's card, as the ON company's admin            /settings/system             marker «إثبات المكالمات وجدول المحاولات»
 *   timeline  the order window of SY-CLOSED-TODAY, as the admin    /orders?highlight=<id>       marker SY-CLOSED-TODAY
 *
 *   KIT_PASSWORD=… node scripts/verify-on-postgres/screenshots.mjs --out <folder> [--pages mine,settings,timeline] [--base-url http://127.0.0.1:3100]
 *                                                                  [--browser <exe>] [--full] [--timeout 120]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { argv, die, psql, sleep } from './lib.mjs';
import { baseUrlFrom, chooseContext, login, passwordFrom } from './app-session.mjs';
import { USERS } from './scenario.mjs';

const args = argv({ full: 'flag' });
if (!args.out) die('ناقص --out <مجلد الصور>.');
const OUT = resolve(args.out);
mkdirSync(OUT, { recursive: true });
const base = baseUrlFrom(args['base-url']);
const password = passwordFrom(args.password);
const TIMEOUT_MS = Number(args.timeout || 120) * 1000;

const SIZES = [
  { name: 'desktop', width: 1280, height: 900, mobile: false },
  { name: 'mobile', width: 390, height: 844, mobile: true },
];

/** The id of a seeded order, by its number — read from the scratch database (the same container the seed wrote). */
function orderId(orderNumber) {
  const id = psql(`SELECT id FROM orders WHERE "orderNumber" = '${orderNumber.replace(/[^A-Za-z0-9-]/g, '')}' LIMIT 1`, 'scratch_zaki').out;
  if (!id) die(`ما لقيت الطلب ${orderNumber} — شغّل seed.mjs.`);
  return id;
}

const PRESETS = {
  mine: { who: 'agent1On', country: 'SY', route: '/confirmation/mine', marker: 'SY-HELD-NEW|SY-HELD-RETRY' },
  'mine-off': { who: 'agentOff', country: 'SY', route: '/confirmation/mine', marker: 'OFF-HELD-NEW' },
  'mine-jo': { who: 'agent2On', country: 'JO', route: '/confirmation/mine', marker: 'JO-HELD-NEW' },
  // `scroll`: the text to bring into the middle of the picture before it is taken (the card is far below the top of a long settings page).
  settings: { who: 'adminOn', country: 'SY', route: '/settings/system', marker: 'إثبات المكالمات وجدول المحاولات', scroll: 'إثبات المكالمات وجدول المحاولات' },
  timeline: { who: 'adminOn', country: 'SY', route: () => `/orders?highlight=${orderId('SY-CLOSED-TODAY')}`, marker: 'SY-CLOSED-TODAY' },
};
const wanted = (args.pages || 'mine,settings,timeline').split(',').map((s) => s.trim()).filter(Boolean);
for (const w of wanted) if (!PRESETS[w]) die(`صفحة مجهولة "${w}". المتاح: ${Object.keys(PRESETS).join(', ')}`);

// ───────────────────────── the browser ─────────────────────────

function findBrowser() {
  const candidates = [
    args.browser,
    process.env.KIT_BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) die('ما لقيت Edge ولا Chrome. مرّر --browser <المسار> أو KIT_BROWSER.');
  return found;
}

async function startBrowser() {
  const exe = findBrowser();
  const profile = mkdtempSync(join(tmpdir(), 'zaki-kit-browser-'));
  const child = spawn(
    exe,
    [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
      '--disable-extensions', '--disable-sync', '--disable-background-networking', '--mute-audio', 'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true }
  );
  // Port 0: the browser picks one and writes it, with the browser endpoint, to `DevToolsActivePort`.
  const file = join(profile, 'DevToolsActivePort');
  let port = null;
  for (let i = 0; i < 100 && !port; i++) {
    if (existsSync(file)) port = Number(readFileSync(file, 'utf8').split(/\r?\n/)[0]);
    else await sleep(200);
  }
  if (!port) {
    child.kill();
    die('المتصفح ما فتح بوابة DevTools خلال 20 ثانية.');
  }
  return { exe, child, port, profile };
}

/** A tiny DevTools client over one WebSocket. */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, no) => {
    ws.addEventListener('open', ok, { once: true });
    ws.addEventListener('error', () => no(new Error('WebSocket error')), { once: true });
  });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.id && pending.has(msg.id)) {
      const { ok, no } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? no(new Error(`${msg.error.message}`)) : ok(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  });
  return {
    send: (method, params = {}) =>
      new Promise((ok, no) => {
        const n = ++id;
        pending.set(n, { ok, no });
        ws.send(JSON.stringify({ id: n, method, params }));
      }),
    on: (fn) => listeners.push(fn),
    close: () => ws.close(),
  };
}

async function evaluate(page, expression) {
  const r = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

// ───────────────────────── one picture ─────────────────────────

async function shoot(browser, preset, name, size, jar) {
  const targets = await (await fetch(`http://127.0.0.1:${browser.port}/json/new?about:blank`, { method: 'PUT' })).json();
  const page = await connect(targets.webSocketDebuggerUrl);
  let inflight = 0;
  let lastActivity = Date.now();
  page.on((m) => {
    if (m.method === 'Network.requestWillBeSent') { inflight++; lastActivity = Date.now(); }
    if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') { inflight = Math.max(0, inflight - 1); lastActivity = Date.now(); }
  });
  try {
    await page.send('Page.enable');
    await page.send('Network.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile });
    if (size.mobile) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    // The dev-mode indicator of Next is not part of the product; keep it out of the picture.
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');s.textContent='nextjs-portal{display:none!important}';document.head.appendChild(s);});",
    });
    for (const [cookieName, value] of Object.entries(jar)) {
      await page.send('Network.setCookie', { name: cookieName, value, url: base, path: '/', httpOnly: true, sameSite: 'Lax' });
    }
    const route = typeof preset.route === 'function' ? preset.route() : preset.route;
    await page.send('Page.navigate', { url: `${base}${route}` });

    // 1 · the text: every marker must be in the rendered page.
    const markers = preset.marker.split('|');
    const deadline = Date.now() + TIMEOUT_MS;
    let missing = markers;
    let where = '';
    while (Date.now() < deadline) {
      await sleep(500);
      try {
        const state = await evaluate(page, `JSON.stringify({ href: location.pathname + location.search, text: document.body ? document.body.innerText : '' })`);
        const { href, text } = JSON.parse(state);
        where = href;
        missing = markers.filter((mk) => !text.includes(mk));
        if (missing.length === 0) break;
      } catch {
        /* the page is navigating */
      }
    }
    // 2 · the network settles (the desk polls, so «settled» is 800 ms with nothing in flight, for at most 15 s).
    const settleBy = Date.now() + 15_000;
    while (Date.now() < settleBy && !(inflight === 0 && Date.now() - lastActivity > 800)) await sleep(200);
    await evaluate(page, 'document.fonts ? document.fonts.ready.then(() => true) : true').catch(() => {});
    if (preset.scroll && !args.full) {
      // The first element whose own text holds the phrase, in the middle of the view.
      await evaluate(
        page,
        `(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { if (n.nodeValue.includes(${JSON.stringify(preset.scroll)})) { n.parentElement.scrollIntoView({ block: 'center' }); return true; } } return false; })()`
      ).catch(() => {});
    }
    await sleep(300);

    const redirected = /^\/(login|entry|no-access)/.test(where);
    const ok = missing.length === 0 && !redirected;
    if (args.full) {
      // The whole page: the window is made as tall as the content (a fixed sidebar then fits instead of being cut at the first screen), and the
      // layout gets a moment to settle before the picture.
      const m = await page.send('Page.getLayoutMetrics');
      const h = Math.min(Math.ceil(m.cssContentSize?.height ?? m.contentSize.height), 12000);
      await page.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: Math.max(h, size.height), deviceScaleFactor: 1, mobile: size.mobile });
      await sleep(800);
    }
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    const file = join(OUT, `${name}-${size.name}${ok ? '' : '.FAILED'}.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    return { ok, file, where, missing, redirected };
  } finally {
    page.close();
    await fetch(`http://127.0.0.1:${browser.port}/json/close/${targets.id}`).catch(() => {});
  }
}

// ───────────────────────── main ─────────────────────────

const browser = await startBrowser();
console.log(`[screenshots] المتصفح: ${browser.exe}\n[screenshots] التطبيق: ${base} → ${OUT}`);
let failed = false;
try {
  const sessions = new Map(); // `${who}/${country}` → the cookies, one sign-in each
  for (const name of wanted) {
    const preset = PRESETS[name];
    const key = `${preset.who}/${preset.country}`;
    if (!sessions.has(key)) {
      const { jar: session } = await login(base, USERS[preset.who].email, password);
      sessions.set(key, (await chooseContext(base, session, preset.country)).jar);
    }
    for (const size of SIZES) {
      const r = await shoot(browser, preset, name, size, sessions.get(key));
      if (!r.ok) failed = true;
      console.log(`[screenshots] ${r.ok ? 'OK    ' : 'FAILED'} ${name} (${size.name}) → ${r.file}${r.ok ? '' : ` — ناقص: ${r.missing.join(' | ') || '-'}${r.redirected ? ` · انحوّل لـ${r.where}` : ''}`}`);
    }
  }
} finally {
  browser.child.kill();
  await sleep(500);
  try {
    rmSync(browser.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    /* a temp profile that Windows still holds is not worth failing for */
  }
}
if (failed) die('بعض الصور فشلت (الصفحة ما حمّلت النص المطلوب أو انحوّلت لدخول). الصور المعلّمة FAILED للعين.');
console.log('[screenshots] خلصت.');
