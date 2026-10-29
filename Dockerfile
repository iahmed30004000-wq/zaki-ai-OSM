# Production Dockerfile for Zaki AI CRM (Next.js standalone + Prisma PostgreSQL)

FROM node:24-alpine AS base

# ========================================
# Dependencies
# ========================================

FROM base AS deps

RUN apk add --no-cache libc6-compat openssl

WORKDIR /app

COPY package.json package-lock.json ./

# Copy Prisma schema BEFORE npm ci because the postinstall hook runs `prisma generate`
COPY prisma ./prisma

RUN npm ci

# ========================================
# Builder
# ========================================

FROM base AS builder

RUN apk add --no-cache libc6-compat openssl

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV JWT_SECRET=build-time-placeholder-secret-value

# prisma generate + next build (via package.json build script)
RUN npm run build

# ========================================
# Production Runner
# ========================================

FROM base AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# `postgresql16-client` is here for the DAILY BACKUP, and it is not optional.
# The scheduled `daily-backup` job shells out to `pg_dump`, and without this
# line the job fails on the first night in production with «command not
# found» — a backup system that has never existed while reporting an error
# nobody reads until the day it is needed. The version matches the
# `postgres:16-alpine` in docker-compose.yml: a client older than the server
# refuses to dump it.
RUN apk add --no-cache libc6-compat openssl postgresql16-client

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy static/public assets
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Copy the standalone server FIRST (it contains its own trimmed node_modules)
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./

# Copy Prisma schema + migrations for `migrate deploy` at container start
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma

# Copy the FULL node_modules (superset of standalone's) so the prisma CLI
# is available for migrations. Copied AFTER standalone on purpose.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules

# The scheduler worker runs from source with tsx (see docker-entrypoint.sh).
# Without these three the image could serve pages but never run a job:
# nothing released held orders, synced couriers, delivered webhooks or sent
# a conversion to Meta, and the jobs screen could only ever show them late.
COPY --from=builder --chown=nextjs:nodejs /app/src ./src
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json

# The two folders the app writes to, owned by the user that runs it:
# uploads (product, landing and font files, payment proofs) and backups
# (`daily-backup` writes `./backups`). /app itself is root's — WORKDIR made
# it — so without the second folder here the nightly job's mkdir fails with
# «permission denied» every night. Each needs a persistent volume in Coolify,
# or a deploy deletes what it holds.
RUN mkdir -p /app/uploads /app/backups && chown -R nextjs:nodejs /app/uploads /app/backups

# Copy entrypoint
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

USER nextjs

EXPOSE 3000

# ── WHETHER THIS CONTAINER IS READY TO BE SENT TRAFFIC ──
#
# What stood here was `CMD wget …/login`, indented, with no HEALTHCHECK
# keyword in front of it. Docker does not read that as a health probe at
# all: it reads it as the container's default COMMAND, and because an
# ENTRYPOINT is set below, the words become ARGUMENTS to the entrypoint
# script — which ends in `exec node server.js` and never looks at "$@". So
# the line ran nothing, probed nothing, and `docker inspect` reported this
# image as having no health check from the day it was written.
#
# The consequence is not the whole of the deploy outage — the site goes
# down in the MIDDLE of the build, minutes before any container is
# swapped — but it is the reason nothing can be done about the swap: an
# orchestrator with no readiness signal can only stop the old container
# and start the new one, and it cannot wait for «ready» because it was
# never told what ready means.
#
# `/api/health` is the route written for this (src/app/api/health/route.ts):
# no session, nothing interpolated into the body, one indexed query at most
# once per five seconds, 200 while the app can do its job and 503 only when
# the database is unreachable. A late worker deliberately does NOT turn it
# red — restarting the website does not fix the worker, and a probe that
# restarts the wrong process manufactures the outage it was added to catch.
#
# --start-period=120s: the entrypoint runs `prisma migrate deploy` before
#   the server listens, and on a server that is also building an image that
#   is the slowest part of the start. Nothing inside this window counts as
#   a failure.
# --interval=30s with the route's own 5-second cache: at most one database
#   query every 30 seconds, which is cheaper than the uptime monitor
#   already polling the same URL.
# --retries=3: a single refused connection during a long migration or a
#   brief database blip is not a dead container. Three in a row is.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
