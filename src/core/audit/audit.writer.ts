import type { Collection } from 'mongodb';
import { ObjectId } from 'mongodb';
import type { Database } from '../database/database';
import type { TransactionContext } from '../database/unit-of-work';
import type { AuditEventInput } from './audit.types';

interface AuditEventDocument extends AuditEventInput {
  occurredAt: Date;
}

export class AuditWriter {
  private readonly collection: Collection<AuditEventDocument>;

  constructor(database: Database) {
    this.collection = database.db.collection<AuditEventDocument>('audit_events');
  }

  async write(input: AuditEventInput, tx?: TransactionContext): Promise<void> {
    const redacted = redactAuditValue(input) as AuditEventInput;
    const document: AuditEventDocument = {
      ...redacted,
      occurredAt: input.occurredAt ?? new Date(),
    };

    await this.collection.insertOne(document, tx ? { session: tx.session } : undefined);
  }

  async writeSensitiveResourceAccess(
    input: Omit<AuditEventInput, 'eventType' | 'action' | 'sensitive'> & {
      resourceType: string;
      resourceId: ObjectId | string;
      accessKind: string;
    },
    tx?: TransactionContext,
  ): Promise<void> {
    await this.write(
      {
        ...input,
        eventType: 'SENSITIVE_RESOURCE_ACCESSED',
        action: 'read',
        sensitive: true,
        entity: { type: input.resourceType, id: input.resourceId },
        after: {
          resourceType: input.resourceType,
          resourceId:
            input.resourceId instanceof ObjectId
              ? input.resourceId.toHexString()
              : input.resourceId,
          accessKind: input.accessKind,
        },
      },
      tx,
    );
  }
}

const secretKeyPattern =
  /^(password|passwordhash|authorization|access.?token|refresh.?token|otp|mfa.*secret|totp|invitation.*token|activation.*token|reset.*token|provider.*(api.?key|secret|credential)|api.?key|secret.?key|push.?token|token)$/i;

const signedUrlPattern =
  /(x-amz-signature|x-amz-credential|x-amz-security-token|awsaccesskeyid|signature=|presigned|signed|[?&](token|access_token|refresh_token|resetToken|invitationToken|activationToken)=)/i;

function redactAuditValue(value: unknown, key?: string): unknown {
  if (key && secretKeyPattern.test(key)) return '[REDACTED]';
  if (value instanceof Date || value instanceof ObjectId) return value;
  if (typeof value === 'string') {
    if (signedUrlPattern.test(value)) return '[REDACTED]';
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redactAuditValue(item));
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
      entryKey,
      redactAuditValue(entryValue, entryKey),
    ]),
  );
}
