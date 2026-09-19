import {
  permissionDefinitions,
  systemPermissionProfiles,
} from '../modules/permissions/permission.registry';
import type { Migration } from './migration.types';

const stage17PermissionKeys = new Set([
  'exports.workspace.create',
  'exports.workspace.read',
  'exports.workspace.download',
  'deletion.read',
  'deletion.approve',
  'deletion.postpone',
  'deletion.cancel',
]);

export const migration022Stage17RetentionExportDeletion: Migration = {
  id: '022-stage17-retention-export-deletion',
  description: 'Add Stage 17 retention, export, deletion collections, indexes, and permissions',
  async up(db) {
    await db.collection('workspace_export_requests').createIndexes([
      {
        key: { workspaceId: 1, requestedByUserId: 1 },
        unique: true,
        partialFilterExpression: { status: { $in: ['PENDING', 'PROCESSING', 'READY'] } },
        name: 'workspace_exports_one_active_per_requester',
      },
      { key: { workspaceId: 1, requestedAt: -1, _id: -1 }, name: 'workspace_exports_list' },
      {
        key: { status: 1, processingLeaseExpiresAt: 1, requestedAt: 1, _id: 1 },
        name: 'workspace_exports_generation_scan',
      },
      { key: { status: 1, expiresAt: 1, _id: 1 }, name: 'workspace_exports_expiry_scan' },
      { key: { artifactFileId: 1 }, sparse: true, name: 'workspace_exports_artifact_file' },
    ]);

    await db.collection('workspace_deletion_requests').createIndexes([
      {
        key: { workspaceId: 1 },
        unique: true,
        partialFilterExpression: {
          status: { $in: ['PENDING_APPROVAL', 'POSTPONED', 'APPROVED', 'PROCESSING', 'FAILED'] },
        },
        name: 'workspace_deletions_one_active_per_workspace',
      },
      { key: { createdAt: -1, _id: -1 }, name: 'workspace_deletions_platform_list' },
      { key: { status: 1, reviewAfter: 1, _id: 1 }, name: 'workspace_deletions_review_scan' },
      {
        key: { status: 1, processingLeaseExpiresAt: 1, updatedAt: 1, _id: 1 },
        name: 'workspace_deletions_processing_scan',
      },
      { key: { subscriptionId: 1, createdAt: -1 }, name: 'workspace_deletions_subscription' },
    ]);

    await db.collection('retention_warning_markers').createIndexes([
      {
        key: { subscriptionId: 1, warningOffsetDays: 1, eligibilityAt: 1 },
        unique: true,
        name: 'retention_warning_one_per_expiry_cycle_offset',
      },
      {
        key: { workspaceId: 1, createdAt: -1, _id: -1 },
        name: 'retention_warning_workspace_history',
      },
    ]);

    await db.collection('generated_file_intents').createIndexes([
      { key: { storageKey: 1 }, unique: true, name: 'generated_file_intents_storage_key_unique' },
      {
        key: { workspaceId: 1, purpose: 1, exportId: 1, status: 1 },
        name: 'generated_file_intents_export_status',
      },
      { key: { status: 1, updatedAt: 1, _id: 1 }, name: 'generated_file_intents_cleanup_scan' },
    ]);

    await db
      .collection('files')
      .updateMany({ origin: { $exists: false } }, { $set: { origin: 'USER_UPLOAD' } });

    try {
      await db.collection('files').dropIndex('files_upload_intent_unique');
    } catch {
      // Older local databases may not have the Stage 13 index yet.
    }
    await db.collection('files').createIndexes([
      {
        key: { uploadIntentId: 1 },
        unique: true,
        partialFilterExpression: { origin: 'USER_UPLOAD', uploadIntentId: { $exists: true } },
        name: 'files_upload_intent_unique',
      },
      {
        key: { generatedPurpose: 1, generatedForExportId: 1 },
        unique: true,
        partialFilterExpression: {
          origin: 'SYSTEM_GENERATED',
          generatedPurpose: 'WORKSPACE_EXPORT',
          status: { $in: ['ACTIVE', 'SOFT_DELETED', 'PURGE_PENDING'] },
        },
        name: 'files_generated_export_one_live_artifact',
      },
      {
        key: { origin: 1, generatedPurpose: 1, expiresAt: 1, _id: 1 },
        name: 'files_generated_expiry_scan',
      },
    ]);

    await db.collection('workspaces').createIndexes([
      {
        key: { deletionLockRequestId: 1 },
        sparse: true,
        name: 'workspaces_deletion_lock_request',
      },
    ]);
    await db.collection('subscriptions').createIndexes([
      {
        key: { deletionLockRequestId: 1 },
        sparse: true,
        name: 'subscriptions_deletion_lock_request',
      },
      { key: { lifecycleStatus: 1, expiredAt: 1, _id: 1 }, name: 'subscriptions_retention_scan' },
    ]);

    const now = new Date();
    for (const definition of permissionDefinitions.filter((item) =>
      stage17PermissionKeys.has(item.key),
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

    for (const profile of systemPermissionProfiles) {
      const permissions = profile.permissions.filter((permission) =>
        stage17PermissionKeys.has(permission.permission),
      );
      if (permissions.length === 0) continue;
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
    }
  },
};
