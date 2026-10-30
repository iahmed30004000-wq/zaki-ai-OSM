import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * `tenantOf(user)` IS `requireCompanyTenant`'s RULE WITHOUT THE SECOND READ OF THE SESSION (RV183).
 *
 * The company rule is unchanged, line for line: a platform admin falls back to the first company, anybody else must
 * belong to one. What is new is that it takes a user who was already resolved instead of resolving one again.
 */

const { db } = vi.hoisted(() => ({ db: { company: { findFirst: vi.fn() }, user: { findUnique: vi.fn() } } }));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('next/headers', () => ({ cookies: vi.fn() }));

import { tenantOf } from './auth';

const user = (over: Record<string, unknown>) => ({ id: 'u1', role: 'MODERATOR', companyId: 'co1', ...over }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  db.company.findFirst.mockResolvedValue({ id: 'first' });
});

describe('tenantOf', () => {
  it('— a member of a company gets that company, and the database is not asked', async () => {
    const r = await tenantOf(user({}));
    expect(r.companyId).toBe('co1');
    expect(db.company.findFirst).not.toHaveBeenCalled();
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it('— a platform admin with a company keeps it', async () => {
    expect((await tenantOf(user({ role: 'SUPER_ADMIN', companyId: 'mine' }))).companyId).toBe('mine');
  });

  it('— a platform admin with none falls back to the first company', async () => {
    expect((await tenantOf(user({ role: 'SUPER_ADMIN', companyId: null }))).companyId).toBe('first');
  });

  it('— NEGATIVE: a platform admin with none, and no company anywhere, is refused', async () => {
    db.company.findFirst.mockResolvedValue(null);
    await expect(tenantOf(user({ role: 'SUPER_ADMIN', companyId: null }))).rejects.toThrow('No company configured');
  });

  it('— NEGATIVE: anybody else with no company is refused, and never falls back to the first one', async () => {
    await expect(tenantOf(user({ companyId: null }))).rejects.toThrow('no assigned company');
    expect(db.company.findFirst).not.toHaveBeenCalled();
  });

  it('— and `requireCompanyTenant` is nothing but the session read plus this rule: one rule, not two copies', () => {
    const src = stripComments(readFileSync(join(process.cwd(), 'src/lib/auth.ts'), 'utf8'));
    const body = src.slice(src.indexOf('export async function requireCompanyTenant'), src.indexOf('export async function tenantOf'));
    expect(body).toContain('tenantOf(await requireAuth())');
    expect(body).not.toContain('findFirst');
  });
});
