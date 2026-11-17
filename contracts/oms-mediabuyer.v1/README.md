# `oms-mediabuyer.v1` — what the OMS answers the media buyer

**The source of truth is HERE, in the OMS.** The media buyer
(`zaki-mediabuyer`) keeps a verbatim copy in its own `contracts/oms-mediabuyer.v1/`
and tests its adapter against it. A change is made here first, then copied
across unchanged.

| File | What |
|---|---|
| `attribution-page.schema.json` | `GET /api/v1/orders/attribution` — one page `{items, next_cursor}` |
| `attribution-page.example.json` | a golden page |
| `products-page.schema.json` | `GET /api/v1/products?fields=…` — the optional fields the media buyer asks for |
| `products-page.example.json` | a golden catalogue |
| `ad-spend-page.schema.json` | `GET /api/v1/ad-spend` — one page `{items, next_cursor, as_of}`: spend per day per ad (or adset / campaign by `level`) |
| `ad-spend-page.example.json` | a golden page |
| `notify-request.schema.json` · `notify-response.schema.json` (+ examples) | `POST /api/v1/notify` — the one Telegram gateway, scope `notify.send` |
| `stop-event.schema.json` · `stop-event.example.json` | the signed `owner.stop_requested` event the OMS sends the media buyer (through the installed-apps webhooks); `X-Zaki-Timestamp` in SECONDS |

## The rules

- **Read only.** All three endpoints are `GET`; the key's scopes are
  `orders.attribution.read`, `products.read`, `products.costs.read`, `ads.spend.read`, and
  nothing on the path writes (`src/lib/v1/the-media-buyer-cannot-write.test.ts`). The fifth scope,
  `notify.send`, belongs to the message door of the next PR — it is a message, never a write to an order.
- **No customer.** No name, phone, address — not in any field, not under any
  name. `capi_ref` is null or an opaque `enc:` reference, never a readable phone.
- **Bounded.** `updated_since` required and at most 31 days back, `limit` ≤ 200,
  cursor paging, 30 calls a minute on the media buyer's key.
  `ad-spend`: `date_from` and `date_to` required, at most 31 days apart, `limit` ≤ 500, `as_of` = the last pull from Meta
  (the OMS never calls Meta when the media buyer asks).
- **Stopping the key stops it.** A revoked or expired key is refused on the
  next request (401 `TOKEN_INVALID`).
- **v1 grows, never changes.** Adding an optional field is v1 (update the
  schema here, copy it across). Removing, renaming or retyping a field is v2.

## What enforces it

OMS: `src/lib/v1/the-ad-spend-door.test.ts` · `src/lib/v1/the-media-buyers-door.test.ts` (golden files and live
handler answers validate, «the frozen contract») · `the-media-buyer-cannot-write.test.ts`.
Media buyer: `tests/oms-contract.test.ts`.
