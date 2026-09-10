import type { ObjectId } from 'mongodb';
import type { ExercisePrescription } from '../training/training.types';

export const WorkoutStatuses = ['IN_PROGRESS', 'COMPLETED', 'ABANDONED'] as const;
export type WorkoutStatus = (typeof WorkoutStatuses)[number];

export interface WorkoutSetSnapshot {
  setKey: string;
  setIndex: number;
  setType: string;
  weight?: number;
  reps?: number;
  durationSeconds?: number;
  distance?: number;
  rpe?: number;
  rir?: number;
  completed: boolean;
  notes?: string;
}

export interface WorkoutExerciseSnapshot extends ExercisePrescription {
  workoutExerciseKey: string;
  sets: WorkoutSetSnapshot[];
}

export interface WorkoutSessionDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  relationshipId: ObjectId;
  traineeUserId: ObjectId;
  programId: ObjectId;
  programRevisionId: ObjectId;
  dayKey: string;
  daySequence: number;
  performedByUserId: ObjectId;
  status: WorkoutStatus;
  startedAt: Date;
  completedAt?: Date;
  completedByUserId?: ObjectId;
  traineeEditableUntil?: Date;
  abandonedAt?: Date;
  abandonedByUserId?: ObjectId;
  abandonmentReason?: string;
  exercises: WorkoutExerciseSnapshot[];
  notes?: string;
  clientMutationId?: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const PersonalRecordTypes = ['MAX_WEIGHT', 'REP_AT_WEIGHT', 'ESTIMATED_1RM'] as const;
export type PersonalRecordType = (typeof PersonalRecordTypes)[number];

export const PersonalRecordEventTypes = ['ACHIEVED', 'ADJUSTED', 'RETRACTED'] as const;
export type PersonalRecordEventType = (typeof PersonalRecordEventTypes)[number];

export interface PersonalRecordDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  relationshipId: ObjectId;
  exerciseId: ObjectId;
  recordType: PersonalRecordType;
  qualifierKey: string;
  value: number;
  sourceWorkoutId: ObjectId;
  sourceWorkoutVersion: number;
  achievedAt: Date;
  updatedAt: Date;
}

export interface PersonalRecordEventDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  relationshipId: ObjectId;
  exerciseId: ObjectId;
  recordType: PersonalRecordType;
  qualifierKey: string;
  eventType: PersonalRecordEventType;
  previousValue?: number;
  newValue?: number;
  sourceWorkoutId: ObjectId;
  sourceWorkoutVersion: number;
  occurredAt: Date;
}
