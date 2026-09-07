import type { ObjectId } from 'mongodb';

export const UserStatuses = ['ACTIVE', 'SUSPENDED', 'LOCKED', 'DEACTIVATED'] as const;
export type UserStatus = (typeof UserStatuses)[number];

export interface UserDocument {
  _id: ObjectId;
  email?: string;
  normalizedEmail?: string;
  phone?: string;
  normalizedPhone?: string;
  passwordHash: string;
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
