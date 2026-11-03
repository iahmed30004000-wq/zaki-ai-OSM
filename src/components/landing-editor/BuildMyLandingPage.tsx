'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { screenApi as crmApi } from '@/lib/screen-api';
import { BUILD_QUESTIONS, SOURCE_LABEL, type BuildAnswers, type BuildSource } from '@/lib/landing-build';
import type { Tone } from '@/lib/landing-copy-brief';
import { worldColorsFrom, worldIsDark, type WorldColors } from '@/lib/landing-world-colors';
import {
  RiAlertLine,
  RiCheckboxCircleLine,
  RiImageLine,
  RiInformationLine,
  RiMagicLine,
  RiPaletteLine,
} from '@remixicon/react';

/**
 * «ابنيلي صفحة الهبوط» — THE ONE PRESS, AND WHAT IT HANDS BACK.
 *
 * The shape is the owner's, and he was specific about it twice:
 *
 *   · S1 §١١ — «شكل أبيض نظيف وأرقام جنب الصورة، بس بأسئلة. ولا رفع صورة
 *     وجه.» So this is five numbered QUESTIONS beside the product's own
 *     photograph on plain paper — not a settings sheet, and there is no
 *     file input anywhere in this file.
 *   · S3 §٥ — «النتيجة contentDraft لا أكتر: شاشة فيها الصورة وجنبها كلّ
 *     حقل بينعدّل، ومعاينة للصفحة. ولا إشي بينشر لحاله.» So every field
 *     that comes back is an input the owner can type over, every «اقتراح»
 *     waits for a tick, and this component NEVER saves: it hands the
 *     proposal up to the dialog, and the owner's own «إنشاء» is what makes
 *     a page — unpublished, like every new page.
 *
 * ── AND THE COLOURS ARE COMPUTED HERE, IN THE BROWSER THAT IS ALREADY
 *    SHOWING THE PHOTOGRAPH ──
 *
 * «الألوان بالكود، مش بالموديل.» `landing-world-colors.ts` holds the
 * arithmetic — the background from the edges, the accent from the picture,
 * the ink corrected to AA — and the only thing this file adds is the canvas
 * that turns an <img> into pixels. No upload, no server round trip, no new
 * dependency, and nothing a model said about colour is even read.
 */

interface Pick {
  structure: string;
  structureName: string;
  structureWhy: string;
  family: string;
  familyName: string;
  familyWhy: string;
}

interface BuiltField {
  key: string;
  label: string;
  value: string;
  source: BuildSource;
}

interface BuiltPromise {
  text: string;
  source: BuildSource;
  enters: boolean;
  refused?: string;
}

interface Notice {
  key: string;
  label: string;
  written: string;
  read: string;
}

export interface BuiltProposal {
  structure: string;
  family: string;
  /** The derived accent, or '' when the owner turned the palette off. */
  accent: string;
  /** Field key → the text as the owner left it. */
  fields: Record<string, string>;
  /** Only the promises that may enter the page. */
  promises: string[];
}

interface Props {
  productId: string;
  /** For the empty state's sentence, so it names the product. */
  productName?: string;
  onApply: (proposal: BuiltProposal) => void;
  /** The wizard's «الأسلوب», sent with the build when one was chosen. */
  tone?: Tone;
}

/** How a field's provenance is shown. «اقتراح» is the one that waits. */
const SOURCE_TONE: Record<BuildSource, 'success' | 'info' | 'warning'> = {
  product: 'success',
  package: 'info',
  suggestion: 'warning',
};

export function BuildMyLandingPage({ productId, productName, onApply, tone }: Props) {
  const [answers, setAnswers] = useState<BuildAnswers>({});
  const [picks, setPicks] = useState<Pick[] | null>(null);
  const [chosen, setChosen] = useState(0);
  const [matchNote, setMatchNote] = useState<string | null>(null);
  const [countedNote, setCountedNote] = useState<string | null>(null);
  const [countedWhy, setCountedWhy] = useState<string | null>(null);

  const [fields, setFields] = useState<BuiltField[] | null>(null);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [promises, setPromises] = useState<BuiltPromise[]>([]);
  /** The suggestions the owner ticked. Nothing enters without this. */
  const [approved, setApproved] = useState<Record<string, boolean>>({});
  const [notices, setNotices] = useState<Notice[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [imageWhy, setImageWhy] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [routeLine, setRouteLine] = useState<string | null>(null);
  const [colors, setColors] = useState<WorldColors | null>(null);
  const [useColors, setUseColors] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * THE PIXELS, FROM THE PICTURE THE SCREEN IS ALREADY SHOWING.
   *
   * 64×64 is enough: the derivation buckets colours to a 32-step cube, so a
   * bigger sample changes the answer by nothing and costs the main thread
   * real milliseconds on a phone. A canvas that refuses to hand over its
   * data (a cross-origin picture) leaves the palette empty rather than
   * throwing — the owner keeps every other half of the proposal.
   */
  const sample = useCallback((url: string) => {
    const img = new Image();
    img.onload = () => {
      try {
        const size = 64;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, size, size);
        const pixels = ctx.getImageData(0, 0, size, size);
        setColors(worldColorsFrom({ width: size, height: size, data: pixels.data }));
      } catch {
        setColors(null);
      }
    };
    img.src = url;
  }, []);

  useEffect(() => {
    if (imageUrl) sample(imageUrl);
  }, [imageUrl, sample]);

  /**
   * ONE PRESS, TWO PROPOSALS — and the second is allowed to fail alone.
   *
   * The matcher (structure + family + why) and the builder (the fields off
   * the box) are two different calls because they answer two different
   * questions, and because a model that chose the structure and wrote the
   * page in one answer leaves nobody a choice to change. If the box read
   * fails — no photograph, a text model, an unreadable answer — the
   * structure half still stands and the screen says what went missing.
   */
  const build = async () => {
    setError(null);
    let match: {
      picks?: Pick[];
      note?: string;
      countedNote?: string;
      countedWhy?: string;
    };
    try {
      match = await crmApi('/api/ai/landing-match', {
        method: 'POST',
        body: JSON.stringify({ productId }),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر الاقتراح');
      throw e;
    }
    setPicks(match.picks ?? []);
    setChosen(0);
    setMatchNote(match.note ?? null);
    setCountedNote(match.countedNote ?? null);
    setCountedWhy(match.countedWhy ?? null);

    try {
      const built = await crmApi('/api/ai/landing-build', {
        method: 'POST',
        body: JSON.stringify({ productId, answers, ...(tone ? { tone } : {}) }),
      });
      setFields(built.fields ?? []);
      setEdited(
        Object.fromEntries(((built.fields ?? []) as BuiltField[]).map((f) => [f.key, f.value]))
      );
      setPromises(built.promises ?? []);
      setApproved({});
      setNotices(built.notices ?? []);
      setNotes(built.notes ?? []);
      setImageWhy(built.imageWhy ?? null);
      setImageUrl(built.imageUrl ?? null);
      setRouteLine(
        built.route ? `${built.route.provider} · ${built.route.model}` : null
      );
    } catch (e) {
      // The structure half survives; this half says why it did not.
      setFields([]);
      setNotes([e instanceof Error ? e.message : 'تعذّرت قراءة العلبة']);
    }
  };

  const pick = picks && picks.length > 0 ? picks[Math.min(chosen, picks.length - 1)] : null;

  const apply = () => {
    if (!pick) return;
    const entering = promises
      .filter((p) => !p.refused && (p.enters || approved[p.text]))
      .map((p) => p.text);
    onApply({
      structure: pick.structure,
      family: pick.family,
      accent: useColors && colors ? colors.accent : '',
      fields: edited,
      promises: entering,
    });
  };

  return (
    <div className="rounded-lg border border-[var(--sys-border)] bg-[var(--sys-card)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold text-[var(--sys-heading)]">
            <RiMagicLine className="me-1 inline h-4 w-4" /> ابنيلي صفحة الهبوط
          </h3>
          <p className="mt-0.5 text-xs text-[var(--sys-muted-foreground)]">
            من صفحة المنتج وصورتها — مسوّدة تراجعها، ولا شيء ينشر وحده.
          </p>
        </div>
        <Button type="button" onClick={build} disabled={!productId}>
          <RiMagicLine className="h-4 w-4" /> ابنيلي صفحة الهبوط
        </Button>
      </div>

      {/*
        THE QUESTIONS — NUMBERED, BESIDE THE PICTURE.
        Western digits, as everywhere in this product; the number is the
        order of the work, which is the only reason it is shown at all.
      */}
      {/*
        FLEX AND EXISTING STEPS, NOT AN ARBITRARY TRACK AND A ONE-OFF HEIGHT.
        This screen first laid the picture and the questions out with an
        arbitrary two-column track (59 bytes of new CSS) and an 8rem square
        (39 bytes) — and 98 bytes is EXACTLY what pushed the first-load
        stylesheet past the «Payload budget» ratchet, measured by diffing
        the built sheet against main's. The layout here is the same one;
        every class in it is a step the sheet already carries.

        ⚠️ AND THE OLD NAMES ARE NOT WRITTEN ANYWHERE ABOVE, DELIBERATELY.
        Tailwind scans source files as TEXT: naming the two classes in this
        very comment kept both rules in the sheet after the markup had
        stopped using them, and the byte count did not move. A comment is
        not inert here — it is an input to the compiler.
      */}
      <div className="mt-3 flex flex-col gap-3 sm:flex-row">
        <div className="flex items-start justify-center">
          {imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a sample for the palette, not page furniture
            <img
              src={imageUrl}
              alt={productName ? `صورة ${productName}` : 'صورة المنتج'}
              className="h-20 w-20 rounded-lg border border-[var(--sys-border)] object-cover"
            />
          ) : (
            <div className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-[var(--sys-border)] text-center">
              <RiImageLine className="h-5 w-5 text-[var(--sys-muted)]" />
              <span className="px-1 text-xs text-[var(--sys-muted-foreground)]">ما في صورة</span>
            </div>
          )}
        </div>
        <div className="grid gap-2">
          {BUILD_QUESTIONS.map((q, i) => (
            <div key={q.key} className="flex items-start gap-2">
              <span className="mt-2 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--sys-border)] text-xs font-bold text-[var(--sys-muted-foreground)]">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <Input
                  label={q.label}
                  helperText={q.hint}
                  value={answers[q.key] ?? ''}
                  onChange={(e) => setAnswers({ ...answers, [q.key]: e.target.value })}
                />
              </div>
            </div>
          ))}
          <p className="text-xs text-[var(--sys-muted-foreground)]">
            <RiInformationLine className="me-1 inline h-4 w-4" />
            لا تكتب اسم زبون ولا رقم تلفون — الجواب اللي فيه رقم طويل بينرفض قبل ما يطلع.
          </p>
        </div>
      </div>

      {error && (
        <p className="mt-2 rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-xs text-[var(--sys-destructive)]">
          {error}
        </p>
      )}

      {picks && (
        <div className="mt-4 border-t border-[var(--sys-border)] pt-3">
          <h4 className="text-xs font-bold text-[var(--sys-heading)]">الاقتراح — وكل اختيار معه سببه</h4>
          {matchNote && <p className="mt-1 text-xs text-[var(--sys-muted-foreground)]">{matchNote}</p>}
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            {picks.map((p, i) => (
              <button
                key={`${p.structure}-${p.family}`}
                type="button"
                onClick={() => setChosen(i)}
                aria-pressed={chosen === i}
                className={`min-h-11 rounded-lg border p-2.5 text-start ${
                  chosen === i
                    ? 'border-[var(--sys-primary)] bg-[var(--sys-primary)]/5'
                    : 'border-[var(--sys-border)] hover:border-[var(--sys-primary)]/40'
                }`}
              >
                <span className="block text-xs font-bold text-[var(--sys-heading)]">
                  {p.structureName} · {p.familyName}
                </span>
                <span className="mt-1 block text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                  {p.structureWhy}
                </span>
                <span className="mt-1 block text-xs leading-relaxed text-[var(--sys-muted-foreground)]">
                  {p.familyWhy}
                </span>
              </button>
            ))}
          </div>
          {countedNote && (
            <p className="mt-2 text-xs text-[var(--sys-muted)]">
              {countedNote} {countedWhy}
            </p>
          )}
        </div>
      )}

      {notices.length > 0 && (
        <div className="mt-3 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-warning-soft)] p-2.5">
          <p className="text-xs font-bold text-[var(--sys-warning)]">
            <RiAlertLine className="me-1 inline h-4 w-4" /> تعارض بين المكتوب والمقروء من الصورة
          </p>
          {notices.map((n) => (
            <p key={n.key} className="mt-1 text-xs text-[var(--sys-foreground)]">
              {n.label}: المكتوب «{n.written}» — المقروء «{n.read}». المكتوب هو المعتمد.
            </p>
          ))}
        </div>
      )}

      {fields && fields.length > 0 && (
        <div className="mt-4 border-t border-[var(--sys-border)] pt-3">
          <h4 className="text-xs font-bold text-[var(--sys-heading)]">الحقول — كلّها بتنعدّل</h4>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {fields.map((f, i) => (
              <div key={f.key}>
                <div className="mb-1 flex items-center gap-1.5">
                  <span className="text-xs font-semibold text-[var(--sys-foreground)]">
                    {i + 1}. {f.label}
                  </span>
                  <Badge variant={SOURCE_TONE[f.source]}>{SOURCE_LABEL[f.source]}</Badge>
                </div>
                <Input
                  value={edited[f.key] ?? ''}
                  onChange={(e) => setEdited({ ...edited, [f.key]: e.target.value })}
                />
              </div>
            ))}
          </div>

          <h4 className="mt-3 text-xs font-bold text-[var(--sys-heading)]">
            الوعود — ما بيدخل إلا المكتوب بمكان
          </h4>
          {promises.length === 0 && (
            <p className="mt-1 text-xs text-[var(--sys-muted-foreground)]">ما في وعد مكتوب بصفحة المنتج ولا على العلبة.</p>
          )}
          <div className="mt-1.5 grid gap-1.5">
            {promises.map((p) => (
              <div
                key={p.text}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--sys-border)] p-2"
              >
                <span className="text-xs text-[var(--sys-foreground)]">{p.text}</span>
                <Badge variant={p.refused ? 'danger' : SOURCE_TONE[p.source]}>
                  {p.refused ? 'مرفوض' : SOURCE_LABEL[p.source]}
                </Badge>
                {p.refused ? (
                  <span className="text-xs text-[var(--sys-destructive)]">{p.refused}</span>
                ) : p.enters ? (
                  <span className="text-xs text-[var(--sys-muted-foreground)]">
                    <RiCheckboxCircleLine className="me-1 inline h-4 w-4" /> داخل الصفحة
                  </span>
                ) : (
                  <label className="flex min-h-11 items-center gap-1.5 text-xs text-[var(--sys-foreground)]">
                    <input
                      type="checkbox"
                      checked={!!approved[p.text]}
                      onChange={(e) => setApproved({ ...approved, [p.text]: e.target.checked })}
                      className="h-4 w-4"
                    />
                    أوافق عليه، وبيدخل الصفحة
                  </label>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {colors && (
        <div className="mt-3 rounded-lg border border-[var(--sys-border)] p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold text-[var(--sys-heading)]">
              <RiPaletteLine className="me-1 inline h-4 w-4" /> ألوان العالم — محسوبة من الصورة
            </span>
            {[colors.background, colors.accent, colors.text].map((c) => (
              <span
                key={c}
                title={c}
                style={{ background: c }}
                className="inline-block h-6 w-6 rounded-full border border-[var(--sys-border)]"
              />
            ))}
            <label className="flex min-h-11 items-center gap-1.5 text-xs text-[var(--sys-foreground)]">
              <input
                type="checkbox"
                checked={useColors}
                onChange={(e) => setUseColors(e.target.checked)}
                className="h-4 w-4"
              />
              استعملها للصفحة
            </label>
          </div>
          <p className="mt-1 text-xs text-[var(--sys-muted-foreground)]">
            {colors.how} · {worldIsDark(colors) ? 'عالم داكن' : 'عالم فاتح'}
          </p>
        </div>
      )}

      {(notes.length > 0 || imageWhy || routeLine) && (
        <div className="mt-3 rounded-lg border border-[var(--sys-border)] bg-[var(--sys-surface)] p-2.5">
          {imageWhy && <p className="text-xs text-[var(--sys-foreground)]">{imageWhy}</p>}
          {notes.map((n) => (
            <p key={n} className="mt-1 text-xs text-[var(--sys-muted-foreground)]">
              {n}
            </p>
          ))}
          {routeLine && (
            <p className="mt-1 text-xs text-[var(--sys-muted)]">بيروح على: {routeLine}</p>
          )}
        </div>
      )}

      {pick && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" onClick={apply}>
            <RiCheckboxCircleLine className="h-4 w-4" /> استعمل هذا الاقتراح
          </Button>
          <span className="text-xs text-[var(--sys-muted-foreground)]">
            بيختار البنية والألوان بالنموذج تحت — والصفحة ما بتنشأ إلا بكبستك.
          </span>
        </div>
      )}
    </div>
  );
}
