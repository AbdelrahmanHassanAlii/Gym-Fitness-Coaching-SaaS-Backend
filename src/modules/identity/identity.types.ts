import type { ObjectId } from 'mongodb';

export const UserStatuses = [
  'PENDING_ACTIVATION',
  'ACTIVE',
  'SUSPENDED',
  'LOCKED',
  'DEACTIVATED',
] as const;
export type UserStatus = (typeof UserStatuses)[number];

export interface BaseUserDocument {
  _id: ObjectId;
  email?: string;
  normalizedEmail?: string;
  phone?: string;
  normalizedPhone?: string;
  passwordHash?: string;
  passwordUpdatedAt?: Date;
  emailVerifiedAt?: Date;
  phoneVerifiedAt?: Date;
  firstName: string;
  lastName: string;
  preferredLanguage: string;
  timezone: string;
  status: UserStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ActiveUserDocument extends BaseUserDocument {
  status: 'ACTIVE';
  passwordHash: string;
}

export interface PendingActivationUserDocument extends Omit<BaseUserDocument, 'passwordHash'> {
  status: 'PENDING_ACTIVATION';
  passwordHash?: undefined;
}

export type UserDocument =
  | ActiveUserDocument
  | PendingActivationUserDocument
  | (BaseUserDocument & { status: Exclude<UserStatus, 'ACTIVE' | 'PENDING_ACTIVATION'> });

export interface CreateUserInput {
  email?: string;
  normalizedEmail?: string;
  phone?: string;
  normalizedPhone?: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  preferredLanguage: string;
  timezone: string;
  now?: Date;
}

export interface CreatePendingActivationUserInput {
  email?: string;
  normalizedEmail?: string;
  phone?: string;
  normalizedPhone?: string;
  firstName: string;
  lastName: string;
  preferredLanguage: string;
  timezone: string;
  now?: Date;
}
