# Architecture — navigation, access, screen contracts

Every screen here is a contract. A screen not listed does not exist.
A screen listed must exist at the exact path, in the exact group.

> **Corrected to the code on 2026-11-18** (R0 of the restructure). Until then this file described a menu and a set of
> limits that had been changed one by one since September: screens it named had become tabs, buttons or redirects, and
> the numbers in the queue contract were not the ones in the code. The RULES below are the contract's, unchanged; the
> ROUTES, LINES and LIMITS are what `src/lib/route-registry.ts` and `src/lib/confirmation-queue.ts` say today.
>
> It is checked, not trusted: `src/lib/the-guard-contract-names-real-routes.test.ts` fails when this file names a
> path that has no page, and `src/lib/the-regroup-opened-no-door.test.ts` pins every page with the keys that open it.
> Where this file and the code disagree, the code wins — fix this file in the same pull request.

## Hierarchy and entry

`Company → Country → Store → ProductMarket → LandingPage`

Entry is TWO explicit steps, in this order:

**Step 1 — Country picker.** Countries the user is assigned to, each with
currency code and count of active stores. "Add country" for owner and
manager only.

**Step 2 — Store picker**, scoped to the chosen country. Logo, name,
status (active / paused), type badge (single product / multi product).

Then the dashboard loads.

Rules:
- The store INHERITS from its country: currency, minor unit, regions,
  delivery-fee tables, work hours, weekend days, order prefix,
  allow_negative_stock. None re-selected at store level.
- Country and store are injected into EVERY API request and held in the
  session. A request missing either is rejected at the service layer.
- One country assigned → skip step 1. One store in it → skip step 2.
- Switching country CLEARS the selected store. Never carried over.
- A country with zero stores shows an empty state whose only action is
  creating the first store. Never a dead end.
- Creating a country provisions its default wallet and makes it appear
  in delivery fees and commission rules automatically.

## Navigation — nine groups, drawn as ten lines

The registry (`src/lib/route-registry.ts`, constant `NAV`) is the one list, and this section
is its contract. It holds **57 pages in 9 groups**; the menu draws them as **10 lines**.

Since 18/11 each line is one kind of work (the owner: «القائمة من 16 سطر لـ9»). Ten and not nine until
the storefront's two lines fold into one. What moved on 18/11 was only which group a screen belongs to:
every path, every permission and every title stayed as it was.

How a group is drawn is `NavGroup.hub`, and it is a statement about the MENU only — it never
changes what a page is, who may open it, or where it lives:

- `tabs` — the group is ONE sidebar line (its `icon` and name) that opens the first screen the
  person may open; above every screen of the group a strip of pills (`HubTabs`) lists the others —
  only the ones this person may open, in the order they arranged them. On a road the pills carry the
  step and the «التالي» link. A group with one screen left to a person takes that screen's own name.
- `cards` — one line that opens a page of cards (the group's first route, `/settings`); every other
  screen of the group carries a «← الإدارة» link back to it. Every screen of the group sits on exactly
  one card (`src/lib/settings-home.ts`). A person who may open a screen of the group but not the door
  is led by the line to their own first screen, and sees the others as pills.
- `loose` — no heading, no folding: each screen its own line (اليوم and واجهة المتجر).

Ten lines: 1+1+1+1+1+1+1+2+1 — اليوم, الطلبات, التأكيد, الشحن, المخزون والمنتجات, المال, التقارير,
the two of واجهة المتجر, الإدارة.

Three fields of a route are menu facts and nothing else:

- **`step`** — «1.», «2.»… before the label. A road is numbered in «الشحن» (five stops) and in «المال»
  (the first four). A hint for reading the menu, never a rule: every screen opens on its own permission,
  in any order, and the number belongs to the screen, not to its row.
- **`foldedUnder`** — the screen is the DETAIL of another and is not a menu line for whoever can open
  that one (today: لوحة الأداء, folded under the dashboard). A person who cannot open the parent keeps
  it as a line: folding is for the menu, never for access.
- **`offMenu`** — the screen's real door is not the menu (today: المساعد الذكي, whose door is the bubble
  on every screen, and الملف الشخصي, whose doors are the name in the header and a line of the phone's
  «المزيد»).

An address never moves because the menu was rearranged: a bookmark, a notification and a saved menu
arrangement (which is a list of PATHS) all keep meaning what they meant. A saved order of GROUPS that
names a key that went (`control`, `chats`, `settings`) simply loses that entry. A screen that stopped
being a page keeps its old address as a permanent redirect (`next.config.ts`).

**1. اليوم** (`today`) — loose, one line
```
لوحة التحكم              /dashboard
```

**2. الطلبات** (`main`) — tabs; every door an order comes in by
```
الطلبات                  /orders
السلات المهجورة           /abandoned-carts   (the carts the landing pages send; same key as the orders)
العملاء                  /customers
طلبات تلجرام              /growth/telegram/orders
صندوق الواتساب            /growth/whatsapp/inbox
رسائل اللاندينج           /growth/landing-chats   (Zaki pages' chat assistant; whatsapp.view)
```

**3. التأكيد** (`confirmation`) — tabs
```
الطلبات الجديدة           /confirmation/queue      (the SUPERVISOR's view of the pool; an agent is sent to طلباتي)
طلباتي                   /confirmation/mine       (the pull panel is at its top)
المتابعة                  /confirmation/follow-up  (two tabs: the postponed orders and the cancelled-before ones)
الإشكالات                /confirmation/issues
قواعد مركز التأكيد        /confirmation/rules      (the eight confirmation-rule cards, moved from إعدادات النظام on 18/11)
```
«الطلبات المؤجلة» and «استرجاع الملغى» are no longer screens: they are the two tabs of المتابعة, and an
agent's own postponed orders are a tab of طلباتي.

**4. الشحن** (`ops`) — tabs; one parcel's road, numbered
```
1. التجهيز                /ops/preparation
2. إنشاء شحنة              /ops/shipments/new
3. دفعات الشحن             /ops/batches        (labels, sizes, PDF and the courier CSV live here)
4. متابعة الشحن            /ops/tracking
5. المرتجعات               /ops/returns
```

**5. المخزون والمنتجات** (`inventory`) — tabs
```
المنتجات                 /products
أرصدة المخزون             /inventory/balances   («استلام بضاعة جاهزة» is a button on each product's card here)
تشغيلات الإنتاج           /manufacturing
حركات المخزون             /inventory/movements
```

**6. المال** (`finance`) — tabs. The first four are one errand: see what each courier holds, take it in
(by statement or by hand), match, close the day.
```
1. عهدة المندوبين           /finance/agents
2. التحصيل والكشوف          /finance/collection
3. المطابقة                /finance/matching
4. الإغلاق اليومي           /finance/closing
   المحافظ والحركات         /finance/wallets
   التحويلات               /finance/transfers
   الأرباح                 /finance/profit
   العمولات                /settings/commission   (its address stays under /settings — the one screen there not in الإدارة)
   قواعد المال              /finance/rules         (the clean-line settlement and the partners cards, moved from إعدادات النظام on 19/11; settings.view)
```

**7. التقارير** (`growth`) — tabs
```
لوحة الأداء               /growth/performance      (folded under the dashboard for whoever can open it)
الحملات                  /growth/campaigns
مركز الذكاء               /growth/intelligence
منصّة التجريب             /growth/bench
المساعد الذكي             /assistant               (off the menu: the bubble is its door)
```

**8. واجهة المتجر** (`storefront`) — loose; how the shop LOOKS and what it SAYS. Another agent owns this code.
```
المتجر                    /store
صفحات الهبوط              /store/landing-pages
```
`/store` lists every shop on one card each, and the shop's own screens are the tabs of `/store`
(`src/lib/store-admin.ts`), not menu entries. The old single-product address redirects permanently.

**9. الإدارة** (`admin`) — how the system RUNS and who runs it. A hub of cards: ONE menu line that opens
`/settings`, a page of ten cards, each linking only to the screens the person may open; a card with
nothing they may open is not drawn. `/settings` is also where an ad platform's OAuth round trip lands.
```
الإعدادات                 /settings           (the front door; the union of the keys of the eight SETTINGS cards)
البلدان والمتاجر           /settings/geo
شركات الشحن وأجورها        /settings/couriers  (a courier and its fees are one screen)
قنوات الطلبات              /settings/channels
بكسل الإعلانات             /settings/tracking
الربط                    /settings/links     (WhatsApp and Telegram, one card each, each for the key that owns it)
الذكاء الاصطناعي والنصوص    /settings/ai
متجر التطبيقات            /apps/store
التطبيقات المثبتة          /apps/installed
إعدادات النظام            /settings/system
المهام المجدولة            /admin/jobs         (on the system card; gate settings.view)
قواعد الموظفين             /admin/staff-rules  (the score and the deductions cards, moved from إعدادات النظام on 19/11; settings.view)
الموظفين                  /admin/users
الصلاحيات                 /admin/permissions
طلبات التعديل             /control/change-requests
تنبيهات الخصم             /control/discount-alerts   (a price cut given to a customer)
خصومات الموظفين           /control/penalties         (money off a salary)
سجل التدقيق               /control/audit
القائمة السوداء           /control/blacklist
الملف الشخصي              /admin/profile     (every active user; off the menu — the name in the header, a line of «المزيد»)
```
The cards: the eight settings cards (البلدان والمتاجر · الشحن · العمولات · القنوات والتتبّع · واتساب وتلجرام
· الذكاء الاصطناعي · التطبيقات · النظام), then الموظفون والصلاحيات and الرقابة — 8 + 2 = 10. «العمولات»
keeps its card: `/settings` opens on `commission.view`.

Detail pages under a registered screen (`/products/[id]`, `/abandoned-carts/[id]`,
`/admin/users/[id]`, `/store/landing-pages/[id]`) are not registry entries: they open on their parent's
permission and are never menu lines.

## Distinctions that must not collapse

- `/assistant` is a CHAT assistant: ask about a product, an order, a how-to. Conversational.
  `/growth/intelligence` is BUSINESS ANALYSIS over operational data: pricing, offers, cross-sell,
  seasons, next product, expansion, stop-the-bleed, customers. Proposes actions. They are separate
  routes and stay so, even though each carries a little of the other's work (an «اسأل» box inside
  the intelligence centre) — do not merge them.
- Apps appear ONCE — in الإدارة, beside the settings they configure.
- Countries and stores live together in `/settings/geo`. A country provisions its default wallet when
  it is created; wallets are then created, styled and stopped on `/finance/wallets`, beside the ledger
  they belong to.
- An OPERATION sits with the work and its CONFIGURATION sits in settings: the WhatsApp inbox is in
  الطلبات and its setup is a card of `/settings/links`; the assistant is work, the provider and the
  key are setup. Two known exceptions are documented, not endorsed: the Telegram product aliases are
  edited on the Telegram orders screen, and ad accounts are linked from the campaigns screen.

## Access — by permission key, enforced at the API, 403 not hidden

**A page opens when the user holds ANY key listed for it** (`null` = every active user). Access is
decided by keys and never by role name: a custom role is judged by what it holds. The role values in
`UserRole` (thirteen today) are labels for system templates in the database; the API behind each screen
asks the same keys again.

| Page | Keys (any one opens it) |
|---|---|
| `/dashboard` | dashboard.view |
| `/orders` · `/abandoned-carts` | orders.view |
| `/customers` | customers.view · customers.view_basic |
| `/products` | products.view |
| `/confirmation/queue` · `/confirmation/follow-up` | confirmation.supervise |
| `/confirmation/mine` | confirmation.work · confirmation.pull |
| `/confirmation/issues` | confirmation.issues |
| `/confirmation/rules` | settings.view |
| `/ops/preparation` · `/ops/shipments/new` · `/ops/batches` · `/ops/tracking` · `/ops/returns` | ops.prepare · ops.ship · ops.batches · ops.track · ops.returns |
| `/inventory/balances` · `/inventory/movements` | inventory.view |
| `/manufacturing` | production.view |
| `/finance/agents` | settlement.view · settlement.review |
| `/finance/collection` | settlement.upload · settlement.view |
| `/finance/matching` | settlement.review |
| `/finance/closing` · `/finance/wallets` · `/finance/transfers` | finance.cashbox_view |
| `/finance/profit` | finance.view |
| `/finance/rules` | settings.view |
| `/control/change-requests` · `/control/discount-alerts` · `/control/penalties` · `/control/audit` · `/control/blacklist` | control.change_requests · control.discount_alerts · penalties.view · audit.view · control.blacklist |
| `/growth/performance` | reports.view |
| `/growth/campaigns` | campaigns.view |
| `/growth/intelligence` · `/growth/bench` | growth.intelligence |
| `/assistant` | ai.use |
| `/growth/whatsapp/inbox` · `/growth/telegram/orders` | whatsapp.view · telegram.view |
| `/growth/landing-chats` | whatsapp.view |
| `/store` | storefront.view · storefront.manage · geo.manage |
| `/store/landing-pages` | landing_pages.view |
| `/settings` | geo.view · settings.view · commission.view · whatsapp.manage · telegram.connect · apps.view |
| `/settings/geo` | geo.view |
| `/settings/couriers` · `/settings/channels` · `/settings/tracking` · `/settings/ai` · `/settings/system` · `/admin/jobs` · `/admin/staff-rules` | settings.view |
| `/settings/commission` | commission.view |
| `/settings/links` | whatsapp.manage · telegram.connect |
| `/apps/store` · `/apps/installed` | apps.view |
| `/admin/users` · `/admin/permissions` | users.view · roles.view |
| `/admin/profile` | every active user |

(The table groups rows that share a rule; the exact key list of every page is pinned, one by one, in
`src/lib/the-regroup-opened-no-door.test.ts`.)

What the contract means by role, kept as INTENT — the keys above are what is enforced:

- The moderator types orders and fixes entry issues, reads customers (no export), and NEVER reaches
  `/confirmation/queue`: pulling orders is not the moderator's job, and she never holds
  `confirmation.supervise`.
- The confirmation agent works `/confirmation/mine` (the pull is at its top, her postponed orders are
  one of its tabs). She does not see the supervisor's queue.
- The supervisor and the team leader see the confirmation routes with the list view, the change
  requests and discount alerts, and `/growth/performance`.
- The warehouse prepares, batches and receives returns and works the inventory screens. The contract
  said «no phone and no address in any payload»; the key `ops.edit_in_batch` (off by default) lets the
  packing table edit them, so a payload for a holder of that key carries them. Do not widen it.
- Shipping creates shipments, sends batches and follows tracking, and sees change requests.
- The accountant and the settlement officer hold the finance screens (two deliberately different pairs
  of hands) and read the audit log.
- The manager holds everything except write on `/admin/permissions`; the owner holds everything.

## Screen contracts

**/confirmation/queue** — the supervisor's view of the pool, with the full list of the same data. Agents
do NOT see a list: an agent pulls the next order from the panel at the top of `/confirmation/mine`, and an
old address sends her there. Priority (`pickNextCandidate`): what is held for her; then a NEW order, oldest
first; then a postponed order due within `POSTPONE_LEAD_DAYS`; then the oldest of the rest — with the
cadence on, the customer's promised date and the oldest-due retry come first. Limits, in
`src/lib/confirmation-queue.ts` and NOWHERE ELSE: `CLAIM_CAPS` — 40 owned with no attempt, 500 owned in
total; `PULL_PACE` — at most 40 pulls in any rolling hour; `RETURNS_MODE.handLimit` — 5, where the
«returns» mode is on. She cannot pull while holding an order she has not tried to contact. A claim with no
attempt auto-releases after `AUTO_RELEASE_BUSINESS_MINUTES` (90 business minutes: frozen outside work hours
and on weekend days).

**/confirmation/mine** — the agent's desk, in tabs: the orders to ring now, the orders waiting after a
no-answer, the orders already confirmed (read only, with a raise-change-request action per row), and her
postponed orders. Order actions: call, WhatsApp, SMS, no-answer, postpone with date and preferred time and
reason, confirm, cancel, discount, raise issue. What happens after a no-answer — rounds, an instant return
to the queue, the five-attempt schedule — is behind company switches: read `no-answer-rounds.ts` and
`no-answer-returns.ts` before changing it. Sub-status selector only for states that define one. Customer risk
panel: returns over orders across 6 months or the last 10 orders; tiers at 15% and 40%; high risk requires
prepayment or supervisor approval and is excluded from automated confirmation. A contact is logged before a
decision (`needsContactFirst`), and an order without a region cannot be confirmed (`needsRegionFirst`).

**/confirmation/follow-up** — the supervisor's. Tab «مؤجلة»: order, customer, due date, days remaining,
preferred time, reason, postpone count; only rows due within the lead days are actionable. Tab «ملغاة سابقاً»:
the win-back — a lost order offered back at a discount (money, so supervisors only); the agent meets the result
as an ordinary new order in her queue.

**/confirmation/issues** — Moderator-entered orders only. A store-sourced order can never raise an entry
issue. Actions: correct and return to queue, or void (owner only). An issue is never counted as a
cancellation against the agent, and the order keeps its original created_at.

**/confirmation/rules** — «قواعد مركز التأكيد» (18/11): the eight cards of the confirmation rules, moved unchanged from
`/settings/system`, under a read-only box «القاعدة بالمختصر» written on the server from the constants and switches the engine
reads. The two old cards (rounds, returns) stand at the bottom under «قواعد قديمة». Opens on `settings.view`; each card asks its own key.

**/ops/preparation** — Grouped BY PRODUCT, collapsible. Per product: orders, required, available, shortage
(all from the API; the screen adds nothing). Per order: open it, cancel it, print its waybill, review a
pending change request. Reservation is per line, and an order with one unreserved line cannot become
READY_TO_SHIP. Honours allow_negative_stock per country. Postponing an order for stock is done on
`/ops/shipments/new`, not here.

**/ops/shipments/new** — Filters: date range, courier, governorate, product. Select-all skips blocked rows.
Blocking warnings until acknowledged: duplicate in batch, previous shipment in transit, recent return, stock
shortage when negative stock is disallowed. COD breakdown per row before sending. An exceptions panel lists
undispatchable rows. A ready-to-ship view and a held-back view; the CSV of the ready orders for the courier.

**/ops/batches** — Where a batch is worked: labels (the courier barcode AND a QR of our order reference;
sizes in millimetres, custom allowed), PDF and CSV and Excel export, the scan check, sending to the courier,
pasting barcodes, closing the shipment, out for delivery, and editing, cancelling or postponing a parcel
while the batch is open. The URL carries a batch token, never a list of ids, with per-order authorization on
the server. «Printing labels» is no longer a screen of its own.

**/ops/tracking** — Search by order id, barcode, customer, phone. Days-in-transit counter with per-governorate
late thresholds. Actions: contact with a template that varies by stall reason, request edit, transfer courier,
return, and the door outcomes (delivered, partial, refused). Collection status is a column separate from
delivery status.

**/ops/returns** — Scan barcode or select. Receiving form: actual received, damaged, missing computed, courier
fee yes or no with automatic calculation by region and courier when yes, and a mandatory count-and-inspect
acknowledgement. Nothing enters stock before it.

**/finance/collection** — Statement upload with a file hash; no duplicate import. Receipt lines: MANY per
statement, each with its own wallet, currency and amount. Their sum must equal the statement total, otherwise
the gap is flagged and requires a written explanation before approval.

**/finance/matching** — Runs on demand AFTER the receipt is recorded. Single key: merchant reference, then
courier barcode. Never phone. The outcome is read as queues with editable actions: matched, mismatched, in the
statement but not in the system, excluded, and in the system but not in the statement. A second mode, «يدوي —
بلا كشف», matches by hand a courier that sends no statement. A partially delivered order is compared against
the post-event expected amount.

**/finance/wallets** — Wallet belongs to a country; currency chosen per wallet and may differ from the country
currency. Every movement requires wallet, direction, amount, party, category and note. No delete of a movement
— a reversing entry with a reason.

**/finance/transfers** — Wallet to wallet, same or different country, manual exchange rate entered by the user,
stored with the transfer, never recalculated. A transfer is reversed whole: both legs.

**/finance/rules** — «قواعد المال» (19/11): the two money cards of `/settings/system` — «تسوية السطور النظيفة عند الاعتماد» and
«الشركاء والنسب» — moved there unchanged, the last tab of المال. Opens on `settings.view`; each card asks its own key.

**/admin/staff-rules** — «قواعد الموظفين» (19/11): the two staff cards of `/settings/system` — «سكور الموظفين» and «قواعد الخصم» —
moved there unchanged, beside الموظفين in الإدارة. Opens on `settings.view`; editing asks `team.settings` / `penalties.rules`.
`/settings/system` keeps the company name and «العرض بعد الطلب» only.

**/finance/closing** — Per wallet: book balance, manually entered actual balance, computed difference,
mandatory explanation when non-zero. The user who records movements cannot approve the closing.

**/settings/geo** — Countries with currency, minor unit, work hours, weekend days, order prefix,
allow_negative_stock. Stores under countries. Warehouses under countries (19/11, warehouse plan W0a): a warehouse is a
place of ONE country and may hold the goods of any store of it; it has a name, keepers and a stop switch, and
is never deleted. Doors under api/geo/warehouses: the list (geo.view, reach-filtered) and create (geo.manage);
one warehouse (rename / stop / start, geo.manage; stop refused while it holds units); its keepers (geo.manage).
A keeper row confines the person to the warehouses she keeps (`src/lib/warehouses.ts`). Until a store is
placed (a later request) no stock door reads a warehouse: every store works exactly as before.

**/settings/couriers** — A courier and its fees are ONE screen. Fees: a separate table per courier per country
per governorate, with fee and late-threshold days. A manual override requires a reason and is written to the
audit log.

**/admin/permissions** — Role templates plus per-user overrides. Each permission carries a scope: own | store |
country | selected | all, and an optional amount ceiling. Scope is applied inside the query, never by hiding
columns. Hidden by default: product cost, ad spend, net profit, commission rule amounts.
