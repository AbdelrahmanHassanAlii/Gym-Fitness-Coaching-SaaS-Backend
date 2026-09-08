import type { ObjectId } from 'mongodb';

export const SubscriptionLifecycleStatuses = [
  'PENDING_ACTIVATION',
  'TRIAL',
  'ACTIVE',
  'GRACE_PERIOD',
  'FROZEN',
  'EXPIRED',
  'CANCELLED',
] as const;
export type SubscriptionLifecycleStatus = (typeof SubscriptionLifecycleStatuses)[number];

export const BillingPeriods = ['MONTHLY', 'YEARLY'] as const;
export type BillingPeriod = (typeof BillingPeriods)[number];

export const SubscriptionTermSources = [
  'TRIAL',
  'PURCHASE',
  'UPGRADE',
  'DOWNGRADE',
  'ADMIN_OVERRIDE',
] as const;
export type SubscriptionTermSource = (typeof SubscriptionTermSources)[number];

export const ManualPaymentStatuses = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type ManualPaymentStatus = (typeof ManualPaymentStatuses)[number];

export interface SubscriptionLimits {
  activeTrainees?: number;
  activeStaff?: number;
  storageBytes: number;
}

export interface SubscriptionPlanDocument {
  _id: ObjectId;
  key: string;
  customerType: 'INDIVIDUAL_TRAINER' | 'GYM';
  name: string;
  active: boolean;
  currentVersionId?: ObjectId;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SubscriptionPlanVersionDocument {
  _id: ObjectId;
  planId: ObjectId;
  version: number;
  billingOptions: BillingPeriod[];
  defaultLimits: SubscriptionLimits;
  features: Record<string, boolean>;
  trialDefaults?: { days: number };
  effectiveFrom: Date;
  createdBy: ObjectId;
  createdAt: Date;
}

export interface SubscriptionDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  lifecycleStatus: SubscriptionLifecycleStatus;
  currentTermsId?: ObjectId;
  startedAt?: Date;
  expiresAt?: Date;
  graceEndsAt?: Date;
  frozenAt?: Date;
  expiredAt?: Date;
  cancelledAt?: Date;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SubscriptionTermDocument {
  _id: ObjectId;
  subscriptionId: ObjectId;
  workspaceId: ObjectId;
  planVersionId: ObjectId;
  billingPeriod: BillingPeriod;
  limits: SubscriptionLimits;
  enabledFeatures: string[];
  effectiveFrom: Date;
  effectiveTo?: Date;
  source: SubscriptionTermSource;
  createdBy: ObjectId;
  createdAt: Date;
}

export interface WorkspaceUsageDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  activeTrainees: number;
  activeStaff: number;
  storageBytes: number;
  reservedStorageBytes: number;
  revision: number;
  calculatedAt: Date;
  updatedAt: Date;
}

export interface ManualPaymentDocument {
  _id: ObjectId;
  workspaceId: ObjectId;
  subscriptionId?: ObjectId;
  amount: number;
  currency: string;
  paymentMethod: string;
  paymentReference?: string;
  proofFileId?: ObjectId;
  paidAt?: Date;
  status: ManualPaymentStatus;
  reviewedBy?: ObjectId;
  reviewedAt?: Date;
  rejectionReason?: string;
  notes?: string;
  version: number;
  createdBy: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export type EntitlementAction = 'READ' | 'WRITE' | 'UPLOAD' | 'ACTIVATE_TRAINEE' | 'ACTIVATE_STAFF';

export type UsageCompliance =
  | 'WITHIN_LIMIT'
  | 'OVER_TRAINEE_LIMIT'
  | 'OVER_STAFF_LIMIT'
  | 'OVER_STORAGE_LIMIT'
  | 'MULTIPLE_LIMIT_VIOLATIONS';
