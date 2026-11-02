# Courier integrations

One courier is handled by a person today: someone hands over the parcels,
writes the tracking number on the shipment screen, and updates the status
from what the courier says. `manual.ts` is that, written down.

An automated courier is a second implementation of `CourierAdapter` in
`types.ts` and nothing else. Register it in `index.ts`, then switch
`apiEnabled` on for that provider — until someone does, the provider stays
manual, which is the safe default.

## The rule that does not bend

A courier reports what it observed. **We** decide what it means.

`COURIER_CANNOT_ASSERT` holds `DELIVERED`, `RETURNED` and `CANCELLED`. A feed
may never set those, and `mapStatus` must return `null` for any code it does
not recognise rather than guessing a near match. DELIVERED makes commission
accrue and money expected from the courier; RETURNED reverses it. Moving
money because of a string we do not understand is the one failure that cannot
be undone with an apology, so both stay a human decision taken against the
courier's own statement.

In-transit statuses (`SHIPPED`, `OUT_FOR_DELIVERY`, `FAILED_DELIVERY`) move no
money and may be applied automatically — through the normal transition
machine in `shipping-workflow.ts`, never by writing the column directly.

## LogesTechs — built

`logestechs.ts`, against their API documentation (v. 9-6-2026).
Base `https://apisv2.logestechs.com/api`. Authentication is the account email
and password in each request body, not a token, so we have to be able to send
them back: they are stored in `DeliveryProvider.apiCredentials`, encrypted at
rest (AES-256-GCM, key `APP_ENCRYPTION_KEY` from the environment only), written
through `/api/delivery-providers/[id]/credentials` and never returned by any
endpoint. Without the key, saving is refused rather than stored in the clear.

| What | Their endpoint |
|---|---|
| Create shipment | `POST /ship/request/by-email` |
| City id for an address | `GET /addresses/cities?search=` |
| One package's status | `GET /guests/packages/status?barcode=` |
| AWB labels | `POST /guests/{companyId}/packages/pdf` |
| Cancel | `PUT /guests/{companyId}/packages/cancel?barcode=` |

Two details of their contract worth keeping in mind: their `cod` is the
amount **including** delivery, which is exactly our COD; and their
`invoiceNumber` is the merchant's own order number, so our `merchantRef`
goes there — it is the key their statement comes back with, and the key
matching reads.

### Status mapping

`LOGESTECHS_STATUS` maps their codes only where the meaning is unambiguous.
Their driver-assignment, shelf and partner-transfer codes say where the
parcel is inside *their* operation, not what has happened to it from our
side, so they map to `null` and nothing is applied. `DELIVERED_TO_RECIPIENT`
and `RETURNED_BY_RECIPIENT` do map, but `COURIER_CANNOT_ASSERT` still refuses
to apply them automatically: those two decide whether money is owed, and a
person confirms them against the statement.

`PARTIALLY_DELIVERED` is deliberately `null` until Stage 9 — a partial
delivery needs the amount actually collected, and guessing it would settle
the wrong figure.

### Turning it on

The adapter registers itself only when every required variable is set;
otherwise the provider stays manual rather than failing at the first call.

```
LOGESTECHS_EMAIL=
LOGESTECHS_PASSWORD=
LOGESTECHS_COMPANY_ID=
LOGESTECHS_SENDER_NAME=
LOGESTECHS_SENDER_PHONE=
LOGESTECHS_SENDER_BUSINESS=      # optional
LOGESTECHS_ORIGIN_ADDRESS=
LOGESTECHS_ORIGIN_ADDRESS2=      # optional
LOGESTECHS_ORIGIN_CITY_ID=       # from GET /addresses/cities
LOGESTECHS_SERVICE_TYPE_ID=      # optional, as their account was set up
LOGESTECHS_VEHICLE_TYPE_ID=      # optional
LOGESTECHS_PARCEL_TYPE_ID=       # optional
LOGESTECHS_BASE_URL=             # optional override
```

Then set the provider's `code` to `LOGESTECHS` and turn `apiEnabled` on for
it. Until someone does both, it is handled manually.

### Statuses: the API, not a webhook

There is no webhook. The owner cancelled it on 2/11 («الغي الويب هوك»): the
worker polls `GET /guests/packages/status` per barcode
(`jobs/definitions/sync-courier-status.ts`) and every word goes through
`apply-event.ts`. `/api/webhooks/couriers/[token]` stays only to answer 410
to a courier that was given the old link; the card that minted it, its route
and its token are gone. The three `DeliveryProvider.webhook*` columns are still
in the schema (no migration with the cancellation) and nothing reads them.

### The courier's city id for a governorate

Their API field is `cityId`, and Basha works at region level
(«دمشق - دمشق - دمشق» is intended). The number sent for a parcel is, in this
order (`city-id.ts`, used by the press, the warning before it and the Excel
file alike):

1. the number **typed** on the fees screen («رمزها عند الشركة») — it wins, except
   a number their list holds as a Region Id and as no city's (3003 for السويداء,
   `places.ts` `isRegionIdOnly`): that is not a place a parcel can go to, so it
   counts as not typed and the box says the system ignores it. A number the
   list does not know at all, and any number for a courier we hold no list for,
   still wins;
2. else the courier's **own list** (`reference/couriers/basha-villages.json`,
   read by `places.ts`): within their region of the same name, the city named
   like the governorate («السويداء» 445153, not «مدينة السويداء» 566117), else
   «مدينة <governorate>» (دير الزور: the one built as a placeholder, 949546),
   else the governorate's only city — spelling folded (إدلب = ادلب), exact
   equality, never a guess;
3. else nothing, and the press refuses the parcel by name (`NO_COURIER_CITY`).
