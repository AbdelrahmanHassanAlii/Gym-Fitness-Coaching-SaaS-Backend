import type { ObjectId } from 'mongodb';

export const TrainingScopes = ['SYSTEM', 'GYM', 'PRIVATE'] as const;
export type TrainingScope = (typeof TrainingScopes)[number];

export const TrainingStatuses = ['ACTIVE', 'ARCHIVED'] as const;
export type TrainingStatus = (typeof TrainingStatuses)[number];

export const ProgramStatuses = ['DRAFT', 'ACTIVE', 'REPLACED', 'COMPLETED', 'ARCHIVED'] as const;
export type ProgramStatus = (typeof ProgramStatuses)[number];

export const ProgramDayTypes = ['RESISTANCE', 'CARDIO', 'RECOVERY', 'REST', 'CUSTOM'] as const;
export type ProgramDayType = (typeof ProgramDayTypes)[number];

export interface ExerciseNames {
  ar?: string;
  en?: string;
}

export interface ExerciseDocument {
  _id: ObjectId;
  scope: TrainingScope;
  workspaceId?: ObjectId | null;
  ownerMembershipId?: ObjectId | null;
  names: ExerciseNames;
  normalizedNames: string[];
  primaryMuscles: string[];
  secondaryMuscles: string[];
  equipment: string[];
  exerciseType: string;
  difficulty?: string;
  instructions?: string;
  imageFileId?: ObjectId;
  videoFileId?: ObjectId;
  externalVideoUrl?: string;
  status: TrainingStatus;
  version: number;
  archivedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProgramTemplateDocument {
  _id: ObjectId;
  workspaceId?: ObjectId | null;
  ownerMembershipId?: ObjectId | null;
  scope: TrainingScope;
  name: string;
  description?: string;
  currentRevisionId: ObjectId;
  status: TrainingStatus;
  version: number;
  archivedAt?: Date;
  createdBy: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExercisePrescription {
  prescriptionId: string;
  exerciseId: ObjectId;
  exerciseNameSnapshot: string;
  order: number;
  setStructure: string;
  targetSets: number;
  repRange?: { min?: number; max?: number };
  targetWeight?: number;
  restSeconds?: number;
  tempo?: string;
  rpe?: number;
  rir?: number;
  groupId?: string;
  groupType?: string;
  notes?: string;
}

export interface ProgramDay {
  dayKey: string;
  sequence: number;
  name: string;
  type: ProgramDayType;
  exercises: ExercisePrescription[];
}

export interface ProgramTemplateRevisionDocument {
  _id: ObjectId;
  workspaceId?: ObjectId | null;
  templateId: ObjectId;
  revision: number;
  days: ProgramDay[];
  createdBy: ObjectId;
  createdAt: Date;
}

export interface ProgramDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  relationshipId: ObjectId;
  name: string;
  sourceTemplateId?: ObjectId;
  sourceTemplateRevisionId?: ObjectId;
  sourceProgramId?: ObjectId;
  sourceProgramRevisionId?: ObjectId;
  replacedByProgramId?: ObjectId;
  status: ProgramStatus;
  startedAt?: Date;
  endedAt?: Date;
  completedAt?: Date;
  archivedAt?: Date;
  currentRevisionId: ObjectId;
  assignedBy: ObjectId;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface ProgramRevisionDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  relationshipId: ObjectId;
  programId: ObjectId;
  revision: number;
  days: ProgramDay[];
  createdBy: ObjectId;
  createdAt: Date;
}

export interface ProgramProgressDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  relationshipId: ObjectId;
  programId: ObjectId;
  programRevisionId: ObjectId;
  currentDaySequence: number;
  completedDayCount: number;
  skippedDayCount: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProgramProgressEventDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  relationshipId: ObjectId;
  programId: ObjectId;
  programRevisionId: ObjectId;
  daySequence: number;
  type: 'INITIALIZED' | 'COMPLETED' | 'SKIPPED' | 'RESET' | 'MANUAL_ADVANCE';
  workoutSessionId?: ObjectId;
  reason?: string;
  performedBy: ObjectId;
  occurredAt: Date;
}
