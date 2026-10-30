import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE HEADER ABOVE THE FEATURE.
 *
 * A scanner was built, tested, and shipped, and it could not have worked on
 * a single device: the site answered with `Permissions-Policy: camera=()`,
 * and an empty list means NOBODY — including this app. `getUserMedia`
 * failed before the browser ever asked the person for permission.
 *
 * No component test could have caught it. A component test mocks
 * `getUserMedia`; the policy is the layer above, in a config file nothing
 * imports. The only way to find it was to open the app and ask the browser
 * whether the camera was allowed — so the answer is written down here.
 *
 * The rule, stated generally: if the code asks the browser for a device or
 * an origin, the headers must permit it. A feature the headers forbid is a
 * feature that does not exist, however well it is tested.
 */

const config = () => readFileSync(join(process.cwd(), 'next.config.ts'), 'utf8');

/**
 * The dashboard's own policy: the FIRST Content-Security-Policy in the
 * file, the one on the site-wide headers. Slicing at the name of the
 * selling-page constant does not work — it is also the import at the top.
 */
function dashboardCsp(): string {
  const text = config();
  const at = text.indexOf("key: 'Content-Security-Policy'");
  expect(at, 'اختفت سياسة المحتوى').toBeGreaterThan(-1);
  const end = text.indexOf('].join', at);
  return text.slice(at, end > -1 ? end : at + 1200);
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if ((p.endsWith('.ts') || p.endsWith('.tsx')) && !p.includes('.test.')) out.push(p);
  }
  return out;
}

const src = () => sourceFiles(join(process.cwd(), 'src')).map((f) => readFileSync(f, 'utf8'));

describe('what the headers allow', () => {
  it('permits the camera, because something in here opens one', () => {
    const asksForCamera = src().some((s) => /getUserMedia\(\{[\s\S]{0,80}video/.test(s));
    expect(asksForCamera, 'لم يعد في النظام ما يفتح كاميرا — احذف هذا الاختبار').toBe(true);

    const policy = /Permissions-Policy'[^}]*value: '([^']+)'/.exec(config());
    expect(policy, 'اختفت سياسة الأذونات').toBeTruthy();
    const camera = /camera=\(([^)]*)\)/.exec(policy![1]);
    expect(camera, 'الكاميرا غير مذكورة في السياسة').toBeTruthy();
    expect(
      camera![1].trim(),
      'camera=() تعني: لا أحد، ونحن منهم — والماسح يفشل قبل أن يُسأل المستخدم'
    ).toContain('self');
  });

  it('and still refuses the three nothing here asks for', () => {
    const policy = /Permissions-Policy'[^}]*value: '([^']+)'/.exec(config())![1];
    for (const feature of ['microphone', 'geolocation', 'payment']) {
      expect(policy, `${feature} لم يعد مغلقاً`).toContain(`${feature}=()`);
    }
  });

  it('permits the font sheet the theme picker previews from', () => {
    // The picker offers twenty Arabic faces. Without the origin it renders
    // all twenty in the default, and the screen silently lies.
    const usesGoogleFonts = src().some((s) => s.includes('https://fonts.googleapis.com/css2'));
    expect(usesGoogleFonts, 'لم يعد أحد يحمّل خطوط جوجل — احذف هذا الاختبار').toBe(true);

    const dashboard = dashboardCsp();
    expect(dashboard, 'ورقة الخطوط محجوبة عن لوحة التحكم').toContain(
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com"
    );
    expect(dashboard, 'ملفات الخطوط نفسها محجوبة').toContain('https://fonts.gstatic.com');
  });

  it('and does not open the dashboard to an ad network’s code', () => {
    // The reason the dashboard keeps its own policy at all. Fonts are a
    // stylesheet; a pixel is a script, and an admin screen has no business
    // running one.
    const scriptSrc = /"script-src ([^"]+)"/.exec(dashboardCsp());
    expect(scriptSrc).toBeTruthy();
    for (const host of ['facebook', 'tiktok', 'snapchat', 'googletagmanager']) {
      expect(scriptSrc![1], `${host} صار مسموحاً في لوحة التحكم`).not.toContain(host);
    }
  });
});

/**
 * WHAT THE BUILD MUST NOT SEND WITH THE PAGE.
 *
 * Both of these are correct today by DEFAULT, which is exactly why they
 * are written down: a default is a thing nobody decided, and nobody
 * reviews the line that turns one off. Neither has a symptom a person
 * would notice — the app looks identical with the whole source tree
 * attached to it.
 */
describe('nothing extra ships to the browser', () => {
  it('does not turn on production source maps', () => {
    // `productionBrowserSourceMaps: true` publishes the readable source of
    // every screen, with the comments that explain where the money rules
    // live, to anyone who opens devtools on the login page.
    const src = config().replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src, 'خرائطُ المصدر تُنشر مع البناء').not.toMatch(/productionBrowserSourceMaps:\s*true/);
  });

  it('and puts no secret in a NEXT_PUBLIC_ name', () => {
    // Every NEXT_PUBLIC_ value is compiled into the bundle and is public
    // whatever it is called. Two are allowed: an address, and a yes/no.
    //
    // قديم ← جديد (PR-A, A5): ['NEXT_PUBLIC_APP_URL'] ← the same plus NEXT_PUBLIC_SHOW_RESET_LINK. It is the build-time
    // switch that brings the login page's «forgot password» link back in production (hidden there by default): its whole
    // value is `true`, nothing else is read from it, and it is named for what it shows, with none of the words that mark a
    // secret. The «no secret in the name» half is kept and now checked on every allowed name.
    const files = walk(join(process.cwd(), 'src'));
    const names = new Set<string>();
    for (const file of [...files, join(process.cwd(), 'next.config.ts')]) {
      for (const m of readFileSync(file, 'utf8').matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) names.add(m[0]);
    }
    expect([...names].sort()).toEqual(['NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_SHOW_RESET_LINK']);
    for (const name of names) expect(name, 'اسمٌ يوحي بسر').not.toMatch(/SECRET|KEY|TOKEN|PASSWORD|PASS|CREDENTIAL/);
  });
});

/** Every .ts/.tsx under a directory. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}
