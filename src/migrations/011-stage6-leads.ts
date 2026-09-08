import {
  permissionDefinitions,
  systemPermissionProfiles,
} from '../modules/permissions/permission.registry';
import type { Migration } from './migration.types';

const stage6PermissionKeys = new Set(['leads.mark_duplicate', 'leads.merge']);
const stage6ProfileKeys = new Set(['PLATFORM_SUPER_ADMIN', 'SALES_LEAD_ADMIN']);

export const migration011Stage6Leads: Migration = {
  id: '011-stage6-leads',
  description: 'Create Stage 6 lead indexes and seed lead permissions',
  async up(db) {
    await db.collection('leads').createIndexes([
      { key: { status: 1, createdAt: -1 }, name: 'leads_status_created' },
      { key: { normalizedPhone: 1 }, name: 'leads_normalized_phone' },
      { key: { normalizedEmail: 1 }, name: 'leads_normalized_email' },
    ]);

    const now = new Date();
    for (const definition of permissionDefinitions.filter((item) =>
      stage6PermissionKeys.has(item.key),
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

    for (const profile of systemPermissionProfiles.filter((item) =>
      stage6ProfileKeys.has(item.roleKey),
    )) {
      await db.collection('permission_profiles').updateOne(
        {
          context: profile.context,
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
            roleKey: profile.roleKey,
            isSystemDefault: true,
            version: 0,
            createdAt: now,
          },
        },
        { upsert: true },
      );
    }
  },
};
