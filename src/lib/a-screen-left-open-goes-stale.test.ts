import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A SCREEN THAT IS LEFT OPEN STOPS BEING TRUE.
 *
 * The owner, 20/10: «الصفحات ما بتتحدث غير لما اعمل ريفرش».
 *
 * Measured: sixty-one screens, and **fifty-four fetched once on mount and
 * never again**. Three had an answer — the dashboard, the orders list and
 * the WhatsApp inbox — and those three were three copies of the same
 * twelve lines, which is the other half of the same problem.
 *
 * What a seller actually does is open a screen and work in another tab.
 * Nobody refreshes a page they never left. So an agent confirms an order
 * a colleague cancelled an hour ago, and a supervisor reads this
 * morning's figure as today's.
 *
 * ── WHAT THIS HOLDS ──
 *
 * Not «every screen must poll» — a settings form has nothing to poll for.
 * The rule is: **a screen that fetches must say how it stays true.**
 * Either it uses `useLiveRefresh`, or its name is on the list below with
 * the reason it does not need to. A new screen gets neither by accident.
 * ═══════════════════════════════════════════════════════════════════════
 */

const SCREENS = join(process.cwd(), 'src', 'components', 'screens');

/**
 * Screens that fetch and deliberately do NOT refresh on return.
 *
 * Each one is here because re-reading would be WRONG, not because nobody
 * got to it. A form the person is typing into must not have the server's
 * copy land on top of their words, and a screen that is given its data by
 * its parent has nothing of its own to ask for.
 */
const EXEMPT: Record<string, string> = {
  // Loads once into a form the person then edits — a refresh on return
  // would overwrite what they have typed but not yet saved.
  'ProfileScreen.tsx': 'يحمّل مرّةً داخل نموذجٍ يُحرَّر — والتحديثُ يمسحُ ما كُتِب ولم يُحفَظ',
  // A dialog over «طلبات تلجرام»: read when it opens and after each change it makes, and closed when the person goes back.
  'TelegramAliasesDialog.tsx': 'نافذة بتنقرأ لما تنفتح وبعد كل تعديل فيها، وبتتسكّر لما ترجع للشاشة — والتحديث بيمسح الفورم اللي عم ينكتب',
  'PermissionsScreen.tsx': 'شجرةُ صلاحيّاتٍ تُحرَّر قبل الحفظ — التحديثُ يُلغي التعديلَ الجاري',
  'UserDetailScreen.tsx': 'بياناتُ موظّفٍ تُحرَّر في مكانها',
  'SystemSettingsScreen.tsx': 'نموذجُ إعداداتٍ يُحرَّر قبل الحفظ',
};

function screens(): string[] {
  return readdirSync(SCREENS).filter((f) => f.endsWith('.tsx') && !f.includes('.test.'));
}

const body = (file: string) => stripComments(readFileSync(join(SCREENS, file), 'utf8'));

describe('every screen that fetches says how it stays true', () => {
  it('— by using the shared hook, or by being named with a reason', () => {
    const silent: string[] = [];
    for (const file of screens()) {
      const src = body(file);
      const fetches = /\bapiJson\(|\bapiFetch\(/.test(src);
      if (!fetches) continue;
      if (src.includes('useLiveRefresh')) continue;
      // A screen that reads its list through `usePagedList` stays true by it: the hook IS the shared refresh
      // (asserted below, so this line cannot become a loophole).
      if (src.includes('usePagedList')) continue;
      if (EXEMPT[file]) continue;
      silent.push(file);
    }
    expect(
      silent.sort(),
      'شاشاتٌ بتجيب بيانات وما بتتحدّث لمّا ترجعلها — استعمل useLiveRefresh أو ' +
        `سمّيها بـEXEMPT ومعها السبب:\n${silent.join('\n')}`
    ).toEqual([]);
  });

  it('and the paged-list hook, which screens use INSTEAD of naming the refresh, really does refresh', () => {
    const hook = stripComments(readFileSync(join(process.cwd(), 'src', 'hooks', 'usePagedList.ts'), 'utf8'));
    expect(hook).toContain('useLiveRefresh(');
    // …on the page the reader is ON — coming back must not send them to page one.
    expect(hook).toMatch(/useLiveRefresh\(\(\) => loadRef\.current\(pageRef\.current\)/);
  });

  it('and the exemption list names no screen that has since adopted it', () => {
    /*
     * The other direction. An exemption left behind after its screen was
     * fixed is a licence nobody is using, and the next person reads it as
     * «this screen is not supposed to refresh».
     */
    const stale = Object.keys(EXEMPT).filter((file) => {
      try {
        return body(file).includes('useLiveRefresh');
      } catch {
        return false; // a screen that no longer exists is caught below
      }
    });
    expect(stale, `إعفاءٌ لشاشةٍ صارت تتحدّث فعلاً:\n${stale.join('\n')}`).toEqual([]);
  });

  it('and names no screen that no longer exists', () => {
    const present = new Set(screens());
    const gone = Object.keys(EXEMPT).filter((f) => !present.has(f));
    expect(gone, `إعفاءٌ لشاشةٍ ما عادت موجودة:\n${gone.join('\n')}`).toEqual([]);
  });
});

describe('and the hook is the only copy of it', () => {
  it('— no screen listens for these events by hand any more', () => {
    /*
     * The dashboard, the orders list and the WhatsApp inbox each wrote
     * their own twelve lines, and the three disagreed: one listened for
     * `online` and the others did not, none listened for `focus`, and so
     * alt-tabbing back to the window refreshed nothing anywhere.
     *
     * Three copies of a rule is three places for it to be wrong. The hook
     * is the copy.
     */
    const offenders: string[] = [];
    for (const file of screens()) {
      const src = body(file);
      for (const event of ['visibilitychange', "'focus'", "'online'"]) {
        if (src.includes(`addEventListener(${event}`) || src.includes(`addEventListener('${event}'`)) {
          offenders.push(`${file} → ${event}`);
        }
      }
    }
    expect(
      offenders,
      `شاشةٌ بتسمعْ للأحداثِ بإيدها بدل الهوك:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('and a polling screen polls only while somebody is looking', () => {
    // A background tab that keeps asking is a phone's battery and a
    // server's load for a screen nobody is reading.
    const hook = stripComments(
      readFileSync(join(process.cwd(), 'src', 'hooks', 'useLiveRefresh.ts'), 'utf8')
    );
    const tick = hook.slice(hook.indexOf('setInterval'));
    expect(tick.slice(0, 200), 'العدّادُ بيسأل والنافذةُ مخفيّة').toContain('document.hidden');
  });

  it('and the first load is never held back by the throttle', () => {
    /*
     * The gap exists because `focus` and `visibilitychange` fire together
     * when a tab is raised. It must not apply to the first load, or a
     * screen opened seconds after another one would render empty.
     */
    const hook = stripComments(
      readFileSync(join(process.cwd(), 'src', 'hooks', 'useLiveRefresh.ts'), 'utf8')
    );
    expect(hook).toMatch(/run\(true\)/);
    expect(hook).toMatch(/if \(!force && now - lastAt\.current < MIN_GAP_MS\) return;/);
  });
});
