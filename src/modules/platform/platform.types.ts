import type { ObjectId } from 'mongodb';

export const PlatformMembershipStatuses = ['ACTIVE', 'SUSPENDED', 'ENDED'] as const;
export type PlatformMembershipStatus = (typeof PlatformMembershipStatuses)[number];

export interface PlatformMembershipDocument {
  _id: ObjectId;
  userId: ObjectId;
  status: PlatformMembershipStatus;
  permissionProfileIds: ObjectId[];
  accessVersion?: number;
  createdAt: Date;
  updatedAt: Date;
  suspendedAt?: Date;
  endedAt?: Date;
}
