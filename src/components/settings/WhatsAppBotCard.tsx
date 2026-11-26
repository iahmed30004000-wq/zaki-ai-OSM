'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { RiAddLine, RiCheckboxCircleLine, RiCloseCircleLine, RiDeleteBinLine, RiSparkling2Line } from '@remixicon/react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { screenApi as crmApi } from '@/lib/screen-api';
import type { WaBotAgent } from '@/components/whatsapp/chat-model';

/** The practice chat is its own chunk: fetched the first time «جرّبه» is pressed. */
const WhatsAppBotSandbox = React.lazy(() => import('./WhatsAppBotSandbox'));

interface ProductNote {
  productId: string;
  notes: string;
}

interface BotSettingsView {
  enabled: boolean;
  name: string;
  avatarText: string;
  persona: string;
  productNotes: ProductNote[];
  baseUrl: string;
  model: string | null;
  keySet: boolean;
  keyHint: string | null;
  keyUnreadable: boolean;
  active: boolean;
}

const PERSONA_MAX = 4000;

/**
 * «بوت الطلبات على واتساب» — the owner's card: the switch, the name and the letter on its picture, the personality and the
 * store's words (like Sarah's «الشخصية ومعلومات المتجر»), short facts per product, the model's connection with
 * «اختبر الاتصال», and «جرّبه» — the same bot against a made-up customer, nothing sent and nothing changed.
 *
 * Whoever answers WhatsApp may read it; only `whatsapp.manage` changes it. The key is typed once and never shown again —
 * only its last four characters.
 */
export function WhatsAppBotCard({ embedded = false, onSaved }: { embedded?: boolean; onSaved?: (agent: WaBotAgent) => void }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<BotSettingsView | null>(null);
  const [products, setProducts] = useState<Array<{ id: string; name: string }>>([]);
  const [canManage, setCanManage] = useState(false);

  const [name, setName] = useState('');
  const [avatarText, setAvatarText] = useState('');
  const [persona, setPersona] = useState('');
  const [notes, setNotes] = useState<ProductNote[]>([]);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [trying, setTrying] = useState(false);

  const take = useCallback(
    (s: BotSettingsView) => {
      setSaved(s);
      setName(s.name);
      setAvatarText(s.avatarText);
      setPersona(s.persona);
      setNotes(s.productNotes);
      setBaseUrl(s.baseUrl);
      setModel(s.model ?? '');
      setApiKey('');
      onSaved?.({ active: s.active, name: s.name, avatarText: s.avatarText });
    },
    [onSaved]
  );

  useEffect(() => {
    let alive = true;
    crmApi('/api/whatsapp/bot')
      .then((d: any) => {
        if (!alive) return;
        setProducts(d.products || []);
        setCanManage(Boolean(d.canManage));
        take(d.settings);
      })
      .catch((e: any) => alive && setError(e.message || 'تعذّر تحميل إعدادات البوت'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const put = async (body: Record<string, unknown>) => {
    const d: any = await crmApi('/api/whatsapp/bot', { method: 'PUT', body: JSON.stringify(body) });
    take(d.settings);
    return d.settings as BotSettingsView;
  };

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await put({
        name,
        avatarText,
        persona,
        productNotes: notes.filter((n) => n.productId && n.notes.trim()),
        baseUrl,
        model,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setMessage({ ok: true, text: 'انحفظت إعدادات البوت' });
    } catch (e: any) {
      setMessage({ ok: false, text: e.message || 'تعذّر الحفظ' });
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const d: any = await crmApi('/api/whatsapp/bot/test', {
        method: 'POST',
        body: JSON.stringify({ baseUrl, model, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }),
      });
      setTest(d.ok ? { ok: true, text: `الاتصال شغّال — الموديل ${d.model}، ردّ خلال ${(d.ms / 1000).toFixed(1)} ثانية: «${d.reply}»` } : { ok: false, text: d.error || 'ما قدرنا نوصل للموديل' });
    } catch (e: any) {
      setTest({ ok: false, text: e.message || 'ما قدرنا نوصل للموديل' });
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-note text-[var(--sys-muted-foreground)]">جارٍ التحميل...</CardContent>
      </Card>
    );
  }
  if (error || !saved) {
    return (
      <Card>
        <CardContent className="py-6 text-note text-[var(--sys-destructive)]">{error || 'تعذّر تحميل إعدادات البوت'}</CardContent>
      </Card>
    );
  }

  const locked = !canManage || busy;
  const keyNote = saved.keyUnreadable
    ? 'المفتاح المحفوظ ما عاد ينقرأ (تغيّر مفتاح التشفير) — أدخله من جديد.'
    : saved.keySet
      ? `في مفتاح محفوظ ينتهي بـ ${saved.keyHint ?? '••••'} — اتركه فاضي لتضل عليه، أو اكتب مفتاح جديد.`
      : 'ما في مفتاح محفوظ — بلا مفتاح البوت ما بيرد.';

  return (
    <Card plain={embedded}>
      <CardHeader
        title="بوت الطلبات على واتساب"
        subtitle="بيرد على الزبون اللي بيكتب أول: بيلاقي طلبه من رقمه، بيأكده بعد «إي» واضحة، وبيعدّل الاسم والعنوان والمدينة والملاحظات والعرض وهو جديد. ما بيلغي، ولا بيغيّر سعر، ولا بيعمل طلب جديد. أول ما يرد موظف بالمحادثة بيسكت."
      />
      <CardContent className="space-y-5">
        <Switch
          checked={saved.enabled}
          disabled={!canManage}
          label="البوت شغّال"
          hint={saved.enabled && !saved.active ? 'مفعّل بس بلا مفتاح يشتغل — أضف المفتاح.' : 'بيرد بس جوّا نافذة الـ24 ساعة وبمحادثة مفتوحة ما وقّفه فيها حدا.'}
          onChange={async (next) => {
            await put({ enabled: next });
          }}
        />

        <p className="text-note text-[var(--sys-muted-foreground)]">
          رسائل الزبون واسمه ورقمه وعنوانه وطلباته بتروح للموديل المضبوط تحت بس (نفس موديل سارة) — قرار المالك لهالبوت وحده.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="اسم البوت" value={name} maxLength={30} disabled={locked} onChange={(e) => setName(e.target.value)} helperText="بيظهر فوق رسائله بصندوق الواتساب." />
          <Input label="الحرف على صورته" value={avatarText} maxLength={2} disabled={locked} onChange={(e) => setAvatarText(e.target.value)} helperText="حرف أو حرفين — فاضي = أول حرف من الاسم." />
        </div>

        <Textarea
          label="الشخصية ومعلومات المتجر"
          rows={8}
          value={persona}
          maxLength={PERSONA_MAX}
          disabled={locked}
          onChange={(e) => setPersona(e.target.value)}
          helperText={`اكتب كيف بيحكي البوت وشو لازم يعرف عن متجرك (التوصيل، الضمان، الإرجاع…). القواعد الثابتة دايمًا بتغلب. ${persona.length}/${PERSONA_MAX}`}
        />

        <div className="space-y-3">
          <p className="text-sm font-semibold text-[var(--sys-heading)]">معلومات سريعة عن المنتجات</p>
          <p className="text-note text-[var(--sys-muted-foreground)]">بيقولها البوت للزبون إذا سأل عن منتج بطلبه. الأسعار والعروض دايمًا من النظام، مش من هون.</p>
          {notes.map((n, i) => (
            <div key={i} className="flex flex-wrap items-start gap-2">
              <div className="w-full">
              <Select
                label="المنتج"
                value={n.productId}
                disabled={locked}
                options={[{ value: '', label: 'اختر المنتج' }, ...products.map((p) => ({ value: p.id, label: p.name }))]}
                onChange={(e) => setNotes(notes.map((x, j) => (j === i ? { ...x, productId: e.target.value } : x)))}
              />
              </div>
              <div className="flex-1 min-w-0">
              <Textarea
                label="المعلومات"
                rows={2}
                value={n.notes}
                maxLength={1500}
                disabled={locked}
                onChange={(e) => setNotes(notes.map((x, j) => (j === i ? { ...x, notes: e.target.value } : x)))}
              />
              </div>
              {canManage && (
                <IconButton label="احذف معلومات المنتج" onClick={() => setNotes(notes.filter((_, j) => j !== i))} disabled={busy}>
                  <RiDeleteBinLine className="w-4 h-4" />
                </IconButton>
              )}
            </div>
          ))}
          {canManage && (
            <Button variant="secondary" size="sm" onClick={() => setNotes([...notes, { productId: '', notes: '' }])} disabled={busy || notes.length >= 50}>
              <RiAddLine className="w-4 h-4" /> أضف معلومات منتج
            </Button>
          )}
        </div>

        <div className="space-y-3">
          <p className="text-sm font-semibold text-[var(--sys-heading)]">الموديل</p>
          <Input label="عنوان الخادم (متوافق مع OpenAI)" dir="ltr" value={baseUrl} disabled={locked} onChange={(e) => setBaseUrl(e.target.value)} helperText="بيبدأ بـ https — الافتراضي نفس خادم سارة." />
          <Input label="اسم الموديل (اختياري)" dir="ltr" value={model} disabled={locked} onChange={(e) => setModel(e.target.value)} helperText="فاضي = أول موديل بيذكره الخادم." />
          {canManage && (
            <Input
              label="مفتاح الموديل"
              dir="ltr"
              type="password"
              autoComplete="off"
              value={apiKey}
              disabled={busy}
              placeholder={saved.keySet && saved.keyHint ? `••••${saved.keyHint}` : ''}
              onChange={(e) => setApiKey(e.target.value)}
              helperText={keyNote}
            />
          )}
          {!canManage && <p className="text-note text-[var(--sys-muted-foreground)]">{saved.keySet ? `المفتاح محفوظ (ينتهي بـ ${saved.keyHint ?? '••••'}).` : 'ما في مفتاح محفوظ.'}</p>}
          {canManage && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => { void runTest(); }} loading={testing}>
                <RiCheckboxCircleLine className="w-4 h-4" /> اختبر الاتصال
              </Button>
              {saved.keySet && (
                <Button
                  variant="quiet"
                  size="sm"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await put({ clearKey: true });
                      setMessage({ ok: true, text: 'انمسح المفتاح — البوت ما بيرد لحتى تحط مفتاح.' });
                    } catch (e: any) {
                      setMessage({ ok: false, text: e.message || 'تعذّر المسح' });
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  امسح المفتاح
                </Button>
              )}
            </div>
          )}
          {test && (
            <p role="status" className={`text-note flex items-start gap-1.5 ${test.ok ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'}`}>
              {test.ok ? <RiCheckboxCircleLine className="w-4 h-4 shrink-0" /> : <RiCloseCircleLine className="w-4 h-4 shrink-0" />}
              <span className="min-w-0 break-words">{test.text}</span>
            </p>
          )}
        </div>

        {message && (
          <p role="status" className={`text-note ${message.ok ? 'text-[var(--sys-success)]' : 'text-[var(--sys-destructive)]'}`}>
            {message.text}
          </p>
        )}

        {canManage ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={() => { void save(); }} loading={busy}>
              احفظ
            </Button>
            <Button type="button" variant="secondary" onClick={() => setTrying((t) => !t)} disabled={!saved.keySet}>
              <RiSparkling2Line className="w-4 h-4" /> {trying ? 'سكّر التجربة' : 'جرّبه'}
            </Button>
            {!saved.keySet && <span className="text-note text-[var(--sys-muted)]">احفظ المفتاح أول، بعدين جرّبه.</span>}
          </div>
        ) : (
          <p className="text-note text-[var(--sys-muted)]">بيغيّره بس صاحب صلاحية «إدارة واتساب».</p>
        )}

        {trying && canManage && (
          <React.Suspense fallback={<p className="text-note text-[var(--sys-muted-foreground)]">جارٍ التحميل...</p>}>
            <WhatsAppBotSandbox botName={saved.name} avatarText={saved.avatarText} products={products} />
          </React.Suspense>
        )}
      </CardContent>
    </Card>
  );
}

export default WhatsAppBotCard;
