import {
  permissionDefinitions,
  systemPermissionProfiles,
} from '../modules/permissions/permission.registry';
import type { Migration } from './migration.types';

const stage15PermissionKeys = new Set([
  'audit.workspace.read',
  'audit.platform.read',
  'audit.sensitive.read',
]);

export const migration020Stage15Audit: Migration = {
  id: '020-stage15-audit',
  description: 'Add Stage 15 audit query indexes and permission seeds',
  async up(db) {
    await db.collection('audit_events').createIndexes([
      {
        key: { workspaceId: 1, occurredAt: -1, _id: -1 },
        name: 'audit_workspace_cursor',
      },
      {
        key: { occurredAt: -1, _id: -1 },
        name: 'audit_platform_cursor',
      },
      {
        key: { workspaceId: 1, eventType: 1, occurredAt: -1, _id: -1 },
        name: 'audit_workspace_event_type_cursor',
      },
      {
        key: { 'actor.userId': 1, occurredAt: -1, _id: -1 },
        name: 'audit_actor_cursor',
      },
      {
        key: { 'entity.type': 1, 'entity.id': 1, occurredAt: -1, _id: -1 },
        name: 'audit_entity_cursor',
      },
    ]);

    const now = new Date();
    for (const definition of permissionDefinitions.filter((item) =>
      stage15PermissionKeys.has(item.key),
    )) {
      await db.collection('permission_definitions').updateOne(
        { key: definition.key },
        {
          $set: { ...definition, state: 'ACTIVE', updatedAt: now },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      );
    }

    const workspaceIds = await db
      .collection('workspaces')
      .find({}, { projection: { _id: 1 } })
      .toArray();

    for (const profile of systemPermissionProfiles) {
      const permissions = profile.permissions.filter((permission) =>
        stage15PermissionKeys.has(permission.permission),
      );
      if (permissions.length === 0) continue;

      if (profile.context === 'PLATFORM') {
        await db.collection('permission_profiles').updateOne(
          {
            context: profile.context,
            roleKey: profile.roleKey,
            isSystemDefault: true,
          },
          {
            $set: { name: profile.name, status: 'ACTIVE', updatedAt: now },
            $addToSet: { permissions: { $each: permissions } },
          },
        );
        continue;
      }

      for (const workspace of workspaceIds) {
        await db.collection('permission_profiles').updateOne(
          {
            context: profile.context,
            workspaceId: workspace._id,
            roleKey: profile.roleKey,
            isSystemDefault: true,
          },
          {
            $set: { name: profile.name, status: 'ACTIVE', updatedAt: now },
            $addToSet: { permissions: { $each: permissions } },
          },
        );
      }
    }
  },
};
