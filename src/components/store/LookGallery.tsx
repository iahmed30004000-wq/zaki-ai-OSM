'use client';

import { RiCheckLine, RiLoader4Line, RiMoonLine, RiSunLine } from '@remixicon/react';
import { Button } from '@/components/ui/Button';
import {
  HOME_DESIGNS, LEFT_OUT_LABEL, STORE_LOOKS, designSummary, lookSwatches, lookTokens, type LookTokens,
} from '@/lib/store-looks';
import { DESIGN_NAMES, LOOK_NAMES } from '@/lib/store-looks/names.generated';

/**
 * THE THIRTEEN THEMES AND THE EIGHTEEN HOME DESIGNS OF THE OWNER'S OTHER
 * PLATFORM — «الثيمات» and «تصاميم جاهزة للصفحة الرئيسية», as his library
 * shows them: five dots, a name, a line, light or dark.
 *
 * Trying a theme changes the theme in the seller's hands and nothing else:
 * it lands as an unsaved change, beside every other control on the screen,
 * and reaches a customer only through «احفظ المسوّدة» then «انشر». A design
 * writes the home page's DRAFT (the server does that) and proposes its
 * theme the same unsaved way — exactly how one of our skins installs.
 */
export function LookGallery({
  current,
  installing,
  onTry,
  onInstallDesign,
}: {
  /** The look the theme in hand names, if any. */
  current: string | undefined;
  installing: string | null;
  onTry: (look: LookTokens) => void;
  onInstallDesign: (id: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-bold text-[var(--sys-heading)]">الثيمات</p>
        <p className="mb-3 mt-0.5 text-xs text-[var(--sys-muted-foreground)]">
          الثيم بيغيّر الألوان والزوايا والظلال بس — منتجاتك وعروضك ونصوصك وطلباتك ما بتتغيّر. «جرّبه» بيبيّن
          التغيير هون غير محفوظ.
        </p>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {STORE_LOOKS.map((look) => {
            const on = current === look.id;
            const name = LOOK_NAMES[look.id];
            return (
              <div
                key={look.id}
                className={`rounded-lg border p-3 ${on ? 'border-[var(--sys-primary)]' : 'border-[var(--sys-border)]'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex overflow-hidden rounded-md border border-[var(--sys-border)]" aria-hidden>
                    {lookSwatches(look).map((hex, i) => (
                      <span key={i} className="h-6 w-6" style={{ background: hex }} />
                    ))}
                  </span>
                  <span className="flex items-center gap-1 text-xs text-[var(--sys-muted-foreground)]">
                    {look.mode === 'dark' ? <RiMoonLine className="h-4 w-4" /> : <RiSunLine className="h-4 w-4" />}
                    {look.mode === 'dark' ? 'غامق' : 'فاتح'}
                  </span>
                </div>
                <p className="mt-2 text-sm font-bold text-[var(--sys-heading)]">{name?.label ?? look.id}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-[var(--sys-muted-foreground)]">{name?.line}</p>
                <div className="mt-2">
                  {on ? (
                    <span className="inline-flex items-center gap-1 text-xs font-bold text-[var(--sys-primary)]">
                      <RiCheckLine className="h-4 w-4" /> مستخدم
                    </span>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => onTry(look)}>
                      جرّبه
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <p className="text-sm font-bold text-[var(--sys-heading)]">تصاميم جاهزة للصفحة الرئيسية</p>
        <p className="mb-3 mt-0.5 text-xs text-[var(--sys-muted-foreground)]">
          كل تصميم بيرتّب أقسام صفحتك الرئيسية من بلوكاتنا ويلبّسها ثيمه. ما بينقل ولا جملة ولا صورة ولا رقم — الصور
          صورك، و«الأكثر مبيعاً» من طلباتك المسلَّمة بس.
        </p>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {HOME_DESIGNS.map((design) => {
            const look = lookTokens(design.look);
            return (
              <div key={design.id} className="rounded-lg border border-[var(--sys-border)] p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-bold text-[var(--sys-heading)]">{DESIGN_NAMES[design.id] ?? design.id}</p>
                  {look && (
                    <span className="flex overflow-hidden rounded-md border border-[var(--sys-border)]" aria-hidden>
                      {lookSwatches(look).map((hex, i) => (
                        <span key={i} className="h-4 w-4" style={{ background: hex }} />
                      ))}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-[var(--sys-muted-foreground)]">
                  بثيم «{LOOK_NAMES[design.look]?.label ?? design.look}»
                </p>
                <p className="mt-2 text-xs leading-relaxed text-[var(--sys-foreground)]">
                  {designSummary(design).join(' ← ')}
                </p>
                {design.left.length > 0 && (
                  <p className="mt-2 text-xs leading-relaxed text-[var(--sys-muted)]">
                    ما بينتقل معه: {design.left.map((l) => LEFT_OUT_LABEL[l]).join(' · ')}
                  </p>
                )}
                <div className="mt-2">
                  <Button size="sm" variant="secondary" disabled={!!installing} onClick={() => onInstallDesign(design.id)}>
                    {installing === design.id && <RiLoader4Line className="h-4 w-4 animate-spin" />}
                    ثبّته كمسوّدة
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
