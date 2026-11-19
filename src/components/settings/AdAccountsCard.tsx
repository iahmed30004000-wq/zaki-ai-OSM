'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { IconButton } from '@/components/ui/IconButton';
import { Segmented } from '@/components/ui/Segmented';
import { apiJson } from '@/lib/api-client';
import { Input } from '@/components/ui/Input';
import { useConfirm } from '@/components/ui/Confirm';
import { useCan } from '@/hooks/useCan';
import { RiAlertLine, RiArrowDownSLine, RiDeleteBinLine, RiExternalLinkLine, RiLoader4Line, RiLoginBoxLine, RiMegaphoneLine, RiPencilLine, RiPlugLine } from '@remixicon/react';
import { arDateTime } from '@/lib/format';
import { isMadeUpAccountId, isManualAccount } from '@/lib/ads/manual';

/**
 * CONNECTING THE PLACES THE SPEND COMES FROM.
 *
 * A campaign's revenue, orders, confirmations and deliveries are all this
 * system's own record. What an advert COST belongs to Meta, TikTok or
 * Snapchat, and until now the seller read it off their Ads Manager and
 * typed it in.
 *
 * This component names none of the three. The platforms, their fields and
 * their instructions come from the server, because only the adapter knows
 * that Snapchat needs three secrets and Meta needs one — and a form built
 * from a hardcoded list is a form that goes stale the day a fourth platform
 * is added.
 *
 * The secrets are write-only: checked against the platform before they are
 * stored, encrypted, and never returned — only the last four characters, so
 * a seller can tell which token is in there.
 *
 * TWO WAYS IN, BOTH VISIBLE WITHOUT A CLICK — «اوتوماتيك او ادخال يدوي
 * بالكامل. اريد الخيارين». Under the platform tabs there is a switch with both
 * names on it: «ربط تلقائي» (everything below, unchanged) and «إدخال يدوي
 * بالكامل», which adds the same account with NO token — a name and
 * optionally the platform's id — whose campaigns keep the spend the seller
 * types. A choice that lived behind a menu would be a choice most people
 * never learn exists. See `lib/ads/manual.ts` for what a manual account is.
 */

interface Field {
  key: string;
  label: string;
  secret: boolean;
  placeholder: string;
  hint?: string;
}

interface Platform {
  platform: string;
  label: string;
  short: string;
  fields: Field[];
  help: { url: string; urlLabel: string; steps: string[] };
  /**
   * WHETHER SIGNING IN IS POSSIBLE AT ALL — «اربط الحساب الاعلاني عن طريق
   * تسجيل الدخول بالحساب».
   *
   * OAuth needs an app registered with the platform, whose client id and
   * secret belong to the PRODUCT and live in env vars. Without them there
   * is no authorize URL, so the server says so and this draws a sentence
   * naming what an administrator must set — never a button that leads to a
   * platform error page.
   */
  oauth:
    | { available: true }
    | { available: false; envKeys: string[]; register: { url: string; note: string } };
}

interface Account {
  id: string;
  platform: string;
  accountId: string;
  accountName: string | null;
  tokenHint: string | null;
  status: string;
  lastError: string | null;
  lastSyncAt: string | null;
  _count: { campaigns: number };
}

export function AdAccountsCard({ storeName }: { storeName?: string }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [chosen, setChosen] = useState<string>('META');
  const [accountId, setAccountId] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [howOpen, setHowOpen] = useState(false);
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [manualName, setManualName] = useState('');
  const [manualId, setManualId] = useState('');
  const confirm = useConfirm();
  // Connecting, switching and removing an ad account are «الإعدادات الحسّاسة»; the list is read with «عرض الإعدادات».
  const canManage = useCan('settings.manage');

  const active = useMemo(
    () => platforms.find((p) => p.platform === chosen) ?? platforms[0] ?? null,
    [platforms, chosen]
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/ad-accounts');
      const json = await res.json();
      setAccounts(json.accounts ?? []);
      setPlatforms(json.platforms ?? []);
    } catch {
      setAccounts([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** Switching platform clears the fields: one platform's secret is not another's. */
  function pick(p: string) {
    setChosen(p);
    setValues({});
    setAccountId('');
    setManualId('');
    setMsg(null);
  }

  const ready =
    !!active &&
    accountId.trim().length >= 5 &&
    active.fields.every((f) => (values[f.key] ?? '').trim().length > 0);

  async function connect() {
    if (!active) return;
    setBusy(true);
    setMsg(null);
    try {
      const credentials: Record<string, string> = {};
      for (const f of active.fields) credentials[f.key] = (values[f.key] ?? '').trim();

      const res = await fetch('/api/settings/ad-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: active.platform, accountId: accountId.trim(), credentials }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'تعذر الربط');
      // Cleared immediately: a secret left in a field is a secret on a
      // screen somebody else can walk past.
      setValues({});
      setAccountId('');
      await load();
      setMsg({
        ok: true,
        text: json.warning || `تم ربط «${json.account.accountName}» — العملة ${json.currency}.`,
      });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذر الربط' });
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(a: Account) {
    const manual = isManualAccount(a);
    const ok = await confirm({
      title: `${manual ? 'حذف' : 'فصل'} «${a.accountName ?? a.accountId}»؟`,
      body: a._count.campaigns
        ? manual
          ? `${a._count.campaigns} حملة ستبقى بلا حساب، وإنفاقها بيدك كما كان.`
          : `${a._count.campaigns} حملة ستعود إلى إدخال الإنفاق يدوياً. الأرقام المسحوبة تبقى كما هي — هي مصروف حقيقي.`
        : 'ستُحذف البيانات المحفوظة.',
      confirmLabel: manual ? 'احذف' : 'افصل',
      cancelLabel: 'إلغاء',
      tone: 'danger',
    });
    if (!ok) return;
    const res = await fetch(`/api/settings/ad-accounts/${a.id}`, { method: 'DELETE' });
    const json = await res.json().catch(() => ({}));
    await load();
    if (json.message) setMsg({ ok: true, text: json.message });
  }

  /** «إدخال يدوي بالكامل»: the account with no token. */
  async function addManual() {
    if (!active) return;
    setBusy(true);
    setMsg(null);
    try {
      // `apiJson`, not a bare fetch: it throws the server's own sentence on a
      // refusal (a duplicate, a bad id) and sends an expired session to sign in.
      const json = await apiJson<{ account: { accountName: string } }>('/api/settings/ad-accounts/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: active.platform,
          accountName: manualName.trim(),
          accountId: manualId.trim() || undefined,
        }),
      });
      setManualName('');
      setManualId('');
      await load();
      setMsg({ ok: true, text: `أُضيف «${json.account.accountName}» كحساب يدوي — أنشئ حملاتك وانسبها إليه من شاشة الحملات.` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذر الحفظ' });
    } finally {
      setBusy(false);
    }
  }

  /** A connected account becomes manual: the token is deleted, the campaigns stay. */
  async function switchToManual(a: Account) {
    const ok = await confirm({
      title: `تحويل «${a.accountName ?? a.accountId}» إلى يدوي؟`,
      body: `سيُحذف الرمز المحفوظ ولن يُسحب الإنفاق بعد الآن. ${
        a._count.campaigns ? `${a._count.campaigns} حملة تبقى في الحساب وإنفاقها بيدك، و` : ''
      }الأرقام المسحوبة تبقى كما هي — هي مصروف حقيقي.`,
      confirmLabel: 'حوّله إلى يدوي',
      cancelLabel: 'إلغاء',
    });
    if (!ok) return;
    try {
      const json = await apiJson<{ message?: string }>(`/api/settings/ad-accounts/${a.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'MANUAL' }),
      });
      await load();
      setMsg({ ok: true, text: json.message || 'تم.' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'تعذر التحويل' });
    }
  }

  const labelOf = (p: string) => platforms.find((x) => x.platform === p)?.short ?? p;

  return (
    <Card padding="md">
    <div dir="rtl">
      <div className="mb-1 flex items-center gap-2">
        <RiMegaphoneLine className="h-4 w-4 text-[var(--sys-primary)]" />
        <h2 className="text-sm font-bold text-[var(--sys-heading)]">حسابات الإعلانات</h2>
        {storeName && (
          <span className="rounded-lg bg-[var(--sys-surface-strong)] px-1.5 py-0.5 text-note font-semibold text-[var(--sys-foreground)]">
            متجر {storeName}
          </span>
        )}
      </div>
      <p className="mb-3 text-note leading-relaxed text-[var(--sys-muted-foreground)]">
        اربط حساباتك الإعلانية ليأتي الإنفاق تلقائياً بدل أن تكتبه — أو أضفها يدوياً بالكامل وسجّل
        الإنفاق بيدك في شاشة الحملات. كل شيء آخر هناك محسوب من طلباتك أصلاً. الحساب يتبع المتجر
        المختار من الأعلى — بدّل المتجر لتضيف حساب متجر آخر.
      </p>

      {accounts === null ? (
        <div className="flex h-16 items-center justify-center text-[var(--sys-muted-foreground)]">
          <RiLoader4Line className="h-4 w-4 animate-spin" />
        </div>
      ) : accounts.length > 0 ? (
        <div className="mb-3 space-y-2">
          {accounts.map((a) => (
            <div key={a.id} className="rounded-lg border border-[var(--sys-border)] p-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-1.5 text-note font-semibold text-[var(--sys-heading)]">
                    {a.accountName ?? a.accountId}
                    <span className="rounded-lg bg-[var(--sys-surface-strong)] px-1.5 py-0.5 text-note font-semibold text-[var(--sys-foreground)]">
                      {labelOf(a.platform)}
                    </span>
                    <span
                      className={`rounded-lg px-1.5 py-0.5 text-note font-semibold ${
                        isManualAccount(a)
                          ? 'bg-[var(--sys-surface-strong)] text-[var(--sys-foreground)]'
                          : a.status === 'CONNECTED' ? 'bg-[var(--sys-success-soft)] text-[var(--sys-success)]' : 'bg-[var(--sys-destructive-soft)] text-[var(--sys-destructive)]'
                      }`}
                    >
                      {isManualAccount(a) ? 'يدوي' : a.status === 'CONNECTED' ? 'متصل' : 'يحتاج انتباهاً'}
                    </span>
                  </p>
                  {/* A manual account has no token to show the end of, and
                      may have no platform id either — say that, rather than
                      print an id this system made up as if Meta had issued it. */}
                  {isManualAccount(a) ? (
                    <p className="mt-0.5 text-note text-[var(--sys-muted)]" dir={isMadeUpAccountId(a.accountId) ? 'rtl' : 'ltr'}>
                      {isMadeUpAccountId(a.accountId) ? 'بلا رقم من المنصة' : a.accountId}
                    </p>
                  ) : (
                    <p className="mt-0.5 font-mono text-note text-[var(--sys-muted)]" dir="ltr">
                      {a.accountId} · ••••{a.tokenHint ?? ''}
                    </p>
                  )}
                  <p className="mt-0.5 text-note text-[var(--sys-muted-foreground)]">
                    {isManualAccount(a) ? `${a._count.campaigns} حملة في هذا الحساب` : `${a._count.campaigns} حملة مربوطة`}
                    {a.lastSyncAt && ` · آخر سحب ${arDateTime(a.lastSyncAt)}`}
                  </p>
                </div>
                {canManage && (
                <div className="flex shrink-0 items-center">
                  {/* The other way across: a connected account can be made manual
                      without losing its campaigns — the token goes, they stay. */}
                  {!isManualAccount(a) && (
                    <IconButton type="button" size="sm" label="حوّله إلى يدوي" onClick={() => void switchToManual(a)}>
                      <RiPencilLine className="h-4 w-4" />
                    </IconButton>
                  )}
                  <IconButton type="button" size="sm" label={isManualAccount(a) ? 'احذف' : 'فصل'} onClick={() => void disconnect(a)}>
                    <RiDeleteBinLine className="h-4 w-4" />
                  </IconButton>
                </div>
                )}
              </div>

              {/* The platform's own words, not a summary of them. A seller who
                  reads "token has expired" can fix it; one who reads "sync
                  failed" cannot. */}
              {a.status !== 'CONNECTED' && a.lastError && (
                <p className="mt-1.5 flex items-start gap-1 rounded-lg bg-[var(--sys-destructive-soft)] p-1.5 text-note leading-relaxed text-[var(--sys-destructive)]">
                  <RiAlertLine className="mt-px h-4 w-4 shrink-0" />
                  {a.lastError}
                </p>
              )}
            </div>
          ))}
        </div>
      ) : null}

      {active && !canManage && <p className="text-note text-[var(--sys-muted)]">قراءة فقط — التعديل لمن عنده «الإعدادات الحسّاسة».</p>}
      {active && canManage && (
        <div className="space-y-2 rounded-lg bg-[var(--sys-surface)] p-3">
          {/* Tabs rather than a dropdown: three platforms fit, and a seller
              should see that TikTok is possible without opening anything. */}
          {platforms.length > 1 && (
            // 18/11 (R15e): the kit's `Segmented`, over the same variable — the chosen one is `active.platform`, and a press calls `pick`.
            // `Segmented` stays silent when the chosen platform is pressed again; the hand-drawn tabs called `pick` then too, which
            // empties what was typed — so that press is caught here and does the same.
            <div
              onClickCapture={(e) => {
                const choice = (e.target as HTMLElement).closest('[role="radio"]');
                if (choice?.getAttribute('aria-checked') === 'true') pick(active.platform);
              }}
            >
              <Segmented
                size="sm"
                aria-label="المنصّة"
                className="w-full"
                options={platforms.map((p) => ({ value: p.platform, label: p.short }))}
                value={active.platform}
                onChange={pick}
              />
            </div>
          )}

          {/*
            THE CHOICE, WITH BOTH NAMES ON IT.

            Same segmented look as the platform tabs above it, so it reads as
            «now pick how», and never collapsed: «اوتوماتيك او ادخال يدوي
            بالكامل. اريد الخيارين» is two things the owner wants to SEE.
          */}
          <Segmented
            size="sm"
            aria-label="طريقة إضافة الحساب"
            className="w-full"
            options={[
              { value: 'auto', label: 'ربط تلقائي' },
              { value: 'manual', label: 'إدخال يدوي بالكامل' },
            ]}
            value={mode}
            onChange={(m) => {
              setMode(m as 'auto' | 'manual');
              setMsg(null);
            }}
          />

          {mode === 'auto' && (
          <>
          {/*
            SIGNING IN, OR THE REASON IT IS NOT OFFERED.

            Above the paste-a-token form and never instead of it: the form
            keeps working, and a shop whose platform has no app registered
            is not left without a way to connect. The two are the same act
            with different amounts of reading.
          */}
          {active.oauth.available ? (
            <a
              href={`/api/settings/ad-accounts/oauth/${active.platform}/start`}
              className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-[var(--sys-primary)] px-4 text-sm font-semibold text-[var(--sys-primary-foreground)]"
            >
              <RiLoginBoxLine className="icon-mirror h-4 w-4 shrink-0" aria-hidden />
              سجّل الدخول بحساب {active.short}
            </a>
          ) : (
            <Card plain className="p-2.5">
              <p className="text-note font-semibold text-[var(--sys-foreground)]">
                الربط بتسجيل الدخول غير مهيّأ بعد
              </p>
              <p className="mt-1 text-note leading-relaxed text-[var(--sys-muted-foreground)]">
                يحتاج تطبيقاً مسجَّلاً عند {active.short}، ومتغيّرَي بيئة على الخادم:{' '}
                <span dir="ltr" className="font-mono">{active.oauth.envKeys.join('، ')}</span>.
                {' '}
                {active.oauth.register.note}
              </p>
              <a
                href={active.oauth.register.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-flex min-h-11 items-center text-note font-semibold text-[var(--sys-primary)] hover:underline md:min-h-0"
              >
                مكان التسجيل
              </a>
              <p className="mt-1 text-note text-[var(--sys-muted-foreground)]">
                وحتى ذلك الحين، الصق الرمز بالأسفل — يعمل تماماً.
              </p>
            </Card>
          )}

          <div>
            <label className="mb-1 block text-note font-semibold text-[var(--sys-foreground)]">رقم الحساب الإعلاني</label>
            <Input
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              placeholder={ACCOUNT_PLACEHOLDER[active.platform] ?? ''}
              dir="ltr"
            />
          </div>

          {active.fields.map((f) => (
            <div key={f.key}>
              <label className="mb-1 block text-note font-semibold text-[var(--sys-foreground)]">{f.label}</label>
              {/* The shared field, so a secret one gets the eye. A token
                  pasted blind is a token the owner cannot check before it
                  is encrypted and never shown again. */}
              <Input
                type={f.secret ? 'password' : 'text'}
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                placeholder={f.placeholder}
                dir="ltr"
                autoComplete="off"
              />
              {f.hint && <p className="mt-1 text-note leading-relaxed text-[var(--sys-muted)]">{f.hint}</p>}
            </div>
          ))}

          <p className="text-note leading-relaxed text-[var(--sys-muted)]">
            تُشفَّر قبل الحفظ ولا تُعرَض بعدها أبداً، ولا تُكتب في سجل التدقيق. نتحقق منها مع{' '}
            {active.short} قبل الحفظ — بيانات تُحفظ بلا تجربة هي بيانات تفشل ليلاً بلا أن ينتبه أحد.
          </p>

          <Button type="button" size="sm" onClick={() => { void connect(); }} disabled={busy || !ready}>
            {busy ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiPlugLine className="h-4 w-4" />}
            اربط الحساب
          </Button>
          </>
          )}

          {mode === 'manual' && (
            <div className="space-y-2">
              <Card plain className="p-2.5">
                <p className="text-note leading-relaxed text-[var(--sys-muted-foreground)]">
                  حساب يدوي: لا ربط ولا رمز ولا سحب. تكتب حملاتك وإنفاقها بيدك في شاشة «الحملات» وتنسبها
                  لهذا الحساب. وإن أردته تلقائياً لاحقاً فاربطه من «ربط تلقائي» بنفس رقمه.
                </p>
              </Card>
              <div>
                <label className="mb-1 block text-note font-semibold text-[var(--sys-foreground)]">اسم الحساب</label>
                <Input
                  value={manualName}
                  onChange={(e) => setManualName(e.target.value)}
                  placeholder={`مثلاً: حساب ${active.short} الرئيسي`}
                  autoComplete="off"
                />
              </div>
              <div>
                <label className="mb-1 block text-note font-semibold text-[var(--sys-foreground)]">رقم الحساب الإعلاني (اختياري)</label>
                <Input
                  value={manualId}
                  onChange={(e) => setManualId(e.target.value)}
                  placeholder={ACCOUNT_PLACEHOLDER[active.platform] ?? ''}
                  dir="ltr"
                />
                <p className="mt-1 text-note leading-relaxed text-[var(--sys-muted)]">
                  إن كان عندك رقمه فاكتبه ليُربط لاحقاً بنفسه؛ وإلا اتركه فارغاً.
                </p>
              </div>
              <Button type="button" size="sm" onClick={() => { void addManual(); }} disabled={busy || manualName.trim().length < 2}>
                {busy ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiPencilLine className="h-4 w-4" />}
                احفظ الحساب اليدوي
              </Button>
            </div>
          )}

          {msg && (
            <p className={`text-note font-medium ${msg.ok ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'}`}>{msg.text}</p>
          )}
        </div>
      )}

      {/* The instructions are the feature. "Paste your access token" helps
          somebody who already knows how. They come from the adapter, so each
          platform's steps are its own. */}
      {active && mode === 'auto' && (
        <>
          <Button
            type="button"
            variant="quiet"
            size="sm"
            aria-expanded={howOpen}
            onClick={() => setHowOpen((v) => !v)}
            className="mt-2 font-semibold"
          >
            <RiArrowDownSLine className={`h-4 w-4 transition ${howOpen ? 'rotate-180' : ''}`} />
            من أين أحصل على بيانات {active.short}؟
          </Button>

          {howOpen && (
            <ol className="mt-2 space-y-2 rounded-lg bg-[var(--sys-surface)] p-3 text-note leading-relaxed text-[var(--sys-foreground)]">
              <li>
                افتح{' '}
                <a
                  href={active.help.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 text-[var(--sys-muted-foreground)] hover:underline"
                >
                  {active.help.urlLabel} <RiExternalLinkLine className="icon-mirror h-4 w-4" />
                </a>
              </li>
              {active.help.steps.map((s, i) => (
                <li key={i} className="flex gap-1.5">
                  <b className="shrink-0">{ARABIC_INDEX[i] ?? `${i + 1}.`}</b>
                  <span>{s}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
    </Card>
  );
}

const ARABIC_INDEX = ['1.', '2.', '3.', '4.', '5.'];

/** Shape of the id, which is the one thing that is not a credential. */
const ACCOUNT_PLACEHOLDER: Record<string, string> = {
  META: 'act_1234567890',
  TIKTOK: '7012345678901234567',
  SNAPCHAT: '00000000-0000-0000-0000-000000000000',
};

