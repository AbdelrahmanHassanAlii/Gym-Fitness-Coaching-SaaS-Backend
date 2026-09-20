import type { ObjectId } from 'mongodb';
import type { WorkspaceQueryAccess } from '../../core/access-control/access-control.types';

export type AttentionCategory =
  | 'CHECKIN_OVERDUE'
  | 'CHECKIN_PENDING_REVIEW'
  | 'NO_WORKOUT_ACTIVITY_7_DAYS'
  | 'NO_ACTIVE_PROGRAM'
  | 'NO_ACTIVE_NUTRITION_PLAN'
  | 'NEEDS_REASSIGNMENT';

export type ActivityCategory =
  | 'WORKOUT_COMPLETED'
  | 'PR_ACHIEVED'
  | 'CHECKIN_SUBMITTED'
  | 'INBODY_UPLOADED';

export type Granularity = 'none' | 'day' | 'week' | 'month';

export interface AnalyticsRange {
  from: Date;
  to: Date;
  timezone: string;
}

export interface RelationshipAccessContext {
  access: WorkspaceQueryAccess;
  timezone: string;
  relationship: {
    _id: ObjectId;
    workspaceId: ObjectId;
    traineeUserId: ObjectId;
    traineeMembershipId?: ObjectId;
    status: string;
    homeBranchId?: ObjectId;
  };
  actorKind:
    | 'OWNER'
    | 'MANAGER'
    | 'TRAINER'
    | 'ASSISTANT_TRAINER'
    | 'NUTRITIONIST'
    | 'TRAINEE'
    | 'OTHER';
}

export interface DateIdCursor {
  occurredAt: Date;
  id: ObjectId;
}

export interface CategoryDateIdCursor extends DateIdCursor {
  category: ActivityCategory;
}
