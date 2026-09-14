import {
  permissionDefinitions,
  systemPermissionProfiles,
} from '../modules/permissions/permission.registry';
import type { Migration } from './migration.types';

const stage13PermissionKeys = new Set([
  'documents.upload',
  'documents.delete',
  'files.download',
  'files.delete',
  'files.restore',
  'medical_documents.upload',
  'medical_documents.download',
]);

export const migration018Stage13FilesDocuments: Migration = {
  id: '018-stage13-files-documents',
  description: 'Create Stage 13 file/document collections, indexes, and permission seeds',
  async up(db) {
    await db.collection('upload_intents').createIndexes([
      { key: { workspaceId: 1, status: 1, expiresAt: 1 }, name: 'upload_intent_workspace_status' },
      { key: { expiresAt: 1 }, name: 'upload_intent_expiry' },
      {
        key: { storageProvider: 1, storageKey: 1 },
        unique: true,
        name: 'upload_intents_storage_key_unique',
      },
      {
        key: { status: 1, orphanCleanupStatus: 1, expiresAt: 1 },
        name: 'upload_intents_orphan_cleanup',
      },
    ]);

    await db.collection('files').createIndexes([
      {
        key: { storageProvider: 1, storageKey: 1 },
        unique: true,
        name: 'files_storage_key_unique',
      },
      { key: { uploadIntentId: 1 }, unique: true, name: 'files_upload_intent_unique' },
      { key: { workspaceId: 1, status: 1, _id: 1 }, name: 'files_workspace_status' },
      { key: { workspaceId: 1, createdAt: -1, _id: -1 }, name: 'files_workspace_created' },
      { key: { status: 1, purgeEligibleAt: 1, _id: 1 }, name: 'files_purge_queue' },
      { key: { workspaceId: 1, subjectType: 1, subjectId: 1 }, name: 'files_subject_lookup' },
    ]);

    await db.collection('documents').createIndexes([
      { key: { fileId: 1 }, unique: true, name: 'documents_file_unique' },
      {
        key: { relationshipId: 1, category: 1, createdAt: -1, _id: -1 },
        name: 'documents_relationship_category_history',
      },
      {
        key: { workspaceId: 1, relationshipId: 1, status: 1, createdAt: -1, _id: -1 },
        name: 'documents_workspace_relationship_history',
      },
    ]);

    const now = new Date();
    for (const definition of permissionDefinitions.filter((item) =>
      stage13PermissionKeys.has(item.key),
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
      if (profile.context !== 'WORKSPACE') continue;
      const permissions = profile.permissions.filter((permission) =>
        stage13PermissionKeys.has(permission.permission),
      );
      if (permissions.length === 0) continue;
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
