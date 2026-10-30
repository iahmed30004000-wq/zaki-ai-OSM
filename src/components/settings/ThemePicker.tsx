'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api-client';
import { AUTO_DARK, AUTO_LIGHT, AUTO_THEME, THEME_CHOICES, sanitizeTheme, themeByKey } from '@/lib/system-themes';
import { DECOR_LEVELS, readDecor, setDecor, type DecorLevel } from '@/lib/theme-decoration';
import { RiCheckLine, RiPaletteLine } from '@remixicon/react';

/**
 * CHOOSING HOW THE SYSTEM LOOKS.
 *
 * It applies the moment it is clicked — the attribute on the frame changes
 * and every screen follows, with no reload. Saving happens after, quietly.
 * A picker that made somebody wait for a round trip to see a colour is a
 * picker they cannot actually choose with, because choosing a theme means
 * looking at it.
 *
 * And if the save fails the choice STAYS applied for this session and says
 * so. Snapping back to the old theme while they are looking at the new one
 * would read as the click not having worked.
 *
 * Each swatch shows the real palette — the page, the card, the accent and
 * the three semantic colours — because the whole question is what the
 * screen will look like, and a named square answers a different one.
 */

/**
 * ── SWITCHING THE ATTRIBUTE STOPPED BEING ENOUGH ──
 *
 * The owner, 21/10: «الثيم بيعلق».
 *
 * It was not a hang. Nine of the eleven themes simply never arrived: you
 * pressed a swatch, the swatches went disabled for the length of a save,
 * came back — and the colours were the old ones.
 *
 * The reason is the palette split. `system.css` carries the DEFAULT and
 * «تلقائي» and nothing else, because eleven palettes in the first-load
 * stylesheet is ten kilobytes of colours nine people in ten never see.
 * Every other palette is written into the document by `SystemFrame`, as
 * one rule for the one theme the SERVER rendered.
 *
 * So setting the attribute to a theme the page carries no rule for finds
 * nothing. The frame goes on inheriting `:root`, which still holds the
 * theme it was rendered with. Only «غرفة العمليات» and «تلقائي» ever
 * changed live — and even they left the body, the card shapes, the
 * decoration and the `theme-color` meta on the old one.
 *
 * This still runs: it is instant for those two and harmless for the
 * rest. What makes the other nine arrive is the refresh below, which
 * asks the server to render the page with its new colours.
 */
function applyNow(key: string) {
  const frame = document.querySelector('[data-sys-theme]');
  if (frame) frame.setAttribute('data-sys-theme', key);
}

export function ThemePicker({ initial }: { initial: string | null | undefined }) {
  const router = useRouter();
  const [chosen, setChosen] = useState(() => sanitizeTheme(initial));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const pick = async (key: string) => {
    // Applied first, always. The save is bookkeeping.
    applyNow(key);
    setChosen(key);
    setBusy(true);
    setFailed(false);
    try {
      /*
       * `apiFetch` and not a bare `fetch`: it carries the 15-second
       * timeout every other call in the product has. Without one, a
       * request that never answers leaves every swatch disabled for
       * ever — which is the «بيعلق» the owner would have seen on a bad
       * connection, on top of the colours not arriving.
       */
      const res = await apiFetch('/api/profile/theme', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: key }),
      });
      if (!res.ok) throw new Error();
      /*
       * ── AND THIS IS WHAT MAKES THE COLOURS ARRIVE ──
       *
       * The palette for the chosen theme is written by the SERVER, into
       * the document, for the theme the person was rendered with. The row
       * has just changed, so asking for the page again is asking for the
       * new palette — the body, the card shapes, the decoration and the
       * status-bar colour with it.
       *
       * `router.refresh()` and not `location.reload()`: it re-renders the
       * server components and keeps the scroll, the open dialogs and
       * everything else the person had in hand.
       */
      router.refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section dir="rtl">
      <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-[var(--sys-foreground)]">
        <RiPaletteLine className="h-4 w-4 text-[var(--sys-primary)]" /> مظهر النظام
      </h3>
      <p className="mb-2 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
        اختيارك أنت وحدك، ويتبعك بين الأجهزة. ألوان المعاني لا تتغيّر بين المظاهر: الأحمر متأخر أو
        خسارة، والأخضر محصَّل، والكهرماني يحتاج انتباهاً — يتغيّر السطح فقط. ولا يمسّ هذا شكل متجرك
        إطلاقاً.
      </p>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {THEME_CHOICES.map((choice) => {
          const active = choice.key === chosen;
          /*
           * `تلقائي` is not a palette, it is an instruction — so its swatch
           * shows the two it can resolve to, split down the middle. A single
           * swatch would have to pick one and lie about the other.
           */
          const auto = choice.key === AUTO_THEME;
          const theme = auto ? themeByKey(AUTO_DARK) : themeByKey(choice.key);
          const other = themeByKey(AUTO_LIGHT);
          return (
            <button
              key={choice.key}
              type="button"
              disabled={busy}
              onClick={() => pick(choice.key)}
              className={`min-h-11 min-w-11 md:min-h-0 md:min-w-0 rounded-lg border p-2.5 text-right transition disabled:opacity-60 ${
                active
                  ? 'border-[var(--sys-primary)] ring-1 ring-[var(--sys-primary)]'
                  : 'border-[var(--sys-border)] hover:border-[var(--sys-border-strong)]'
              }`}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-[var(--sys-heading)]">{choice.ar}</span>
                {active && <RiCheckLine className="h-4 w-4 text-[var(--sys-primary)]" />}
              </span>

              {/* The real palette, not a name. */}
              <span
                className="mt-2 flex h-12 items-end gap-1 rounded-lg border p-1.5"
                style={{ background: theme.vars.background, borderColor: theme.vars.border }}
              >
                <span
                  className="h-full flex-1 rounded-sm border"
                  style={{ background: theme.vars.card, borderColor: theme.vars.border }}
                />
                {auto && (
                  <span
                    className="h-full flex-1 rounded-sm border"
                    style={{ background: other.vars.background, borderColor: other.vars.border }}
                  />
                )}
                {(['primary', 'destructive', 'warning', 'success'] as const).map((k) => (
                  <span key={k} className="h-3 w-3 rounded-full" style={{ background: theme.vars[k] }} />
                ))}
              </span>

              <span className="mt-1.5 block text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                {choice.note}
              </span>
            </button>
          );
        })}
      </div>

      {failed && (
        <p className="mt-2 text-xs text-[var(--sys-warning)]">
          طُبِّق المظهر هنا، لكن تعذّر حفظه — سيعود إلى السابق على جهاز آخر.
        </p>
      )}

      <DecorationLevel />
    </section>
  );
}

/**
 * HOW MUCH OF THE MOOD, AND WHERE IT IS ALLOWED TO BE.
 *
 * Eight of these themes are moods — neon, gold, parchment, a sky with no
 * moon — and a mood that is only thirty-four hexes is a recoloured
 * spreadsheet. So each one may put an ambient touch on the screen, in
 * three places and three places only: the door, an empty list, and the
 * header above the menu.
 *
 * ⚠️ The sentence under the heading says the rest out loud, because it is
 * the part somebody would otherwise have to discover: NOT behind a table,
 * a form, an order, a figure of money or a stock count. A glow under a
 * column of numbers is a glow somebody reads through, every row, all day,
 * while deciding whether to ship something.
 *
 * ── AND IT RELOADS, ON PURPOSE ──
 *
 * The CSS for this is written into the document by the server, which is
 * what keeps it out of the stylesheet everybody downloads. So the new
 * level arrives with the next HTML, and asking for that HTML is the honest
 * way to apply it. The alternative is shipping all three levels to
 * everybody for the sake of a setting changed about twice.
 *
 * This is a BROWSER's preference, not an account's: the same person on a
 * phone in the sun and at a desk at night does not want the same answer.
 * A cookie, so the server renders it on the first frame — no script, no
 * flash, and no migration.
 */
const DECOR_AR: Record<DecorLevel, { ar: string; note: string }> = {
  off: { ar: 'بلا', note: 'ألوانُ المظهر وحدها.' },
  light: { ar: 'خفيفة', note: 'لمسةٌ ساكنة — الافتراضيّة، ولا شيءَ فيها يتحرّك.' },
  full: { ar: 'كاملة', note: 'ومعها حركةٌ بطيئة — تتوقّف مع «تقليل الحركة» وعندما تُخفى النافذة.' },
};

function DecorationLevel() {
  const router = useRouter();
  const [level, setLevel] = useState<DecorLevel>('light');
  // Read after mount: the cookie is the browser's, and the server has
  // already used it to paint. Reading it in render would differ between
  // the two and React would say so.
  useEffect(() => setLevel(readDecor()), []);

  const choose = (next: DecorLevel) => {
    setLevel(next);
    setDecor(next);
    /*
     * The same refresh the palette uses, for the same reason: the
     * ambient CSS is written into the document by the server for the
     * level this browser's cookie asked for, so the new level arrives
     * with the next render.
     *
     * It was `window.location.reload()` — a full reload of a heavy
     * dashboard, throwing away the scroll and anything open, for a
     * setting somebody changes about twice. `router.refresh()` re-renders
     * the server components and keeps the rest.
     */
    router.refresh();
  };

  return (
    <div className="mt-4 border-t border-[var(--sys-border)] pt-3">
      <h4 className="mb-1 text-xs font-semibold text-[var(--sys-foreground)]">زخرفةُ المظهر</h4>
      <p className="mb-2 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
        في ثلاثةِ أماكنَ فقط: شاشةُ الدخول، والقائمةُ الفارغة، ورأسُ القائمة الجانبيّة.
        ولا تظهر أبداً وراءَ جدولٍ أو حقلٍ أو طلبٍ أو مبلغٍ أو كميّةِ مخزون — الأرقامُ لا يُقرأُ من
        خلفِها شيء.
      </p>
      <div className="flex flex-wrap gap-2">
        {DECOR_LEVELS.map((key) => {
          const active = key === level;
          return (
            <button
              key={key}
              type="button"
              onClick={() => choose(key)}
              aria-pressed={active}
              className={`min-h-11 md:min-h-0 rounded-lg border px-3 py-2 text-right ${
                active
                  ? 'border-[var(--sys-primary)] ring-1 ring-[var(--sys-primary)]'
                  : 'border-[var(--sys-border)] hover:border-[var(--sys-border-strong)]'
              }`}
            >
              <span className="block text-xs font-semibold text-[var(--sys-heading)]">{DECOR_AR[key].ar}</span>
              <span className="block text-xs text-[var(--sys-muted-foreground)]">{DECOR_AR[key].note}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
