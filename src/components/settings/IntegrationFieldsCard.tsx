'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { apiJson } from '@/lib/api-client';
import { useToast } from '@/components/ui/Toast';
import { useConfirm } from '@/components/ui/Confirm';
import { RiCheckLine } from '@remixicon/react';

/**
 * «القيم المطلوبة» — THE BOTS' CONNECTION SETTINGS, ENTERED HERE INSTEAD OF IN THE SERVER'S ENVIRONMENT (the media buyer's doors, PR-C; the owner's rule, 17/11).
 *
 * One card per chat app on «الربط». Each setting is a row: its name, where it comes from now — «محفوظ · آخر 4» (مع علامة الصح من مجموعة الأيقونات) (saved here, sealed), «من البيئة» (the old way, still answering as the
 * fallback), or missing — and a box to save a new value. WRITE-ONLY: the box starts empty, a saved value is never shown back, only its last four characters. «مسح» removes what is saved here
 * so the environment answers again (asked first in the app's own dialog, because it can stop a bot). «جرّب» asks the app who the bot is with what is configured NOW and says «يشتغل» or why not — never a token.
 * The server decides who may (`whatsapp.manage` / `telegram.connect`, per setting); this card draws only what the key opens.
 */
type Group = 'whatsapp' | 'telegram';

interface Item {
  key: string;
  group: Group;
  label: string;
  help: string;
  source: 'site' | 'env' | 'none';
  hint: string | null;
  envSet: boolean;
  unreadable: boolean;
}

export function IntegrationFieldsCard({ group }: { group: Group }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [items, setItems] = useState<Item[] | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await apiJson<{ items: Item[] }>('/api/settings/integrations')).items);
    } catch {
      setItems(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mine = (items ?? []).filter((i) => i.group === group);
  if (mine.length === 0) return null;

  const save = async (key: string) => {
    setBusy(key);
    try {
      await apiJson('/api/settings/integrations', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: draft[key] ?? '' }),
      });
      setDraft((d) => ({ ...d, [key]: '' }));
      toast.done('انحفظ');
      await load();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الحفظ');
    } finally {
      setBusy(null);
    }
  };

  const clear = async (i: Item) => {
    // It can stop a bot, so it asks in the app's own dialog first.
    const ok = await confirm({
      title: `مسح «${i.label}»؟`,
      body: i.envSet ? 'بيرجع النظام يستعمل القيمة اللي بمتغيرات البيئة على الخادم.' : 'ما في قيمة تانية بالبيئة: الاتصال بيوقف لحد ما تدخل قيمة جديدة.',
      confirmLabel: 'مسح',
      tone: 'danger',
    });
    if (!ok) return;
    const key = i.key;
    setBusy(key);
    try {
      await apiJson('/api/settings/integrations', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
      toast.done('انمسح');
      await load();
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر المسح');
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy('test');
    setVerdict(null);
    try {
      const out = await apiJson<{ ok: boolean; message: string }>('/api/settings/integrations/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group }),
      });
      setVerdict(out.message);
    } catch (e) {
      setVerdict(e instanceof Error ? e.message : 'تعذرت التجربة');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader title="القيم المطلوبة" subtitle="بتنحفظ مشفّرة وما بتنعرض بعد الحفظ؛ البيئة على الخادم بتضل احتياط" />
      <CardContent className="space-y-1">
        {mine.map((i) => (
          <div key={i.key} className="py-2.5 border-b border-[var(--sys-surface-strong)] space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-[var(--sys-heading)]">{i.label}</span>
              <span className="flex items-center gap-1 text-xs text-[var(--sys-muted-foreground)]">
                {i.source === 'site' ? (
                  <>
                    <RiCheckLine className="w-4 h-4" />
                    <span>محفوظ · آخر 4: </span>
                    <span dir="ltr">{i.hint ?? ''}</span>
                  </>
                ) : i.source === 'env' ? (
                  'من البيئة'
                ) : (
                  'ناقص'
                )}
              </span>
            </div>
            <p className="text-xs text-[var(--sys-muted-foreground)]">{i.help}</p>
            {i.unreadable && (
              <p className="text-xs text-[var(--sys-destructive)]">القيمة المحفوظة ما بتنفتح (مفتاح التشفير اتغيّر) — احفظها من جديد.</p>
            )}
            <div className="flex items-center gap-2">
              <Input
                type="password"
                dir="ltr"
                autoComplete="off"
                aria-label={i.label}
                placeholder="قيمة جديدة"
                value={draft[i.key] ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, [i.key]: e.target.value }))}
              />
              <Button size="sm" disabled={busy !== null || !(draft[i.key] ?? '').trim()} onClick={() => save(i.key)}>
                حفظ
              </Button>
              {i.hint !== null && (
                <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => clear(i)}>
                  مسح
                </Button>
              )}
            </div>
          </div>
        ))}
        <div className="flex items-center justify-between pt-3">
          <span className="text-xs text-[var(--sys-muted-foreground)]">{verdict ?? 'جرّب بالقيم الحالية'}</span>
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={test}>
            {busy === 'test' ? 'جارٍ التجربة...' : 'جرّب'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
