import { PrismaClient } from '@prisma/client';
import { withHeavyPool, withPoolFloor } from './db-url';
import { inHeavyLane } from './heavy-lane';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  prismaReports: PrismaClient | undefined;
  prismaDb: PrismaClient | undefined;
};

const main =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    // At least twenty connections, whatever the URL says (`db-url.ts`).
    datasourceUrl: withPoolFloor(process.env.DATABASE_URL),
  });

/**
 * THE REPORTS' OWN CLIENT — six connections, a long wait (`HEAVY_POOL` in `db-url.ts`).
 *
 * BUILT THE FIRST TIME A REPORT ASKS, not when the module loads: the worker, the middleware and every request that never runs a report
 * build nothing, and `one-client-one-pool.test.ts` (RV187) still holds — evaluating this module builds ONE client. It lives on
 * `globalThis` like the main one, so a second bundle's copy of this file finds it and builds no other. What runs on it is decided by
 * `runInHeavyLane` (`heavy-lane.ts`); see there for the measured cause.
 */
function reportsClient(): PrismaClient {
  return (globalForPrisma.prismaReports ??= new PrismaClient({
    log: ['error'],
    datasourceUrl: withHeavyPool(process.env.DATABASE_URL),
  }));
}

/**
 * ONE `db` FOR EVERYBODY, TWO CLIENTS BEHIND IT.
 *
 * Every file keeps writing `db.order.findMany(...)`. The proxy picks the client at the moment a property is read: inside a report
 * (`inHeavyLane()`) the reports' client, everywhere else the main one — so no caller changed, and the type is still `PrismaClient`.
 * Methods are bound to the client they were read from, so `db.$transaction(...)` runs on the same client as the models around it.
 *
 * THE PROXY IS KEPT ON `globalThis` TOO: a second copy of this module hands out the SAME object, as it did when `db` was the client
 * itself (`one-client-one-pool.test.ts`). The lane's marker (`heavy-lane.ts`) is on `globalThis` for the same reason, so a proxy
 * made by one bundle reads the mark that another bundle's route wrote.
 */
export const db: PrismaClient =
  globalForPrisma.prismaDb ??
  new Proxy(main, {
    get(_target, prop) {
      const client = inHeavyLane() ? reportsClient() : main;
      const value = Reflect.get(client, prop, client);
      return typeof value === 'function' ? value.bind(client) : value;
    },
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
globalForPrisma.prisma = main;
globalForPrisma.prismaDb = db;

export default db;
