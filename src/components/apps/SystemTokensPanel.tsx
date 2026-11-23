'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { apiFetch, apiJson } from '@/lib/api-client';
import { useConfirm } from '@/components/ui/Confirm';
import { arDateTime } from '@/lib/format';
import {
  RiAddLine,
  RiAlertLine,
  RiFileCopyLine,
  RiKey2Line,
  RiShieldCheckLine,
  RiStopCircleLine,
} from '@remixicon/react';

/**
 * «توكنات الأنظمة» — the keys another system calls `/api/v1` with.
 *
 * It lives inside «التطبيقات المثبتة» and not on a screen of its own,
 * because that is where the question is already being asked: this panel
 * answers «ما هو موصول بشركتك» for the systems that call US, beside the
 * list of the ones we call.
 *
 * ── THE KEY IS SHOWN ONCE, AND THE SCREEN SAYS SO BEFORE IT IS MADE ──
 *
 * Only the SHA-256 is stored, so there is nothing to show a second time —
 * `GET` cannot return it and neither can anything else. A person who closes
 * this box without copying has to stop the key and make another, and being
 * told that afterwards is being told too late. So the warning is above the
 * button, not after it.
 */

interface TokenRow {
  id: string;
  name: string;
  system: string;
  prefix: string;
  scopes: string[];
  rateLimitPerMin: number;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  /** The one country this key sees; null for every country of the company (2026-11-21). */
  country?: CountryChoice | null;
  /** The one store this key sees; null for every store of its country (2026-11-23). */
  store?: { id: string; name: string } | null;
  state: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
}

interface StoreChoice {
  id: string;
  name: string;
  countryId: string;
}

interface CountryChoice {
  id: string;
  code: string;
  name: string;
}

interface SystemChoice {
  key: string;
  ar: string;
  scopes: string[];
  rateLimitPerMin: number;
}

interface Shelf {
  /** `mintable` false: this person lacks the key it stands for (`needsAr`). */
  scopeCatalog: { key: string; ar: string; mintable?: boolean; needsAr?: string }[];
  /** False when the person does not reach every store: a key reads them all. */
  mayMint?: boolean;
  repliesScopes: string[];
  systems: SystemChoice[];
  defaultDays: number;
  /** The company's active countries — «البلد» offers each, after «كل البلدان». */
  countries?: CountryChoice[];
  /** The company's real stores with their country — «المتجر» offers those of the country chosen. */
  stores?: StoreChoice[];
  tokens: TokenRow[];
}

/** What «البلد» says for a key bound to no country. */
export const ALL_COUNTRIES_AR = 'كل البلدان';

/** «البلد: …» on a key's row. */
export function countryLabel(country: CountryChoice | null | undefined): string {
  return `البلد: ${country ? country.name : ALL_COUNTRIES_AR}`;
}

/** What «المتجر» says for a key bound to no store. */
export const ALL_STORES_AR = 'كل متاجر البلد';

/** «المتجر: …» on a key's row — only for a key bound to one store. */
export function storeLabel(store: { name: string } | null | undefined): string {
  return store ? `المتجر: ${store.name}` : '';
}

const STATE_AR: Record<TokenRow['state'], string> = {
  ACTIVE: 'شغّال',
  EXPIRED: 'منتهي',
  REVOKED: 'موقوف',
};

export function SystemTokensPanel() {
  const confirm = useConfirm();
  const [shelf, setShelf] = useState<Shelf | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('نظام الردود');
  const [system, setSystem] = useState('replies');
  const [chosen, setChosen] = useState<string[]>([]);
  /** '' = every country (the default, and what every key made before was). */
  const [countryId, setCountryId] = useState('');
  /** '' = every store of the country (the default, and what every key made before was). */
  const [storeId, setStoreId] = useState('');
  /** The one and only moment this value exists outside a header. */
  const [issued, setIssued] = useState<{ secret: string; notice: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await apiJson<Shelf>('/api/settings/system-tokens');
      setShelf(s);
      // The replies system's five scopes are the default selection: that is
      // what this door was built for, and a person who wants fewer unticks
      // them rather than hunting for the right five.
      // Only what this person may put on a key: a pre-ticked scope they lack
      // would be refused at «أنشئ», after the work of naming the key.
      setChosen((already) => (already.length ? already : s.repliesScopes.filter((k) => mintableIn(s, k))));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر تحميل المفاتيح');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = useCallback(async () => {
    setError(null);
    try {
      const made = await apiJson<{ secret: string; notice: string }>('/api/settings/system-tokens', {
        method: 'POST',
        body: JSON.stringify({ name, system, scopes: chosen, ...(countryId ? { countryId } : {}), ...(countryId && storeId ? { storeId } : {}) }),
      });
      setIssued({ secret: made.secret, notice: made.notice });
      setCopied(false);
      setAdding(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر إنشاء المفتاح');
    }
  }, [name, system, chosen, countryId, storeId, load]);

  /** Picking the system resets the name and the scopes to that system's own — least privilege as the default. */
  const pickSystem = useCallback((s: SystemChoice) => {
    setSystem(s.key);
    setName(s.ar);
    setChosen(s.scopes.filter((k) => !shelf || mintableIn(shelf, k)));
  }, [shelf]);

  const revoke = useCallback(
    async (id: string, name: string) => {
      // Stopping a key is not undone: the door sets `revokedAt` and nothing sets it back, so the system holding it is cut off at
      // once and needs a new key. A system that has stopped calling in is a bad way to learn that.
      const ok = await confirm({
        title: `إيقاف المفتاح «${name}»؟`,
        body: 'أيّ نظام يستعمله يتوقّف عن الاتصال فوراً. الإيقاف لا يُلغى: تحتاج مفتاحاً جديداً.',
        tone: 'danger',
      });
      if (!ok) return;
      setError(null);
      try {
        const res = await apiFetch('/api/settings/system-tokens', {
          method: 'DELETE',
          body: JSON.stringify({ id }),
        });
        if (!res.ok) throw new Error('تعذر إيقاف المفتاح');
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'تعذر إيقاف المفتاح');
      }
    },
    [load, confirm]
  );

  const copy = useCallback(async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.secret);
      setCopied(true);
    } catch {
      // A browser that refuses the clipboard is not a failure worth a
      // banner: the key is on the screen and can be selected by hand.
      setCopied(false);
    }
  }, [issued]);

  if (!shelf) return null;

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-note font-bold text-[var(--sys-muted-foreground)]">
          <RiKey2Line className="h-4 w-4" /> توكنات الأنظمة
        </h2>
        <Button size="sm" variant="secondary" onClick={() => setAdding(!adding)}>
          <RiAddLine className="h-4 w-4" /> مفتاح جديد
        </Button>
      </div>

      <p className="mb-2 text-note text-[var(--sys-muted-foreground)]">
        مفتاح واحد لكل نظام خارجي يرسل لنا طلبات على <span dir="ltr" className="font-mono">/api/v1</span>.
        المفتاح يُعرض مرة واحدة عند إنشائه ولا يمكن استرجاعه بعدها.
      </p>

      {error && (
        <p className="mb-2 rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-3 text-sm text-[var(--sys-destructive)]">
          {error}
        </p>
      )}

      {issued && (
        <div className="mb-2 rounded-lg border border-[var(--sys-warning)] bg-[var(--sys-warning-soft)] p-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-note font-bold text-[var(--sys-warning)]">
            <RiAlertLine className="h-4 w-4" /> {issued.notice}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code
              className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-[var(--sys-card)] p-2 font-mono text-xs text-[var(--sys-foreground)]"
              dir="ltr"
            >
              {issued.secret}
            </code>
            <Button size="sm" variant="secondary" onClick={copy}>
              <RiFileCopyLine className="h-4 w-4" /> {copied ? 'نُسخ' : 'انسخ'}
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setIssued(null)}>
              أخفِه
            </Button>
          </div>
        </div>
      )}

      {adding && (
        <Card padding="sm" className="mb-2 space-y-2">
          <fieldset>
            <legend className="mb-1 text-note font-semibold text-[var(--sys-muted-foreground)]">المفتاح لأي نظام؟</legend>
            <div className="flex flex-wrap gap-2">
              {shelf.systems.map((s) => (
                <label
                  key={s.key}
                  className={`inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm md:min-h-0 ${
                    system === s.key
                      ? 'border-[var(--sys-primary)] bg-[var(--sys-primary-soft)] font-bold text-[var(--sys-heading)]'
                      : 'border-[var(--sys-border)]'
                  }`}
                >
                  <input
                    type="radio"
                    name="systemTokenSystem"
                    value={s.key}
                    checked={system === s.key}
                    onChange={() => pickSystem(s)}
                  />
                  {s.ar}
                  <span className="text-note font-normal text-[var(--sys-muted-foreground)]">
                    · {s.scopes.length} صلاحيات
                  </span>
                </label>
              ))}
            </div>
            {system === 'mediabuyer' && (
              <p className="mt-1 text-note text-[var(--sys-muted-foreground)]">
                قراءة فقط: مصدر الطلبات وحالتها والمنتجات وتكلفتها — بلا اسم ولا هاتف ولا عنوان زبون، وما بيقدر ينشئ طلب.
              </p>
            )}
          </fieldset>
          <fieldset>
            <legend className="mb-1 text-note font-semibold text-[var(--sys-muted-foreground)]">البلد</legend>
            <div className="flex flex-wrap gap-2">
              {[{ id: '', code: '', name: ALL_COUNTRIES_AR }, ...(shelf.countries ?? [])].map((c) => (
                <label
                  key={c.id || 'all'}
                  className={`inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm md:min-h-0 ${
                    countryId === c.id
                      ? 'border-[var(--sys-primary)] bg-[var(--sys-primary-soft)] font-bold text-[var(--sys-heading)]'
                      : 'border-[var(--sys-border)]'
                  }`}
                >
                  <input
                    type="radio"
                    name="systemTokenCountry"
                    value={c.id}
                    checked={countryId === c.id}
                    onChange={() => {
                      setCountryId(c.id);
                      setStoreId('');
                    }}
                  />
                  {c.name}
                </label>
              ))}
            </div>
            {countryId && (
              <p className="mt-1 text-note text-[var(--sys-muted-foreground)]">
                صفحات الهبوط بهذا المفتاح تشوف وتكتب منتجات وطلبات وسلات ومحادثات هذا البلد فقط. باقي الأنظمة ترفض مفتاح البلد الواحد.
              </p>
            )}
          </fieldset>
          {countryId && (shelf.stores ?? []).some((st) => st.countryId === countryId) && (
            <fieldset>
              <legend className="mb-1 text-note font-semibold text-[var(--sys-muted-foreground)]">المتجر</legend>
              <div className="flex flex-wrap gap-2">
                {[{ id: '', name: ALL_STORES_AR, countryId }, ...(shelf.stores ?? []).filter((st) => st.countryId === countryId)].map((st) => (
                  <label
                    key={st.id || 'all'}
                    className={`inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm md:min-h-0 ${
                      storeId === st.id
                        ? 'border-[var(--sys-primary)] bg-[var(--sys-primary-soft)] font-bold text-[var(--sys-heading)]'
                        : 'border-[var(--sys-border)]'
                    }`}
                  >
                    <input
                      type="radio"
                      name="systemTokenStore"
                      value={st.id}
                      checked={storeId === st.id}
                      onChange={() => setStoreId(st.id)}
                    />
                    {st.name}
                  </label>
                ))}
              </div>
              {storeId && (
                <p className="mt-1 text-note text-[var(--sys-muted-foreground)]">
                  صفحات الهبوط بهذا المفتاح تشوف وتكتب منتجات وطلبات وسلات ومحادثات هذا المتجر فقط.
                </p>
              )}
            </fieldset>
          )}
          <Input
            label="اسم المفتاح"
            name="systemTokenName"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div>
            <p className="mb-1 text-note font-semibold text-[var(--sys-muted-foreground)]">الصلاحيات</p>
            <div className="flex flex-wrap gap-x-4">
              {shelf.scopeCatalog.map((s) => (
                <span
                  key={s.key}
                  // A scope this person lacks the key for is shown, and says why, rather than failing later.
                  title={s.mintable === false ? `يحتاج «${s.needsAr}» بنطاق كامل` : undefined}
                >
                  <Checkbox
                    id={`scope-${s.key}`}
                    name={`scope-${s.key}`}
                    label={s.ar}
                    disabled={s.mintable === false}
                    checked={chosen.includes(s.key)}
                    onChange={(on) =>
                      setChosen((was) =>
                        on ? [...was, s.key] : was.filter((k) => k !== s.key)
                      )
                    }
                  />
                </span>
              ))}
            </div>
          </div>
          {shelf.scopeCatalog.some((s) => s.mintable === false) && (
            <p className="text-note text-[var(--sys-muted)]">
              مش متاح لك:{' '}
              {shelf.scopeCatalog
                .filter((s) => s.mintable === false)
                .map((s) => `${s.ar} (يحتاج «${s.needsAr}»)`)
                .join('، ')}
            </p>
          )}
          {shelf.mayMint === false && (
            <p className="text-note text-[var(--sys-warning)]">
              المفتاح بيقرا الشركة كلها، فإصداره بدّه دخول كل الدول والمتاجر.
            </p>
          )}
          <p className="text-note text-[var(--sys-muted)]">
            ينتهي بعد {shelf.defaultDays} يوماً، وبحدّ{' '}
            {shelf.systems.find((s) => s.key === system)?.rateLimitPerMin ?? 60} طلباً في الدقيقة.
          </p>
          <Button size="sm" onClick={create} disabled={chosen.length === 0 || shelf.mayMint === false}>
            أنشئ المفتاح
          </Button>
        </Card>
      )}

      {shelf.tokens.length === 0 ? (
        <Card padding="lg" className="text-center text-note text-[var(--sys-muted-foreground)]">
          <p>لا مفاتيح بعد — أنشئ واحداً والصقه في إعدادات النظام الخارجي.</p>
        </Card>
      ) : (
        <Card plain>
        <ul className="divide-y divide-[var(--sys-border)]">
          {shelf.tokens.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
              {t.state === 'ACTIVE' ? (
                <RiShieldCheckLine className="h-4 w-4 shrink-0 text-[var(--sys-success)]" />
              ) : (
                <RiStopCircleLine className="h-4 w-4 shrink-0 text-[var(--sys-muted-foreground)]" />
              )}
              <span className="text-sm font-bold text-[var(--sys-heading)]">{t.name}</span>
              <span className="font-mono text-xs text-[var(--sys-muted-foreground)]" dir="ltr">
                {t.prefix}…
              </span>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                  t.state === 'ACTIVE'
                    ? 'bg-[var(--sys-success-soft)] text-[var(--sys-success)]'
                    : 'bg-[var(--sys-surface-strong)] text-[var(--sys-muted-foreground)]'
                }`}
              >
                {STATE_AR[t.state]}
              </span>
              <span className="text-note text-[var(--sys-muted)]">{countryLabel(t.country)}</span>
              {t.store && <span className="text-note text-[var(--sys-muted)]">{storeLabel(t.store)}</span>}
              <span className="text-note text-[var(--sys-muted)]">
                {t.lastUsedAt ? `آخر استخدام ${arDateTime(t.lastUsedAt)}` : 'لم يُستخدم بعد'}
              </span>
              <span className="text-note text-[var(--sys-muted)]">
                {t.expiresAt ? `ينتهي ${arDateTime(t.expiresAt)}` : 'بلا انتهاء'}
              </span>
              <span className="flex flex-wrap gap-1">
                {t.scopes.map((s) => (
                  <span
                    key={s}
                    className="rounded-full bg-[var(--sys-surface-strong)] px-2 py-0.5 font-mono text-xs text-[var(--sys-foreground)]"
                    dir="ltr"
                  >
                    {s}
                  </span>
                ))}
              </span>
              {t.state === 'ACTIVE' && (
                <span className="ms-auto">
                  <Button size="sm" variant="danger" onClick={() => revoke(t.id, t.name)}>
                    <RiStopCircleLine className="h-4 w-4" /> أوقفه
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
        </Card>
      )}
    </section>
  );
}

/** May this person put this scope on a key (the door says, per scope). */
function mintableIn(shelf: Shelf, key: string): boolean {
  return shelf.scopeCatalog.find((s) => s.key === key)?.mintable !== false;
}
