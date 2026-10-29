import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });

/**
 * KEPT ON `globalThis` IN PRODUCTION TOO (RV187).
 *
 * This line was `if (NODE_ENV !== 'production')`, on the reasoning that the
 * global exists to survive hot reloads, which production does not have. But
 * a production build evaluates this module once per BUNDLE — the proxy, the
 * route layers, the server-rendered pages each got their own copy — so the
 * site opened three or four clients, and every client opens a pool of its
 * own (up to ten connections). Nothing grew over time, but the database was
 * holding several times the connections it was being used for. `globalThis`
 * is shared across those copies; one client, one pool.
 */
globalForPrisma.prisma = db;

export default db;
