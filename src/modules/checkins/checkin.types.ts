import type { ObjectId } from 'mongodb';

export const CheckInTemplateStatuses = ['ACTIVE', 'ARCHIVED'] as const;
export type CheckInTemplateStatus = (typeof CheckInTemplateStatuses)[number];

export const CheckInFieldTypes = ['NUMBER', 'TEXT', 'LONG_TEXT', 'RATING', 'BOOLEAN'] as const;
export type CheckInFieldType = (typeof CheckInFieldTypes)[number];

export const UnsupportedCheckInFieldTypes = ['PHOTO', 'MEASUREMENT'] as const;

export const CheckInAssignmentFrequencies = ['WEEKLY'] as const;
export type CheckInAssignmentFrequency = (typeof CheckInAssignmentFrequencies)[number];

export const CheckInInstanceStatuses = [
  'UPCOMING',
  'DUE',
  'SUBMITTED',
  'REVIEWED',
  'OVERDUE',
  'SKIPPED',
] as const;
export type CheckInInstanceStatus = (typeof CheckInInstanceStatuses)[number];

export type CheckInFieldValidation = Partial<{
  min: number;
  max: number;
  minLength: number;
  maxLength: number;
}>;

export interface CheckInTemplateField {
  fieldKey: string;
  type: CheckInFieldType;
  label: string;
  required: boolean;
  validation?: CheckInFieldValidation;
}

export interface CheckInResponse {
  fieldKey: string;
  value: string | number | boolean | null;
}

export interface CheckInTemplateDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  ownerMembershipId: ObjectId;
  name: string;
  normalizedName: string;
  currentRevisionId: ObjectId;
  status: CheckInTemplateStatus;
  version: number;
  templateUseRevision: number;
  createdBy: ObjectId;
  updatedBy: ObjectId;
  createdAt: Date;
  updatedAt: Date;
  archivedAt?: Date;
}

export interface CheckInTemplateRevisionDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  templateId: ObjectId;
  revision: number;
  fields: CheckInTemplateField[];
  createdBy: ObjectId;
  createdAt: Date;
}

export interface CheckInRecurrence {
  frequency: CheckInAssignmentFrequency;
  dayOfWeek: number;
  timezone: string;
}

export interface CheckInAssignmentDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  relationshipId: ObjectId;
  templateId: ObjectId;
  recurrence: CheckInRecurrence;
  active: boolean;
  version: number;
  assignmentUseRevision: number;
  startedAt: Date;
  endedAt?: Date;
  endedBy?: ObjectId;
  endReason?: string;
  createdBy: ObjectId;
  updatedBy: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface CheckInPeriodSnapshot {
  periodKey: string;
  periodStartAt: Date;
  periodEndAt: Date;
  opensAt: Date;
  dueAt: Date;
  timezone: string;
  dayOfWeek: number;
}

export interface CheckInTrainerFeedback {
  comment: string;
  reviewedByMembershipId: ObjectId;
}

export interface CheckInSkipMetadata {
  reason: 'RELATIONSHIP_ENDED';
  skippedAt: Date;
  skippedBy?: ObjectId;
}

export interface CheckInInstanceDocument extends CheckInPeriodSnapshot {
  _id: ObjectId;
  workspaceId: ObjectId;
  relationshipId: ObjectId;
  assignmentId: ObjectId;
  templateId: ObjectId;
  templateRevisionId: ObjectId;
  status: CheckInInstanceStatus;
  submittedAt?: Date;
  reviewedAt?: Date;
  responses: CheckInResponse[];
  trainerFeedback?: CheckInTrainerFeedback;
  skipMetadata?: CheckInSkipMetadata;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
