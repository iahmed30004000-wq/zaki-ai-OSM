'use client';

import React, { useRef, useState } from 'react';
import { RiCheckLine, RiImageAddLine, RiLoader4Line } from '@remixicon/react';
import { apiJson } from '@/lib/api-client';
import { Modal } from '@/components/ui/Modal';
import { WALLET_ICON_COMPONENT, WalletPicture } from '@/components/ui/WalletPicture';
import { uploadWalletImage } from '@/lib/wallet-image-upload';
import {
  WALLET_COLOR_KEYS,
  WALLET_ICON_KEYS,
  WALLET_ICON_LABEL,
  WALLET_IMAGE_BAD_TYPE,
  WALLET_IMAGE_MAX_BYTES,
  WALLET_IMAGE_TOO_BIG,
  WALLET_IMAGE_TYPES,
  isWalletColorKey,
  isWalletIconKey,
  walletColorVar,
  type WalletColorKey,
  type WalletIconKey,
} from '@/lib/wallet-look';

/**
 * «تعديل شكل المحفظة» — A PICTURE, OR AN ICON, AND A COLOUR, SEEN BEFORE THEY ARE KEPT.
 *
 * The wallet's face is what the girl at the counter recognises it by, so the editor starts from the face: a preview at the
 * top that follows every press, then the three things that make it — a picture to upload, or an icon from the ready list,
 * and a colour. Nothing is written until «احفظ»; «إلغاء» leaves the wallet exactly as it was.
 *
 * A PICTURE IS UPLOADED AT ONCE and kept as a key until the save, so the preview is the real stored picture and a refusal
 * (too big, not an image) is read in the dialog, in the door's own words, before anybody presses save. The file stays on
 * the volume even if the dialog is cancelled; the wallet only ever points at the key that was saved.
 *
 * AN ICON TAKES THE PICTURE'S PLACE («أو اختار أيقونة جاهزة»): a picture covers the icon, so an icon pressed beneath a
 * picture that stayed would change nothing on the preview. The colour is separate — it is the picture's edge as well as the
 * icon's tint, so it still shows with either.
 *
 * WHAT GOES ON THE WIRE is only what changed, as the wallet's PATCH door reads it: a key or an icon or a colour to set, `null`
 * to clear one back to its default (the icon its currency says, the colour its id picks). The door is the judge of every
 * value; the lists here are the same lists it checks against (lib/wallet-look).
 */

export interface LookWallet {
  id: string;
  name: string;
  currencyCode: string;
  country?: { name: string } | null;
  imageKey?: string | null;
  iconKey?: string | null;
  colorKey?: string | null;
}

const ACCEPT = WALLET_IMAGE_TYPES.join(',');

/** What the pressed tile of a choice looks like: the same border and surface the transfer chips use when chosen. */
const tileClass = (on: boolean) =>
  `inline-flex min-h-11 min-w-11 md:min-h-0 md:min-w-0 cursor-pointer items-center justify-center rounded-lg border p-2 ${
    on ? 'border-[var(--sys-primary)] bg-[var(--sys-surface)]' : 'border-[var(--sys-border)] bg-[var(--sys-card)]'
  }`;

export function WalletLookDialog({
  wallet,
  onClose,
  onSaved,
}: {
  wallet: LookWallet;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const saved = {
    imageKey: wallet.imageKey ?? null,
    iconKey: isWalletIconKey(wallet.iconKey) ? wallet.iconKey : null,
    colorKey: isWalletColorKey(wallet.colorKey) ? wallet.colorKey : null,
  };
  const [imageKey, setImageKey] = useState<string | null>(saved.imageKey);
  const [iconKey, setIconKey] = useState<WalletIconKey | null>(saved.iconKey);
  const [colorKey, setColorKey] = useState<WalletColorKey | null>(saved.colorKey);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileBox = useRef<HTMLInputElement>(null);

  const where = [wallet.country?.name, wallet.currencyCode].filter(Boolean).join(' · ');
  const changed: Record<string, string | null> = {};
  if (imageKey !== saved.imageKey) changed.imageKey = imageKey;
  if (iconKey !== saved.iconKey) changed.iconKey = iconKey;
  if (colorKey !== saved.colorKey) changed.colorKey = colorKey;
  const dirty = Object.keys(changed).length > 0;
  const anyChosen = imageKey !== null || iconKey !== null || colorKey !== null;

  async function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    // The same two refusals the door makes, said before the bytes leave the phone.
    if (!(WALLET_IMAGE_TYPES as readonly string[]).includes(file.type)) return setError(WALLET_IMAGE_BAD_TYPE);
    if (file.size > WALLET_IMAGE_MAX_BYTES) return setError(WALLET_IMAGE_TOO_BIG);
    setUploading(true);
    try {
      setImageKey(await uploadWalletImage(wallet.id, file));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر رفع الصورة');
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiJson(`/api/finance/wallets/${wallet.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changed),
      });
      onSaved('تم تغيير شكل المحفظة');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر الحفظ');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="تعديل شكل المحفظة"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => {
              setImageKey(null);
              setIconKey(null);
              setColorKey(null);
              setError(null);
            }}
            disabled={!anyChosen || saving || uploading}
            className="h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border)] text-sm text-[var(--sys-muted-foreground)] disabled:opacity-50"
          >
            رجّع الشكل التلقائي
          </button>
          <span className="flex gap-2">
            <button type="button" onClick={onClose} className="h-11 md:h-10 px-4 rounded-lg border border-[var(--sys-border)] text-sm">
              إلغاء
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={!dirty || saving || uploading}
              className="h-11 md:h-10 px-4 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-sm font-medium disabled:opacity-50"
            >
              {saving ? 'جارٍ الحفظ…' : 'احفظ'}
            </button>
          </span>
        </div>
      }
    >
      <div className="space-y-4">
        {/* The face, as it will be — it follows every press below. */}
        <div className="flex items-center gap-3">
          <WalletPicture wallet={{ id: wallet.id, currencyCode: wallet.currencyCode, imageKey, iconKey, colorKey }} size="lg" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-[var(--sys-heading)]">{wallet.name}</p>
            <p className="text-xs text-[var(--sys-muted-foreground)]">{where}</p>
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-medium text-[var(--sys-heading)]">الصورة</p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => fileBox.current?.click()}
              disabled={uploading}
              className="h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border)] text-sm inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              {uploading ? <RiLoader4Line className="w-4 h-4 animate-spin" /> : <RiImageAddLine className="w-4 h-4" />}
              {uploading ? 'جارٍ الرفع…' : imageKey ? 'غيّر الصورة' : 'ارفع صورة'}
            </button>
            {imageKey && !uploading && (
              <button
                type="button"
                onClick={() => setImageKey(null)}
                className="h-11 md:h-10 px-3 rounded-lg border border-[var(--sys-border)] text-sm text-[var(--sys-muted-foreground)]"
              >
                شيل الصورة
              </button>
            )}
            <input
              ref={fileBox}
              type="file"
              accept={ACCEPT}
              aria-label="ملف الصورة"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                // The same file chosen twice must still be heard.
                e.target.value = '';
                void pick(file);
              }}
            />
          </div>
          <p className="text-xs text-[var(--sys-muted-foreground)]">
            PNG أو JPG أو WEBP، لحد 5 ميجابايت. بتظهر صغيرة (32 لـ 44 بكسل) — اختار صورة قريبة وواضحة.
          </p>
          {/* A picture is read by everybody who sees the wallets, and a bank's card is the example the owner gave. */}
          <p className="text-xs text-[var(--sys-muted-foreground)]">
            لا تحط صورة فيها رقم بطاقة أو حساب: كل من بيشوف المحافظ بيشوفها.
          </p>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-medium text-[var(--sys-heading)]">أو اختار أيقونة جاهزة</p>
          <div role="group" aria-label="الأيقونة" className="flex flex-wrap gap-2">
            {WALLET_ICON_KEYS.map((key) => {
              const Icon = WALLET_ICON_COMPONENT[key];
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={iconKey === key}
                  aria-label={WALLET_ICON_LABEL[key]}
                  title={WALLET_ICON_LABEL[key]}
                  onClick={() => {
                    setIconKey(key);
                    // An icon is chosen INSTEAD of a picture: a picture left standing would cover it.
                    setImageKey(null);
                  }}
                  className={tileClass(iconKey === key)}
                >
                  <Icon className="w-5 h-5" />
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-medium text-[var(--sys-heading)]">واللون</p>
          <div role="group" aria-label="اللون" className="flex flex-wrap gap-2">
            {WALLET_COLOR_KEYS.map((key, i) => (
              <button
                key={key}
                type="button"
                aria-pressed={colorKey === key}
                aria-label={`لون ${i + 1}`}
                title={`لون ${i + 1}`}
                onClick={() => setColorKey(key)}
                className={tileClass(colorKey === key)}
              >
                <span
                  aria-hidden="true"
                  style={{ backgroundColor: walletColorVar(key), color: 'var(--sys-card)' }}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full"
                >
                  {colorKey === key && <RiCheckLine className="w-4 h-4" />}
                </span>
              </button>
            ))}
          </div>
        </div>

        {error && (
          <p role="alert" className="rounded-lg border border-[var(--sys-destructive-border)] bg-[var(--sys-destructive-soft)] p-2.5 text-sm text-[var(--sys-destructive)]">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
