import {
  permissionDefinitions,
  systemPermissionProfiles,
} from '../modules/permissions/permission.registry';
import type { Migration } from './migration.types';

export const migration005Stage4AccessControlIndexes: Migration = {
  id: '005-stage4-access-control-indexes',
  description: 'Create Stage 4 access-control indexes and seed permission registry projection',
  async up(db) {
    await db.collection('permission_definitions').createIndexes([
      { key: { key: 1 }, unique: true, name: 'permission_definitions_key_unique' },
      { key: { state: 1, module: 1, category: 1 }, name: 'permission_definitions_state_module' },
    ]);

    await db.collection('permission_profiles').createIndexes([
      {
        key: { context: 1, roleKey: 1 },
        unique: true,
        partialFilterExpression: {
          context: 'PLATFORM',
          status: 'ACTIVE',
          isSystemDefault: true,
          roleKey: { $type: 'string' },
        },
        name: 'permission_profiles_platform_system_role_unique',
      },
      {
        key: { context: 1, workspaceId: 1, roleKey: 1 },
        unique: true,
        partialFilterExpression: {
          context: 'WORKSPACE',
          status: 'ACTIVE',
          isSystemDefault: true,
          roleKey: { $type: 'string' },
        },
        name: 'permission_profiles_workspace_system_role_unique',
      },
      {
        key: { context: 1, workspaceId: 1, name: 1 },
        unique: true,
        partialFilterExpression: { context: 'WORKSPACE', status: 'ACTIVE' },
        name: 'permission_profiles_workspace_name_unique',
      },
      {
        key: { context: 1, name: 1 },
        unique: true,
        partialFilterExpression: { context: 'PLATFORM', status: 'ACTIVE' },
        name: 'permission_profiles_platform_name_unique',
      },
      {
        key: { context: 1, workspaceId: 1, status: 1 },
        name: 'permission_profiles_context_workspace_status',
      },
    ]);

    await db.collection('access_grants').createIndexes([
      {
        key: {
          context: 1,
          workspaceId: 1,
          subjectType: 1,
          subjectId: 1,
          permission: 1,
          'scope.type': 1,
          'scope.resourceIds': 1,
        },
        unique: true,
        name: 'access_grants_logical_unique',
      },
      {
        key: { context: 1, workspaceId: 1, subjectType: 1, subjectId: 1, permission: 1 },
        name: 'access_grants_subject_permission',
      },
      { key: { expiresAt: 1 }, name: 'access_grants_expires_at' },
    ]);

    await db
      .collection('platform_memberships')
      .updateMany({ accessVersion: { $exists: false } }, { $set: { accessVersion: 0 } });
    await db
      .collection('workspace_memberships')
      .updateMany({ accessVersion: { $exists: false } }, { $set: { accessVersion: 0 } });

    const now = new Date();
    const knownKeys = permissionDefinitions.map((definition) => definition.key);
    for (const definition of permissionDefinitions) {
      await db.collection('permission_definitions').updateOne(
        { key: definition.key },
        {
          $set: { ...definition, state: 'ACTIVE', updatedAt: now },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      );
    }
    await db
      .collection('permission_definitions')
      .updateMany(
        { key: { $nin: knownKeys }, state: 'ACTIVE' },
        { $set: { state: 'DEPRECATED', deprecatedAt: now, updatedAt: now } },
      );

    const workspaceIds = await db
      .collection('workspaces')
      .find({}, { projection: { _id: 1 } })
      .toArray();
    for (const profile of systemPermissionProfiles) {
      const profileTargets =
        profile.context === 'WORKSPACE'
          ? workspaceIds.map((workspace) => ({ workspaceId: workspace._id }))
          : [{ workspaceId: undefined }];
      for (const target of profileTargets) {
        const workspaceId = target.workspaceId;
        await db.collection('permission_profiles').updateOne(
          {
            context: profile.context,
            ...(workspaceId ? { workspaceId } : {}),
            roleKey: profile.roleKey,
            isSystemDefault: true,
          },
          {
            $set: {
              name: profile.name,
              permissions: profile.permissions,
              status: 'ACTIVE',
              updatedAt: now,
            },
            $setOnInsert: {
              context: profile.context,
              ...(workspaceId ? { workspaceId } : {}),
              roleKey: profile.roleKey,
              isSystemDefault: true,
              version: 0,
              createdAt: now,
            },
          },
          { upsert: true },
        );
      }
    }

    const platformSuperAdmin = await db.collection('permission_profiles').findOne({
      context: 'PLATFORM',
      roleKey: 'PLATFORM_SUPER_ADMIN',
      isSystemDefault: true,
      status: 'ACTIVE',
    });
    if (platformSuperAdmin?._id) {
      await db.collection('platform_memberships').updateMany(
        { status: 'ACTIVE', permissionProfileIds: { $size: 0 } },
        {
          $addToSet: { permissionProfileIds: platformSuperAdmin._id },
          $set: { updatedAt: now },
        },
      );
    }

    const workspaceProfiles = await db
      .collection('permission_profiles')
      .find({
        context: 'WORKSPACE',
        isSystemDefault: true,
        status: 'ACTIVE',
        workspaceId: { $exists: true },
        roleKey: { $exists: true },
      })
      .toArray();
    for (const profile of workspaceProfiles) {
      await db.collection('workspace_memberships').updateMany(
        {
          workspaceId: profile.workspaceId,
          status: 'ACTIVE',
          roles: profile.roleKey,
          permissionProfileIds: { $size: 0 },
        },
        {
          $addToSet: { permissionProfileIds: profile._id },
          $set: { updatedAt: now },
        },
      );
    }
  },
};
