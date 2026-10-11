import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { Permissions } from '../src/modules/permissions/permission.registry';
import { WorkspaceStatuses } from '../src/modules/workspaces/workspace.types';
import {
  assertSummaryAuthorization,
  assertSummarySupportDenial,
  type SummaryHarness,
  summaryGet,
  summaryHarness,
} from './platform-workspace-summary.helpers';

describe('Platform workspace live counts', () => {
  let h: SummaryHarness;
  beforeAll(async () => {
    h = await summaryHarness('platform_workspace_counts');
  }, 30_000);
  afterEach(async () => await h.clear());
  afterAll(async () => await h.close());

  test('requires unrestricted MFA Platform management authority, honors DENY, rejects tenant roles', async () => {
    await assertSummaryAuthorization(h, 'counts', Permissions.PlatformWorkspacesManage);
  });

  test('rejects resolved support before authorization or count lookup, with no write residue', async () => {
    await assertSummarySupportDenial(h, 'counts', Permissions.PlatformWorkspacesManage);
  });

  test('counts exact live statuses, owner-only and multi-role staff once, without joins or tenant leakage', async () => {
    const workspaceId = await h.workspace('ARCHIVED');
    const other = await h.workspace();
    const actor = await h.actor(Permissions.PlatformWorkspacesManage);
    await seedMixed(workspaceId);
    await seedMixed(other);
    await h.db
      .collection('workspace_usage')
      .insertOne({ workspaceId, activeStaff: 999, activeTrainees: 999 });
    const before = await h.snapshot();
    const response = await get(workspaceId, actor.token);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json<unknown>()).toEqual({
      data: {
        workspaceId: workspaceId.toHexString(),
        counts: {
          branches: { active: 2 },
          trainees: { active: 2, needsReassignment: 1 },
          staff: { activeIncludingOwners: 5 },
        },
      },
    });
    expect(await h.snapshot()).toEqual(before);
    for (const name of ['branches', 'coaching_relationships', 'workspace_memberships']) {
      await h.db.collection(name).deleteMany({ workspaceId });
    }
    expect((await get(workspaceId, actor.token)).json().data.counts).toEqual(zeroCounts);
    expect(await h.db.collection('branches').countDocuments({ workspaceId: other })).toBe(3);
  });

  test('all five workspace statuses remain readable; empty means zero; missing 404 and malformed 400', async () => {
    const actor = await h.actor(Permissions.PlatformWorkspacesManage);
    for (const status of WorkspaceStatuses) {
      const workspaceId = await h.workspace(status);
      const response = await get(workspaceId, actor.token);
      expect(response.statusCode).toBe(200);
      expect(response.json<unknown>()).toEqual({
        data: { workspaceId: workspaceId.toHexString(), counts: zeroCounts },
      });
    }
    const missing = await get(new ObjectId(), actor.token);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('WORKSPACE_NOT_FOUND');
    expect(
      (await summaryGet(h.app, '/api/v1/platform/workspaces/bad/counts', actor.token)).statusCode,
    ).toBe(400);
  });

  const zeroCounts = {
    branches: { active: 0 },
    trainees: { active: 0, needsReassignment: 0 },
    staff: { activeIncludingOwners: 0 },
  };

  async function get(workspaceId: ObjectId, token: string) {
    return await summaryGet(h.app, `/api/v1/platform/workspaces/${workspaceId}/counts`, token);
  }

  async function seedMixed(workspaceId: ObjectId) {
    await h.db.collection('branches').insertMany(
      ['ACTIVE', 'ACTIVE', 'ARCHIVED'].map((status) => ({
        _id: new ObjectId(),
        workspaceId,
        status,
      })),
    );
    const relationships = [
      'ACTIVE',
      'ACTIVE',
      'NEEDS_REASSIGNMENT',
      'PENDING',
      'ENDED',
      'ARCHIVED',
    ].map((status) => ({
      _id: new ObjectId(),
      workspaceId,
      traineeUserId: new ObjectId(),
      status,
    }));
    await h.db.collection('coaching_relationships').insertMany(relationships);
    const memberships = [
      ...[
        ['GYM_OWNER'],
        ['GYM_MANAGER'],
        ['TRAINER', 'ASSISTANT_TRAINER', 'NUTRITIONIST'],
        ['ASSISTANT_TRAINER'],
        ['NUTRITIONIST'],
        ['TRAINEE'],
      ].map((roles) => ({ roles, status: 'ACTIVE' })),
      ...['INVITED', 'SUSPENDED', 'ENDED', 'ARCHIVED'].map((status) => ({
        roles: ['TRAINER'],
        status,
      })),
    ].map((row) => ({ _id: new ObjectId(), workspaceId, userId: new ObjectId(), ...row }));
    await h.db.collection('workspace_memberships').insertMany(memberships);
    await h.db.collection('membership_branch_assignments').insertMany(
      Array.from({ length: 3 }, () => ({
        _id: new ObjectId(),
        workspaceId,
        membershipId: memberships[0]?._id,
        branchId: new ObjectId(),
        active: true,
      })),
    );
    await h.db.collection('trainee_staff_assignments').insertMany(
      Array.from({ length: 3 }, () => ({
        _id: new ObjectId(),
        workspaceId,
        relationshipId: relationships[0]?._id,
        staffMembershipId: new ObjectId(),
        assignmentType: 'ASSISTANT_TRAINER',
        active: true,
      })),
    );
  }
});
