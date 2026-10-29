<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

---

# Zaki ecosystem — how work is done here

> Everything below is BELOW the generated block above. `next dev` rewrites
> that block; anything written inside it is lost on the next run.

## The owner's rules

- **Never push to `main`.** Every change, even one line, goes on a branch
  with a PR, and is merged only when CI is green.
- **One agent per branch.** Two agents on one branch is a merge conflict
  nobody asked for.
- **Work only on `iahmed30004000-wq/zaki-ai-OSM`** (git remote `osm`). Branches
  and PRs happen there. `MKory18/Zaki-ai-CRM` and `MKory18/zaki-ai-OSM-1` are
  older copies: no work happens on them.
- **A merge is not a deploy.** Auto-deploy is off on every Coolify app
  («Manual deployments only»). A deploy is the owner's own «Redeploy» click
  after he has checked; nobody else presses it. Never push to the `coolify`
  remote, and never force-push.
- **The older copies move only when the owner says so** — fast-forward to the
  same `main` commit. Never commit on them.
- **No customer data to any external model.** A name, a phone or an address
  may only reach a model running on the owner's own machine — see
  `localOnly` below. Ad tokens reach no model at all.
- **Never accept a database reset.** If `prisma migrate dev` or any tool offers to reset, drop or wipe a database, answer no, STOP and report. A new migration is written by hand, applied with `prisma db execute`, and recorded with `prisma migrate resolve --applied`.
- **Definition of Done before any work.** Every task starts with a DEFINITION OF DONE at the top of its PR — what must work · the tests · the edge cases that matter · the blockers. Reviews check against it and nothing else. Anything noticed outside it goes to `BACKLOG_P2.md` («من المراجعات») and is not fixed in the same PR. When every item is met and no blocker exists, stop. Fixed blockers in every task: CI red or an old test red · money arithmetic changed · order creation changed · customer data to an external model · a secret exposed · a destructive migration or a production write · a published contract broken · a feature removed instead of marked. At most two review rounds: «شيك» → fix the blockers only → a last «شيك» on those blockers.

## The repositories

| Repository | Role |
|---|---|
| `iahmed30004000-wq/zaki-ai-OSM` | **the source of truth** — branches and PRs happen here (remote `osm`). CI builds the image `ghcr.io/iahmed30004000-wq/zaki-ai-crm:main`; Coolify does not deploy it by itself |
| `MKory18/Zaki-ai-CRM` | older copy (remote `origin`) — no work happens here |
| `MKory18/zaki-ai-OSM-1` | older copy (remote `coolify`) — deploys nothing; fast-forward only when the owner says so |

Deploys are manual: after a merge the owner checks, then presses «Redeploy» in
Coolify. See `docs/ops/DEPLOY.md`. The map of the code is in
`docs/ARCHITECTURE.md`.

## System 7 — the replies system

`MKory18/AIresponse` consumes this repository's six app events
(`src/lib/apps/events.ts`) through a signed webhook. Its contract is copied
verbatim into `contracts/oms-app-events.v1/` and is **never edited here** —
see `contracts/README.md`.

- Envelope: `{ event, at, data }`, literal. A new field at that level is v2.
- Inside `data`: adding an optional field is allowed; removing, renaming or
  retyping one is v2.
- Headers: `X-Zaki-Event` · `X-Zaki-Delivery` · `X-Zaki-Timestamp`
  (milliseconds) · `X-Zaki-Signature` = `sha256=<HMAC-SHA256(secret,
  "<timestamp>.<body>")>`.
- Enforced by `src/lib/apps/events.test.ts` («the contract the replies
  system reads») and `src/lib/apps/events-sites.test.ts`.

## Local-only AI

`aiChat({ localOnly: true })` throws `AiNotLocal` **before any network
call** when the route is not `LOCAL`. The order-intake door
(`/api/orders/ai-intake`) sets it, because the text a seller pastes carries
the customer's name, phone and address. When it refuses, the deterministic
parser does the work and the screen says why.

## Who owns what

The storefront overhaul owns its own branch and these paths — another
agent's work, not to be touched outside it:

`docs/storefront/**` · `src/app/s/**` · `src/app/lp/**` ·
`src/components/storefront/**` · `src/components/landing/**` ·
`src/components/landing-editor/**` · `src/components/store/**` ·
the `/store/*` screens · the store and landing libraries.

