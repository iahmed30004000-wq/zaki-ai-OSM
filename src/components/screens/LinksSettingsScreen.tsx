'use client';

import React from 'react';
import { ScreenTitle } from '@/components/shell/ScreenTitle';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';
import { WhatsAppSettingsScreen } from '@/components/screens/WhatsAppSettingsScreen';
import { TelegramSettingsScreen } from '@/components/screens/TelegramSettingsScreen';

/**
 * /settings/links — «الربط»: HOW THIS SYSTEM IS CONNECTED TO THE CHAT APPS.
 *
 * «إعدادات واتساب» and «إعدادات تلجرام» were two pages for the same errand —
 * read the connection status, test it, reconnect it — seen once, at set-up
 * (the settings landing already listed them as one card). They are one page
 * with a card each (owner, 24/10).
 *
 * EACH CARD FOR WHOEVER HOLDS ITS KEY. `whatsapp.manage` and `telegram.connect`
 * stay two grants: the page opens for either, and a person with one sees one
 * card and never a card whose every button the door would refuse. The doors
 * behind the cards (`/api/whatsapp/connection/*`, `/api/telegram/*`) ask their
 * own permission, exactly as before; the cards are the same two components
 * that were the two pages, drawn inside this one (`embedded`).
 *
 * The Telegram card asks `telegram.connect`, not `telegram.manage` (T-09, 3/11): `telegram.manage` is the day's
 * work on «طلبات تلجرام» (إعادة المعالجة · تجاهل · تعديل وترحيل), and whoever was given it for that could register the
 * webhook and unbind a group. The bot's state stays readable on the orders screen through `telegram.view`.
 *
 * The inbox keeps its own connection badge and its «إعداد WhatsApp» link, which now
 * lands on the WhatsApp card (`#whatsapp`); the Telegram orders screen's links land on
 * `#telegram`.
 */
export function LinksSettingsScreen() {
  const { currentUser } = useApp();
  // The server's own test: the key itself (SUPER_ADMIN holds every key). No other role passes by name.
  const mayManage = (key: string) => userCan(currentUser, key);
  const whatsapp = mayManage('whatsapp.manage');
  const telegram = mayManage('telegram.connect');

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6" dir="rtl">
      <ScreenTitle />
      {whatsapp && (
        <section id="whatsapp" aria-label="واتساب">
          <WhatsAppSettingsScreen embedded />
        </section>
      )}
      {telegram && (
        <section id="telegram" aria-label="تلجرام">
          <TelegramSettingsScreen embedded />
        </section>
      )}
    </div>
  );
}
