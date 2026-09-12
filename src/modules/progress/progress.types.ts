import type { ObjectId } from 'mongodb';

export const MetricDefinitionScopes = ['SYSTEM', 'GYM', 'PRIVATE'] as const;
export type MetricDefinitionScope = (typeof MetricDefinitionScopes)[number];

export const MetricValueTypes = ['NUMBER', 'INTEGER'] as const;
export type MetricValueType = (typeof MetricValueTypes)[number];

export const MetricDefinitionStatuses = ['ACTIVE', 'ARCHIVED'] as const;
export type MetricDefinitionStatus = (typeof MetricDefinitionStatuses)[number];

export const MeasurementSources = ['TRAINEE', 'TRAINER', 'INBODY', 'OTHER'] as const;
export type MeasurementSource = (typeof MeasurementSources)[number];

export const ProgressPhotoTypes = ['FRONT', 'SIDE', 'BACK', 'OTHER'] as const;
export type ProgressPhotoType = (typeof ProgressPhotoTypes)[number];

export const ProgressPhotoVisibilities = ['PRIVATE', 'TRAINER_VISIBLE'] as const;
export type ProgressPhotoVisibility = (typeof ProgressPhotoVisibilities)[number];

export const NoteVisibilities = ['PRIVATE', 'SHARED_WITH_TRAINEE'] as const;
export type NoteVisibility = (typeof NoteVisibilities)[number];

export const NoteStatuses = ['ACTIVE', 'ARCHIVED'] as const;
export type NoteStatus = (typeof NoteStatuses)[number];

export const AdherenceMetricKeys = [
  'WORKOUT',
  'NUTRITION',
  'WATER',
  'STEPS',
  'SLEEP',
  'BODY_WEIGHT',
  'MOOD',
  'ENERGY',
] as const;
export type AdherenceMetricKey = (typeof AdherenceMetricKeys)[number];

export interface MetricDefinitionDocument {
  _id: ObjectId;
  scope: MetricDefinitionScope;
  workspaceId?: ObjectId | null;
  ownerMembershipId?: ObjectId | null;
  key?: string;
  normalizedKey?: string;
  name: string;
  normalizedName: string;
  valueType: MetricValueType;
  unit: string;
  category: string;
  status: MetricDefinitionStatus;
  version: number;
  measurementUseRevision?: number;
  archivedAt?: Date;
  createdBy: ObjectId;
  updatedBy: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface MeasurementEntryDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  relationshipId: ObjectId;
  metricDefinitionId: ObjectId;
  value: number;
  measuredAt: Date;
  source: MeasurementSource;
  notes?: string;
  recordedBy: ObjectId;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProgressPhotoItem {
  type: ProgressPhotoType;
  fileId: ObjectId;
}

export interface ProgressPhotoEntryDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  relationshipId: ObjectId;
  capturedAt: Date;
  weightAtCaptureKg?: number;
  visibility: ProgressPhotoVisibility;
  photos: ProgressPhotoItem[];
  createdBy: ObjectId;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface TraineeHealthProfileDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  relationshipId: ObjectId;
  injuries: string[];
  physicalLimitations: string[];
  foodAllergies: string[];
  medications: string[];
  medicalNotes?: string;
  emergencyNotes?: string;
  version: number;
  updatedBy: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface CoachingNoteDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  relationshipId: ObjectId;
  authorMembershipId: ObjectId;
  category: string;
  visibility: NoteVisibility;
  content: string;
  sensitive: boolean;
  status: NoteStatus;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt?: Date;
}

export interface AdherenceConfigDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  relationshipId: ObjectId;
  enabledMetrics: AdherenceMetricKey[];
  version: number;
  updatedBy: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export type DailyMetricValues = Partial<{
  WORKOUT: { completed: boolean };
  NUTRITION: { adherencePercent: number };
  WATER: { ml: number };
  STEPS: { count: number };
  SLEEP: { minutes: number };
  BODY_WEIGHT: { kg: number };
  MOOD: { score: number };
  ENERGY: { score: number };
}>;

export interface DailyTrackingEntryDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  relationshipId: ObjectId;
  localDate: string;
  timezoneAtEntry: string;
  values: DailyMetricValues;
  version: number;
  updatedBy: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}
