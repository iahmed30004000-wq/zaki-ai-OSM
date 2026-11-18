'use client';

import React from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { routeLabel } from '@/lib/route-registry';
import { useApp } from '@/context/AppContext';
import { userCan } from '@/lib/can';
import { WhatsAppSettingsScreen } from '@/components/screens/WhatsAppSettingsScreen';
import { TelegramSettingsScreen } from '@/components/screens/TelegramSettingsScreen';
import { IntegrationFieldsCard } from '@/components/settings/IntegrationFieldsCard';

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
 * THE VALUES THEMSELVES (the media buyer's doors, PR-C): each card is followed by «القيم المطلوبة» (`IntegrationFieldsCard`) — the tokens, ids and secrets, entered here, saved sealed and
 * never shown back (the owner's rule: no connection setting in Coolify). The server's environment stays as the fallback.
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
      <PageHeader title={routeLabel('/settings/links')} />
      {whatsapp && (
        <section id="whatsapp" aria-label="واتساب">
          <WhatsAppSettingsScreen embedded />
          <IntegrationFieldsCard group="whatsapp" />
        </section>
      )}
      {telegram && (
        <section id="telegram" aria-label="تلجرام">
          <TelegramSettingsScreen embedded />
          <IntegrationFieldsCard group="telegram" />
        </section>
      )}
    </div>
  );
}
