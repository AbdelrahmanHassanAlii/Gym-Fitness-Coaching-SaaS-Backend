import { expect, test } from 'bun:test';
import { type Document, ObjectId } from 'mongodb';
import { verifyPlatformUserPlans } from '../scripts/verify-platform-user-directory-plans';
import { PlatformUserRepository } from '../src/modules/platform-users/platform-user.repository';
import { summaryHarness } from './platform-workspace-summary.helpers';

test('real Mongo plans and skewed multi-page fixtures including dangling accounts', async () => {
  const h = await summaryHarness('platform_user_plans');
  try {
    const users: Document[] = [];
    const memberships: Document[] = [];
    const now = new Date();
    const expected: string[] = [];
    for (let i = 1; i <= 1500; i++) {
      const id = new ObjectId(i.toString(16).padStart(24, '0'));
      const userId = new ObjectId((10000 - i).toString(16).padStart(24, '0'));
      const status = i % 20 === 0 ? 'ENDED' : i % 20 < 5 ? 'SUSPENDED' : 'ACTIVE';
      memberships.push({ _id: id, userId, status, createdAt: now, updatedAt: now });
      if (i % 47 === 0 || i === 1500) continue;
      expected.unshift(userId.toHexString());
      users.push({
        _id: userId,
        firstName: 'Plan',
        lastName: String(i),
        email: `plan-${i}@example.com`,
        normalizedEmail: `plan-${i}@example.com`,
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });
    }
    await h.db.collection('users').insertMany(users);
    await h.db.collection('platform_memberships').insertMany(memberships);
    const before = await h.snapshot();
    await verifyPlatformUserPlans(h.db);
    expect(await h.snapshot()).toEqual(before); // The verifier performs no writes.
    const repo = new PlatformUserRepository(h.container.database);
    const seen: string[] = [];
    let afterId: ObjectId | undefined;
    while (true) {
      const rows = await repo.list({ limit: 50, ...(afterId ? { afterId } : {}) });
      const page = rows.slice(0, 50);
      seen.push(...page.map((row) => row.user._id.toHexString()));
      if (rows.length <= 50) break;
      afterId = page.at(-1)?._id;
    }
    expect(seen).toEqual(expected);
  } finally {
    await h.close();
  }
}, 60_000);
