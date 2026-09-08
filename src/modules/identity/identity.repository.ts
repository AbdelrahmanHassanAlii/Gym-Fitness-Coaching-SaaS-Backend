import { type Collection, MongoServerError, ObjectId } from 'mongodb';
import type { Database } from '../../core/database/database';
import type { TransactionContext } from '../../core/database/unit-of-work';
import { AppError } from '../../core/errors/app-error';
import type {
  CreatePendingActivationUserInput,
  CreateUserInput,
  UserDocument,
} from './identity.types';

export class IdentityRepository {
  private readonly users: Collection<UserDocument>;

  constructor(database: Database) {
    this.users = database.db.collection<UserDocument>('users');
  }

  async create(input: CreateUserInput, tx?: TransactionContext): Promise<UserDocument> {
    assertValidOptionalIdentifier('normalizedEmail', input.normalizedEmail);
    assertValidOptionalIdentifier('normalizedPhone', input.normalizedPhone);

    const now = input.now ?? new Date();
    const user: UserDocument = {
      _id: new ObjectId(),
      passwordHash: input.passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
      preferredLanguage: input.preferredLanguage,
      timezone: input.timezone,
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
      ...(input.email ? { email: input.email } : {}),
      ...(input.normalizedEmail ? { normalizedEmail: input.normalizedEmail } : {}),
      ...(input.phone ? { phone: input.phone } : {}),
      ...(input.normalizedPhone ? { normalizedPhone: input.normalizedPhone } : {}),
    };

    try {
      await this.users.insertOne(user, tx ? { session: tx.session } : undefined);
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw new AppError({
          code: 'AUTH_IDENTIFIER_CONFLICT',
          httpStatus: 409,
          message: 'The supplied login identifier cannot be used.',
          expose: true,
        });
      }
      throw error;
    }

    return user;
  }

  async createPendingActivation(
    input: CreatePendingActivationUserInput,
    tx?: TransactionContext,
  ): Promise<UserDocument> {
    assertValidOptionalIdentifier('normalizedEmail', input.normalizedEmail);
    assertValidOptionalIdentifier('normalizedPhone', input.normalizedPhone);

    const now = input.now ?? new Date();
    const user: UserDocument = {
      _id: new ObjectId(),
      firstName: input.firstName,
      lastName: input.lastName,
      preferredLanguage: input.preferredLanguage,
      timezone: input.timezone,
      status: 'PENDING_ACTIVATION',
      createdAt: now,
      updatedAt: now,
      ...(input.email ? { email: input.email } : {}),
      ...(input.normalizedEmail ? { normalizedEmail: input.normalizedEmail } : {}),
      ...(input.phone ? { phone: input.phone } : {}),
      ...(input.normalizedPhone ? { normalizedPhone: input.normalizedPhone } : {}),
    };

    try {
      await this.users.insertOne(user, tx ? { session: tx.session } : undefined);
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw new AppError({
          code: 'AUTH_IDENTIFIER_CONFLICT',
          httpStatus: 409,
          message: 'The supplied login identifier cannot be used.',
          expose: true,
        });
      }
      throw error;
    }

    return user;
  }

  async findById(userId: ObjectId, tx?: TransactionContext): Promise<UserDocument | null> {
    return await this.users.findOne({ _id: userId }, tx ? { session: tx.session } : undefined);
  }

  async findByNormalizedEmail(
    normalizedEmail: string,
    tx?: TransactionContext,
  ): Promise<UserDocument | null> {
    assertValidOptionalIdentifier('normalizedEmail', normalizedEmail);
    return await this.users.findOne({ normalizedEmail }, tx ? { session: tx.session } : undefined);
  }

  async findByNormalizedPhone(
    normalizedPhone: string,
    tx?: TransactionContext,
  ): Promise<UserDocument | null> {
    assertValidOptionalIdentifier('normalizedPhone', normalizedPhone);
    return await this.users.findOne({ normalizedPhone }, tx ? { session: tx.session } : undefined);
  }

  async findByLoginIdentifier(
    identifier: {
      normalizedEmail?: string;
      normalizedPhone?: string;
    },
    tx?: TransactionContext,
  ): Promise<UserDocument | null> {
    assertValidOptionalIdentifier('normalizedEmail', identifier.normalizedEmail);
    assertValidOptionalIdentifier('normalizedPhone', identifier.normalizedPhone);

    const conditions = [
      ...(identifier.normalizedEmail ? [{ normalizedEmail: identifier.normalizedEmail }] : []),
      ...(identifier.normalizedPhone ? [{ normalizedPhone: identifier.normalizedPhone }] : []),
    ];
    if (conditions.length === 0) return null;
    return await this.users.findOne({ $or: conditions }, tx ? { session: tx.session } : undefined);
  }

  async hasVerifiedLoginIdentifier(userId: ObjectId, tx?: TransactionContext): Promise<boolean> {
    const user = await this.users.findOne(
      {
        _id: userId,
        $or: [{ emailVerifiedAt: { $exists: true } }, { phoneVerifiedAt: { $exists: true } }],
      },
      tx ? { session: tx.session } : undefined,
    );
    return user !== null;
  }

  async markIdentifierVerified(
    userId: ObjectId,
    identifier: { normalizedEmail?: string; normalizedPhone?: string },
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<boolean> {
    assertValidOptionalIdentifier('normalizedEmail', identifier.normalizedEmail);
    assertValidOptionalIdentifier('normalizedPhone', identifier.normalizedPhone);

    const update = identifier.normalizedEmail
      ? { emailVerifiedAt: now, updatedAt: now }
      : { phoneVerifiedAt: now, updatedAt: now };

    const result = await this.users.updateOne(
      {
        _id: userId,
        ...(identifier.normalizedEmail ? { normalizedEmail: identifier.normalizedEmail } : {}),
        ...(identifier.normalizedPhone ? { normalizedPhone: identifier.normalizedPhone } : {}),
      },
      { $set: update },
      tx ? { session: tx.session } : undefined,
    );

    return result.modifiedCount === 1;
  }

  async updatePasswordHash(
    userId: ObjectId,
    passwordHash: string,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<void> {
    await this.users.updateOne(
      { _id: userId },
      { $set: { passwordHash, passwordUpdatedAt: now, updatedAt: now } },
      tx ? { session: tx.session } : undefined,
    );
  }

  async activatePending(
    userId: ObjectId,
    passwordHash: string,
    now = new Date(),
    tx?: TransactionContext,
  ): Promise<UserDocument> {
    const result = await this.users.findOneAndUpdate(
      { _id: userId, status: 'PENDING_ACTIVATION', passwordHash: { $exists: false } },
      {
        $set: {
          status: 'ACTIVE',
          passwordHash,
          passwordUpdatedAt: now,
          updatedAt: now,
        },
      },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) {
      throw new AppError({
        code: 'USER_ACTIVATION_INVALID',
        httpStatus: 409,
        message: 'The pending user cannot be activated.',
      });
    }
    return result;
  }

  async updateProfile(
    userId: ObjectId,
    input: {
      firstName?: string;
      lastName?: string;
      preferredLanguage?: string;
      timezone?: string;
      now?: Date;
    },
    tx?: TransactionContext,
  ): Promise<UserDocument> {
    const now = input.now ?? new Date();
    const result = await this.users.findOneAndUpdate(
      { _id: userId, status: 'ACTIVE' },
      {
        $set: compact({
          firstName: input.firstName,
          lastName: input.lastName,
          preferredLanguage: input.preferredLanguage,
          timezone: input.timezone,
          updatedAt: now,
        }),
      },
      { returnDocument: 'after', ...(tx ? { session: tx.session } : {}) },
    );
    if (!result) {
      throw new AppError({
        code: 'USER_NOT_FOUND',
        httpStatus: 404,
        message: 'User not found.',
      });
    }
    return result;
  }
}

function assertValidOptionalIdentifier(name: string, value: string | undefined): void {
  if (value === undefined) return;
  if (value.trim().length === 0) {
    throw new AppError({
      code: 'AUTH_IDENTIFIER_INVALID',
      httpStatus: 422,
      message: `${name} must not be empty.`,
    });
  }
}

function compact<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
