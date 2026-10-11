import type { ObjectId } from 'mongodb';
import type { UserDocument, UserStatus } from '../identity/identity.types';
import type {
  PlatformMembershipDocument,
  PlatformMembershipStatus,
} from '../platform/platform.types';

export type PlatformUserAccount = Pick<
  UserDocument,
  '_id' | 'firstName' | 'lastName' | 'email' | 'status' | 'createdAt' | 'updatedAt'
>;
export type PlatformUserMembership = Pick<
  PlatformMembershipDocument,
  '_id' | 'userId' | 'status' | 'createdAt' | 'updatedAt' | 'suspendedAt' | 'endedAt'
>;
export interface PlatformUserRecord extends PlatformUserMembership {
  user: PlatformUserAccount;
}
export interface PlatformUserQuery {
  q?: string;
  platformMembershipStatus?: PlatformMembershipStatus;
  cursor?: string;
  limit?: number;
}
export interface PlatformUserPageQuery {
  afterId?: ObjectId;
  status?: PlatformMembershipStatus;
  limit: number;
}
export interface PlatformUserRow {
  id: string;
  displayName?: string;
  email?: string;
  status: UserStatus;
  createdAt: string;
  platformMembership: { status: PlatformMembershipStatus };
}
export interface PlatformUserDetail extends Omit<PlatformUserRow, 'platformMembership'> {
  updatedAt: string;
  platformMembership: {
    id: string;
    status: PlatformMembershipStatus;
    createdAt: string;
    updatedAt: string;
    suspendedAt?: string;
    endedAt?: string;
  };
}
