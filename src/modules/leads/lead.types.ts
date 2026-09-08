import type { ObjectId } from 'mongodb';
import type { BillingPeriod, SubscriptionLimits } from '../subscriptions/subscription.types';
import type { WorkspaceType } from '../workspaces/workspace.types';

export const LeadCustomerInterests = ['INDIVIDUAL_TRAINER', 'GYM'] as const;
export type LeadCustomerInterest = (typeof LeadCustomerInterests)[number];

export const LeadStatuses = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'ON_HOLD',
  'CONVERTED',
  'LOST',
  'DUPLICATE',
] as const;
export type LeadStatus = (typeof LeadStatuses)[number];

export interface LeadDocument {
  _id: ObjectId;
  customerInterest: LeadCustomerInterest;
  name?: string;
  gymName?: string;
  contactPerson?: string;
  phone: string;
  normalizedPhone: string;
  email: string;
  normalizedEmail: string;
  governorate?: string;
  city?: string;
  estimatedTrainees?: number;
  estimatedStaff?: number;
  numberOfBranches?: number;
  billingInterest?: BillingPeriod;
  referralCode?: string;
  source?: string;
  notes?: string;
  status: LeadStatus;
  assignedTo?: ObjectId;
  convertedWorkspaceId?: ObjectId;
  convertedBy?: ObjectId;
  convertedAt?: Date;
  duplicatePreviousStatus?: Exclude<LeadStatus, 'DUPLICATE'>;
  duplicateMarkedAt?: Date;
  duplicateMarkedBy?: ObjectId;
  mergedIntoLeadId?: ObjectId;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface CreateLeadInput {
  customerInterest: LeadCustomerInterest;
  name?: string;
  gymName?: string;
  contactPerson?: string;
  phone: string;
  normalizedPhone: string;
  email: string;
  normalizedEmail: string;
  governorate?: string;
  city?: string;
  estimatedTrainees?: number;
  estimatedStaff?: number;
  numberOfBranches?: number;
  billingInterest?: BillingPeriod;
  referralCode?: string;
  source?: string;
  notes?: string;
  now?: Date;
}

export interface UpdateLeadMetadataInput {
  name?: string;
  gymName?: string;
  contactPerson?: string;
  governorate?: string;
  city?: string;
  estimatedTrainees?: number;
  estimatedStaff?: number;
  numberOfBranches?: number;
  billingInterest?: BillingPeriod;
  referralCode?: string;
  source?: string;
  notes?: string;
}

export interface ConvertLeadInput {
  expectedVersion: number;
  workspaceType: WorkspaceType;
  workspace: {
    name: string;
    timezone: string;
    defaultLanguage?: 'ar' | 'en';
    country?: string;
    city?: string;
    governorate?: string;
  };
  subscription: {
    planVersionId: string;
    billingPeriod: BillingPeriod;
    startMode: 'TRIAL' | 'PENDING_ACTIVATION';
    effectiveFrom?: string;
    limits?: SubscriptionLimits;
    enabledFeatures?: string[];
  };
  owner: {
    email?: string;
    phone?: string;
    firstName?: string;
    lastName?: string;
    preferredLanguage?: string;
    timezone?: string;
  };
  reason?: string;
}
