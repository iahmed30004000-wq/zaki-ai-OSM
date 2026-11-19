'use client';

import React, { useCallback, useState } from 'react';
import { useTell } from '@/components/ui/Confirm';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { apiJson } from '@/lib/api-client';
import { copyText } from '@/lib/clipboard';
import { routeLabel } from '@/lib/route-registry';
import { RiAddCircleLine, RiAlertLine, RiCheckLine, RiCloseLine, RiEqualizer2Line, RiFileCopyLine, RiLoader4Line, RiShieldCheckLine } from '@remixicon/react';
import { PageShell } from '@/components/ui/PageShell';
import { useToast } from '@/components/ui/Toast';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';

/**
 * /apps/store — what this system can be connected to.
 *
 * Two shelves, honestly labelled. The built-ins are integrations this code
 * already knows how to speak to; installing one records that the company
 * uses it and sends you to the screen that configures it. The second shelf
 * is apps a developer registered: they are told what happens, and that is
 * all — being told is not being given the keys.
 */

interface BuiltIn {
  kind: 'BUILTIN';
  code: string;
  name: string;
  summary: string;
  description: string;
  categoryLabel: string;
  settingsPath: string;
  canManage: boolean;
  installed: boolean;
  enabled: boolean;
  configured: boolean;
}

interface External {
  kind: 'EXTERNAL';
  id: string;
  code: string;
  name: string;
  description: string | null;
  developerName: string | null;
  webhookUrl: string | null;
  events: string[];
  status: string;
  installed: boolean;
  enabled: boolean;
}

interface Shelf {
  builtIn: BuiltIn[];
  external: External[];
  availableEvents: { code: string; label: string }[];
}

export function AppStoreScreen() {
  const toast = useToast();
  const [shelf, setShelf] = useState<Shelf | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);

  const load = useCallback(async () => {
    try {
      setShelf(await apiJson<Shelf>('/api/apps'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذر التحميل');
    }
  }, []);

  useLiveRefresh(load);

  async function act(appCode: string, action: 'install' | 'enable' | 'disable' | 'uninstall') {
    setBusy(appCode);
    try {
      await apiJson('/api/apps/installs', { method: 'POST', body: JSON.stringify({ appCode, action }) });
      await load();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر التنفيذ');
    } finally {
      setBusy(null);
    }
  }

  if (!shelf) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-[var(--sys-muted-foreground)]">
        <RiLoader4Line className="h-4 w-4 animate-spin" /> جارٍ التحميل…
      </div>
    );
  }

  return (
    <PageShell
      title={routeLabel('/apps/store')}
      width="wide"
      description="ما يمكن وصل النظام به. الجاهزة يعرفها النظام مسبقاً ويكفي تفعيلها وإدخال
            حسابها؛ والمسجَّلة من مطوّرين تُخبَر بما يحدث عبر ويبهوك موقَّع."
      actions={
        <Button size="sm" onClick={() => setRegistering(true)}>
          <RiAddCircleLine className="h-4 w-4" /> سجّل تطبيقاً
        </Button>
      }
    >
      {error && (
        <p className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-3 text-sm text-[var(--sys-destructive)]">{error}</p>
      )}

      <section>
        <h2 className="mb-2 text-note font-bold text-[var(--sys-muted-foreground)]">تكاملات جاهزة</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {shelf.builtIn.map((a) => (
            <div
              key={a.code}
              className={`rounded-lg border p-4 ${
                a.installed && a.enabled ? 'border-[var(--sys-primary)]/40 bg-[var(--sys-primary-soft)]' : 'border-[var(--sys-border)] bg-[var(--sys-card)]'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-[var(--sys-heading)]">{a.name}</p>
                  <p className="text-note text-[var(--sys-muted-foreground)]">{a.summary}</p>
                </div>
                <span className="shrink-0 rounded-full bg-[var(--sys-surface-strong)] px-2 py-0.5 text-note font-semibold text-[var(--sys-foreground)]">
                  {a.categoryLabel}
                </span>
              </div>

              <p className="mt-2 text-sm leading-relaxed text-[var(--sys-muted-foreground)]">{a.description}</p>

              {/* Installed is not the same as working. A courier whose
                  credentials were cleared is installed and useless, and the
                  card says which. */}
              {a.installed && (
                <p className={`mt-2 flex items-center gap-1.5 text-note ${a.configured ? 'text-[var(--sys-success)]' : 'text-[var(--sys-warning)]'}`}>
                  {a.configured ? <RiShieldCheckLine className="h-4 w-4" /> : <RiAlertLine className="h-4 w-4" />}
                  {a.configured ? 'مهيَّأ ويعمل' : 'مثبَّت لكن غير مهيَّأ — أدخل بياناته'}
                </p>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                {!a.installed ? (
                  <Button size="sm" disabled={!a.canManage || busy === a.code} onClick={() => { void act(a.code, 'install'); }}>
                    {busy === a.code ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : <RiAddCircleLine className="h-4 w-4" />}
                    تثبيت
                  </Button>
                ) : (
                  <>
                    <Link href={a.settingsPath}>
                      <Button size="sm" variant="secondary">
                        <RiEqualizer2Line className="h-4 w-4" /> الإعدادات
                      </Button>
                    </Link>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!a.canManage || busy === a.code}
                      onClick={() => { void act(a.code, a.enabled ? 'disable' : 'enable'); }}
                    >
                      {a.enabled ? 'إيقاف' : 'تفعيل'}
                    </Button>
                    <Button
                      variant="quiet"
                      size="sm"
                      onClick={() => { void act(a.code, 'uninstall'); }}
                      disabled={!a.canManage || busy === a.code}
                    >
                      إزالة
                    </Button>
                  </>
                )}
                {!a.canManage && (
                  <span className="text-note text-[var(--sys-muted)]">تحتاج صلاحية لتثبيته</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-note font-bold text-[var(--sys-muted-foreground)]">
          تطبيقات مسجَّلة عندك
        </h2>
        {shelf.external.length === 0 ? (
          <Card padding="lg">
            <p className="text-center text-sm leading-relaxed text-[var(--sys-muted-foreground)]">
              لا تطبيقات مسجَّلة بعد. سجّل واحداً ليصله ويبهوك موقَّع عند كل حدث تختاره —
              طلب جديد، تأكيد، شحن، تسليم، إرجاع.
            </p>
          </Card>
        ) : (
          <div className="space-y-2">
            {shelf.external.map((a) => (
              <Card key={a.id} plain padding="md">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-[var(--sys-heading)]">
                      {a.name} <span className="font-mono text-note text-[var(--sys-muted)]" dir="ltr">{a.code}</span>
                    </p>
                    {a.developerName && <p className="text-note text-[var(--sys-muted-foreground)]">{a.developerName}</p>}
                    {a.webhookUrl && (
                      <p className="mt-1 truncate font-mono text-note text-[var(--sys-muted-foreground)]" dir="ltr">{a.webhookUrl}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {!a.installed ? (
                      <Button size="sm" disabled={busy === a.code} onClick={() => { void act(a.code, 'install'); }}>
                        تثبيت
                      </Button>
                    ) : (
                      <Button size="sm" variant="secondary" disabled={busy === a.code} onClick={() => { void act(a.code, a.enabled ? 'disable' : 'enable'); }}>
                        {a.enabled ? 'إيقاف' : 'تفعيل'}
                      </Button>
                    )}
                  </div>
                </div>
                {a.events.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {a.events.map((e) => (
                      <span key={e} className="rounded-full bg-[var(--sys-surface-strong)] px-2 py-0.5 font-mono text-note text-[var(--sys-foreground)]" dir="ltr">
                        {e}
                      </span>
                    ))}
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </section>

      {registering && (
        <RegisterApp
          events={shelf.availableEvents}
          onClose={() => setRegistering(false)}
          onDone={async () => { setRegistering(false); await load(); }}
        />
      )}
    </PageShell>
  );
}

/**
 * Registering an app.
 *
 * The signing secret is generated on the server and shown once. Offering to
 * show it again would mean storing it readable, and a secret that can be
 * read back is a secret that will be read by the wrong person.
 */
function RegisterApp({
  events, onClose, onDone,
}: {
  events: { code: string; label: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', code: '', developerName: '', webhookUrl: '', description: '' });
  const [chosen, setChosen] = useState<string[]>(['order.created']);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const tell = useTell();
  const [copied, setCopied] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await apiJson<{ secret: string }>('/api/apps', {
        method: 'POST',
        body: JSON.stringify({ ...form, events: chosen }),
      });
      setSecret(res.secret);
    } catch (err) {
      toast.failed(err instanceof Error ? err.message : 'تعذر التسجيل');
    } finally {
      setSaving(false);
    }
  }

  if (secret) {
    return (
      <Modal isOpen onClose={onDone} title="سرّ التوقيع" subtitle="يُعرض مرة واحدة فقط">
        <div className="space-y-3">
          <p className="text-sm leading-relaxed text-[var(--sys-foreground)]">
            احفظه الآن. يوقّع كل ويبهوك بترويسة <code dir="ltr">RiCloseLine-Zaki-Signature</code> بصيغة
            {' '}<code dir="ltr">sha256=HMAC(secret, &quot;&lt;timestamp&gt;.&lt;body&gt;&quot;)</code>؛
            الوقت داخل النصّ الموقَّع حتى لا يُعاد إرسال طلب مُلتقَط بعد أسبوع بنفس التوقيع.
          </p>
          <Card plain padding="sm" className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all font-mono text-note text-[var(--sys-heading)]" dir="ltr">{secret}</code>
            <IconButton
              label="انسخ السرّ"
              type="button"
              className="shrink-0"
              onClick={async () => {
                // Shown once and never again, so a copy that silently
                // fails loses the secret for good.
                if (await copyText(secret)) setCopied(true);
                else void tell({
                  title: 'انسخ السرّ يدوياً',
                  body: 'المتصفح لم يسمح بالنسخ التلقائي، وهذا السرّ لن يُعرض مرة أخرى.',
                  value: secret,
                });
              }}
            >
              {copied ? <RiCheckLine className="h-4 w-4 text-[var(--sys-success)]" /> : <RiFileCopyLine className="h-4 w-4" />}
            </IconButton>
          </Card>
          <div className="flex justify-end">
            <Button size="sm" onClick={onDone}>حفظته</Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal isOpen onClose={onClose} title="تسجيل تطبيق" subtitle="يُخبَر بما يحدث عبر ويبهوك موقَّع">
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input label="اسم التطبيق *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          <Input
            label="الرمز *"
            dir="ltr"
            placeholder="MY_APP"
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
            required
          />
          <Input label="المطوّر" value={form.developerName} onChange={(e) => setForm({ ...form, developerName: e.target.value })} />
          <Input
            label="عنوان الويبهوك *"
            dir="ltr"
            placeholder="https://example.com/hooks/zaki"
            value={form.webhookUrl}
            onChange={(e) => setForm({ ...form, webhookUrl: e.target.value })}
            required
          />
        </div>

        <Input label="وصف" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />

        <div>
          <label className="mb-1.5 block text-note font-medium text-[var(--sys-heading)]">الأحداث *</label>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {events.map((ev) => (
              <Checkbox
                key={ev.code}
                id={`app-event-${ev.code}`}
                className="rounded-lg border border-[var(--sys-border)] px-2.5"
                checked={chosen.includes(ev.code)}
                onChange={(checked) =>
                  setChosen(checked ? [...chosen, ev.code] : chosen.filter((c) => c !== ev.code))
                }
                label={
                  <>
                    {ev.label}{' '}
                    <span className="font-mono text-note text-[var(--sys-muted)]" dir="ltr">{ev.code}</span>
                  </>
                }
              />
            ))}
          </div>
        </div>

        <p className="rounded-lg bg-[var(--sys-surface)] p-2.5 text-sm leading-relaxed text-[var(--sys-muted-foreground)]">
          التطبيق يُخبَر فقط — لا يقرأ بياناتك ولا يعدّلها. عنوان الويبهوك يجب أن يكون
          <code dir="ltr"> https</code>، والإرسال يُعاد خمس مرات بتباعد متزايد قبل أن يُعلَّم فاشلاً.
        </p>

        {error && <p className="text-sm text-[var(--sys-destructive)]">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>
            <RiCloseLine className="h-4 w-4" /> إلغاء
          </Button>
          <Button type="submit" loading={saving} disabled={chosen.length === 0}>
            <RiAddCircleLine className="h-4 w-4" /> سجّل
          </Button>
        </div>
      </form>
    </Modal>
  );
}
