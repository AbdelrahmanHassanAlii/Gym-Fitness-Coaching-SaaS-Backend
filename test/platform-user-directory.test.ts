import { describe, expect, spyOn, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { UserStatuses } from '../src/modules/identity/identity.types';
import { PlatformMembershipStatuses } from '../src/modules/platform/platform.types';
import type { PlatformUserRow } from '../src/modules/platform-users/platform-user.types';
import {
  allowed,
  assertUserReadAuthority,
  assertUserSupportDenial,
  member,
  summaryGet,
  userReadHarness,
} from './platform-user-read.helpers';

const harness = userReadHarness('platform_user_directory');
const base = '/api/v1/platform/users';
type DirectoryEnvelope = {
  data: PlatformUserRow[];
  meta: { nextCursor: string | null; hasMore: boolean };
};

describe('Platform user directory', () => {
  test('existing Platform authority, MFA, unrestricted session and no role inference', async () => {
    await assertUserReadAuthority(harness(), base);
  });
  test('explicit support deny precedes authorization and service lookup', async () => {
    await assertUserSupportDenial(harness(), base);
  });
  test('defensive service boundary rejects support before any repository call', async () => {
    const h = harness();
    const list = spyOn(h.container.platformUsers, 'directory');
    const authorize = spyOn(h.container.accessControl, 'authorize');
    try {
      await expect(
        h.container.platformUsers.directory(
          {
            correlationId: 'support',
            ipAddress: '127.0.0.1',
            locale: 'en',
            timezone: 'UTC',
            supportSessionId: 'support',
          },
          {},
        ),
      ).rejects.toMatchObject({ code: 'SUPPORT_ACCESS_FORBIDDEN', httpStatus: 403 });
      expect(authorize).not.toHaveBeenCalled();
    } finally {
      list.mockRestore();
      authorize.mockRestore();
    }
  });
  test('all canonical statuses, derived/absent identity and exact minimized rows', async () => {
    const h = harness();
    const actor = await allowed(h);
    const targets = [];
    for (const status of UserStatuses)
      targets.push(
        await member(h, {
          status,
          membershipStatus: 'ENDED',
          ...(status === 'LOCKED' ? { firstName: ' ', lastName: ' ', email: null } : {}),
        }),
      );
    const response = await summaryGet(h.app, `${base}?platformMembershipStatus=ENDED`, actor.token);
    expect(response.statusCode).toBe(200);
    const rows = response.json().data;
    expect(rows).toHaveLength(5);
    expect(rows.map((row: { status: string }) => row.status).sort()).toEqual(
      [...UserStatuses].sort(),
    );
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        row.status === 'LOCKED'
          ? ['createdAt', 'id', 'platformMembership', 'status']
          : ['createdAt', 'displayName', 'email', 'id', 'platformMembership', 'status'],
      );
      expect(row.platformMembership).toEqual({ status: 'ENDED' });
      if (row.status !== 'LOCKED') expect(row.displayName).toBe('Hassan Member');
    }
    expect(response.body).not.toContain('NEVER-EXPOSE');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(targets).toHaveLength(5);
  });
  test('exact email/ID search, normalization, absence, filter and cursor semantics', async () => {
    const h = harness();
    const actor = await allowed(h);
    const target = await member(h, { email: 'Member@Example.com', membershipStatus: 'SUSPENDED' });
    const outside = await member(h, { membership: false });
    for (const q of [
      'member@example.com',
      '  MEMBER@EXAMPLE.COM  ',
      target.userId.toHexString(),
      target.userId.toHexString().toUpperCase(),
    ]) {
      const response = await summaryGet(h.app, `${base}?q=${encodeURIComponent(q)}`, actor.token);
      expect(response.statusCode).toBe(200);
      expect(response.json().data.map((row: { id: string }) => row.id)).toEqual([
        target.userId.toHexString(),
      ]);
      expect(response.json().meta).toEqual({ nextCursor: null, hasMore: false });
      expect(response.json().data[0].email).toBe('Member@Example.com');
    }
    for (const q of [
      outside.userId.toHexString(),
      `member-${outside.userId}@example.com`,
      new ObjectId().toHexString(),
      'missing@example.com',
    ]) {
      expect(
        (await summaryGet(h.app, `${base}?q=${encodeURIComponent(q)}`, actor.token)).json().data,
      ).toEqual([]);
    }
    const q = target.userId.toHexString();
    expect(
      (
        await summaryGet(h.app, `${base}?q=${q}&platformMembershipStatus=SUSPENDED`, actor.token)
      ).json().data,
    ).toHaveLength(1);
    expect(
      (
        await summaryGet(h.app, `${base}?q=${q}&platformMembershipStatus=ACTIVE`, actor.token)
      ).json().data,
    ).toEqual([]);
    expect(
      (await summaryGet(h.app, `${base}?q=${q}&cursor=${target.membershipId}`, actor.token)).json()
        .data,
    ).toEqual([]);
    expect(
      (
        await summaryGet(h.app, `${base}?q=${q}&cursor=ffffffffffffffffffffffff`, actor.token)
      ).json().data,
    ).toHaveLength(1);
    for (const invalid of ['Hassan', 'member@', 'member', '^member', '+201000000000']) {
      const response = await summaryGet(
        h.app,
        `${base}?q=${encodeURIComponent(invalid)}`,
        actor.token,
      );
      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe('PLATFORM_USER_SEARCH_INVALID');
    }
  });
  test('each exact membership status filter and unknown query rejection', async () => {
    const h = harness();
    const actor = await allowed(h);
    for (const status of PlatformMembershipStatuses) await member(h, { membershipStatus: status });
    for (const status of PlatformMembershipStatuses) {
      const response = await summaryGet(
        h.app,
        `${base}?platformMembershipStatus=${status}`,
        actor.token,
      );
      expect(response.statusCode).toBe(200);
      expect(response.json().data.length).toBeGreaterThan(0);
      expect(
        response
          .json()
          .data.every(
            (row: { platformMembership: { status: string } }) =>
              row.platformMembership.status === status,
          ),
      ).toBe(true);
    }
    for (const query of [
      'status=ACTIVE',
      'platformMembershipStatus=ARCHIVED',
      'limit=101',
      'limit=0',
      'limit=1.5',
      'limit=no',
      'offset=1',
      `q=${'a'.repeat(255)}`,
    ]) {
      expect((await summaryGet(h.app, `${base}?${query}`, actor.token)).statusCode).toBe(400);
    }
    for (const cursor of ['', 'invalid', 'ABCDEFABCDEFABCDEFABCDEF']) {
      const response = await summaryGet(h.app, `${base}?cursor=${cursor}`, actor.token);
      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe('CURSOR_INVALID');
    }
  });
  test('default/max limits and eligible keyset paging survive dangling references', async () => {
    const h = harness();
    const actor = await allowed(h);
    const targets = [];
    for (let i = 1; i <= 105; i++) {
      targets.push(
        await member(h, {
          membershipId: new ObjectId(i.toString(16).padStart(24, '0')),
          membershipStatus: 'ENDED',
          userId: new ObjectId((1000 - i).toString(16).padStart(24, '0')),
        }),
      );
    }
    for (const id of [106, 104, 51, 1])
      await h.db.collection('platform_memberships').insertOne({
        _id: new ObjectId((id * 1000).toString(16).padStart(24, '0')),
        userId: new ObjectId(),
        status: 'ENDED',
      });
    const filter = `${base}?platformMembershipStatus=ENDED`;
    expect((await summaryGet(h.app, filter, actor.token)).json().data).toHaveLength(50);
    expect((await summaryGet(h.app, `${filter}&limit=100`, actor.token)).json().data).toHaveLength(
      100,
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await summaryGet(
        h.app,
        `${filter}&limit=7${cursor ? `&cursor=${cursor}` : ''}`,
        actor.token,
      );
      expect(response.statusCode).toBe(200);
      const body: DirectoryEnvelope = response.json();
      seen.push(...body.data.map((row: { id: string }) => row.id));
      cursor = body.meta.nextCursor;
      expect(body.meta.hasMore).toBe(cursor !== null);
      if (cursor) {
        const last = targets.find((target) => target.userId.toHexString() === body.data.at(-1)?.id);
        if (!last) throw new Error('Cursor row missing from eligible fixtures.');
        expect(cursor).toBe(last.membershipId.toHexString());
      }
    } while (cursor);
    expect(seen).toEqual(targets.reverse().map((target) => target.userId.toHexString()));
    expect(new Set(seen).size).toBe(105);
  }, 30_000);
  test('unfiltered paging includes all membership states, excludes all-system accounts', async () => {
    const h = harness();
    const actor = await allowed(h);
    for (const status of PlatformMembershipStatuses) await member(h, { membershipStatus: status });
    const outside = await member(h, { membership: false });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const body: DirectoryEnvelope = (
        await summaryGet(h.app, `${base}?limit=1${cursor ? `&cursor=${cursor}` : ''}`, actor.token)
      ).json();
      seen.push(...body.data.map((row: { id: string }) => row.id));
      cursor = body.meta.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(4);
    expect(seen).not.toContain(outside.userId.toHexString());
    const expected = await h.db
      .collection('platform_memberships')
      .find({})
      .sort({ _id: -1 })
      .toArray();
    expect(seen).toEqual(expected.map((row) => row.userId.toHexString()));
  });
});
