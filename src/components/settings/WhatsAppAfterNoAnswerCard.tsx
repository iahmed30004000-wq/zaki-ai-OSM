'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/Card';
import { Input, Select } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { apiJson } from '@/lib/api-client';
import { useToast } from '@/components/ui/Toast';
import { useCan } from '@/hooks/useCan';

/**
 * «واتساب بعد لا يرد» — FROM WHOSE WHATSAPP, PER COUNTRY (`after-no-answer.ts`).
 *
 * One row per country the company works in: from the agent's own WhatsApp (the default, what has always happened) or from
 * the company's number as an approved Meta template. Saved by whoever holds `settings.manage` — the server asks it again.
 *
 * COMPANY can be saved before the number is connected (the owner sets it up, then connects), and the card says plainly that
 * until then every message still goes from the agent's WhatsApp.
 */
type Route = 'AGENT' | 'COMPANY';
type Params = 'none' | 'name' | 'name_order';
interface Setting {
  byDialCode: Record<string, Route>;
  templateName: string;
  templateLang: string;
  templateParams: Params;
}
interface View {
  setting: Setting;
  countries: Array<{ dialCode: string; name: string }>;
  connected: boolean;
}

const ROUTES: Array<{ value: Route; label: string }> = [
  { value: 'AGENT', label: 'من واتساب الموظفة' },
  { value: 'COMPANY', label: 'من رقم الشركة' },
];

const PARAMS: Array<{ value: Params; label: string }> = [
  { value: 'none', label: 'القالب بلا فراغات' },
  { value: 'name', label: 'اسم الزبون' },
  { value: 'name_order', label: 'اسم الزبون ثم رقم الطلب' },
];

export function WhatsAppAfterNoAnswerCard() {
  const toast = useToast();
  const canManage = useCan('settings.manage');
  const [view, setView] = useState<View | null>(null);
  const [draft, setDraft] = useState<Setting | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await apiJson<View>('/api/settings/whatsapp-after-no-answer');
      setView(d);
      setDraft(d.setting);
    } catch {
      setView(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!view || !draft) return null;

  const routeOf = (dialCode: string): Route => (draft.byDialCode[dialCode] === 'COMPANY' ? 'COMPANY' : 'AGENT');
  const anyCompany = view.countries.some((c) => routeOf(c.dialCode) === 'COMPANY');

  const save = async () => {
    setBusy(true);
    try {
      const d = await apiJson<{ setting: Setting }>('/api/settings/whatsapp-after-no-answer', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      setDraft(d.setting);
      setView({ ...view, setting: d.setting });
      toast.done('انحفظ');
    } catch (e) {
      toast.failed(e instanceof Error ? e.message : 'تعذر الحفظ');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="واتساب بعد «لا يرد»"
        subtitle="لكل دولة: الموظفة بتبعت من واتسابها برسالة جاهزة، أو بينبعت قالب معتمد من ميتا من رقم الشركة."
      />
      <CardContent className="space-y-4">
        {!view.connected && (
          <p role="status" className="text-xs text-[var(--sys-warning)]">
            رقم الشركة مش موصول لهلأ — لحد ما ينوصل، كل رسالة بتطلع من واتساب الموظفة حتى لو اخترت «من رقم الشركة».
          </p>
        )}
        <p className="text-xs text-[var(--sys-muted-foreground)]">
          ميتا ما بتوصّل رسائل الشركات لأرقام سوريا — خلّي سوريا على واتساب الموظفة لحد ما توصل رسالة تجربة.
        </p>
        <p className="text-xs text-[var(--sys-muted-foreground)]">
          زر «ابعت من رقم الشركة» بيظهر بس للي معه صلاحية «إرسال رسائل واتساب» — الباقيين بيضلّوا يبعتوا من واتسابهم.
        </p>

        {view.countries.length === 0 ? (
          <p className="text-xs text-[var(--sys-muted)]">ما في دول مسجّلة للشركة.</p>
        ) : (
          <div className="space-y-3">
            {view.countries.map((c) => (
              <fieldset key={c.dialCode} className="space-y-1">
                <legend className="text-sm font-semibold text-[var(--sys-heading)]">
                  {c.name} <span dir="ltr">+{c.dialCode}</span>
                </legend>
                <div className="flex flex-wrap gap-4">
                  {ROUTES.map((r) => (
                    <label key={r.value} className="flex items-center gap-1 text-xs text-[var(--sys-muted-foreground)]">
                      <input
                        type="radio"
                        name={`wa-route-${c.dialCode}`}
                        value={r.value}
                        checked={routeOf(c.dialCode) === r.value}
                        disabled={!canManage || busy}
                        onChange={() => setDraft({ ...draft, byDialCode: { ...draft.byDialCode, [c.dialCode]: r.value } })}
                        className="h-5 w-5 accent-[var(--sys-primary)]"
                      />
                      {r.label}
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
        )}

        <Input
          label="اسم القالب بميتا"
          dir="ltr"
          value={draft.templateName}
          disabled={!canManage || busy}
          helperText="متل ما هو مكتوب بميتا بالزبط — أحرف صغيرة وأرقام و«_»."
          onChange={(e) => setDraft({ ...draft, templateName: e.target.value })}
        />
        <Input
          label="لغة القالب"
          dir="ltr"
          value={draft.templateLang}
          disabled={!canManage || busy}
          helperText="رمز اللغة متل ما هو بميتا للقالب نفسه."
          onChange={(e) => setDraft({ ...draft, templateLang: e.target.value })}
        />
        <Select
          label="شو بينكتب بفراغات القالب"
          value={draft.templateParams}
          disabled={!canManage || busy}
          options={PARAMS}
          onChange={(e) => setDraft({ ...draft, templateParams: e.target.value as Params })}
        />
        {anyCompany && !draft.templateName.trim() && (
          <p className="text-xs text-[var(--sys-warning)]">بلا اسم قالب ما بينبعت شي من رقم الشركة.</p>
        )}

        {canManage ? (
          <Button onClick={() => void save()} loading={busy} disabled={!canManage || busy}>
            احفظ
          </Button>
        ) : (
          <p className="text-xs text-[var(--sys-muted)]">بيغيّره بس صاحب صلاحية «إعدادات النظام الحسّاسة».</p>
        )}
      </CardContent>
    </Card>
  );
}
