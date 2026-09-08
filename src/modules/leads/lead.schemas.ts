import { Type } from '@sinclair/typebox';
import { ErrorResponse, SuccessResponse } from '../auth/auth.schemas';

const CustomerInterest = Type.Union([Type.Literal('INDIVIDUAL_TRAINER'), Type.Literal('GYM')]);
const BillingPeriod = Type.Union([Type.Literal('MONTHLY'), Type.Literal('YEARLY')]);
const LeadStatus = Type.Union([
  Type.Literal('NEW'),
  Type.Literal('CONTACTED'),
  Type.Literal('QUALIFIED'),
  Type.Literal('ON_HOLD'),
  Type.Literal('CONVERTED'),
  Type.Literal('LOST'),
  Type.Literal('DUPLICATE'),
]);
const WorkspaceType = Type.Union([Type.Literal('GYM'), Type.Literal('INDEPENDENT_TRAINER')]);
const Language = Type.Union([Type.Literal('ar'), Type.Literal('en')]);

export const LeadParams = Type.Object({
  leadId: Type.String(),
});

export const LeadListQuery = Type.Object(
  {
    status: Type.Optional(LeadStatus),
    customerInterest: Type.Optional(CustomerInterest),
    cursor: Type.Optional(Type.String({ format: 'date-time' })),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);

export const PublicCreateLeadBody = Type.Object(
  {
    customerInterest: CustomerInterest,
    name: Type.Optional(Type.String({ minLength: 1 })),
    gymName: Type.Optional(Type.String({ minLength: 1 })),
    contactPerson: Type.Optional(Type.String({ minLength: 1 })),
    phone: Type.String({ minLength: 1 }),
    email: Type.String({ minLength: 1 }),
    governorate: Type.Optional(Type.String()),
    city: Type.Optional(Type.String()),
    estimatedTrainees: Type.Optional(Type.Number({ minimum: 0 })),
    estimatedStaff: Type.Optional(Type.Number({ minimum: 0 })),
    numberOfBranches: Type.Optional(Type.Number({ minimum: 0 })),
    billingInterest: Type.Optional(BillingPeriod),
    referralCode: Type.Optional(Type.String()),
    source: Type.Optional(Type.String()),
    notes: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const UpdateLeadBody = Type.Object(
  {
    expectedVersion: Type.Number(),
    name: Type.Optional(Type.String({ minLength: 1 })),
    gymName: Type.Optional(Type.String({ minLength: 1 })),
    contactPerson: Type.Optional(Type.String({ minLength: 1 })),
    governorate: Type.Optional(Type.String()),
    city: Type.Optional(Type.String()),
    estimatedTrainees: Type.Optional(Type.Number({ minimum: 0 })),
    estimatedStaff: Type.Optional(Type.Number({ minimum: 0 })),
    numberOfBranches: Type.Optional(Type.Number({ minimum: 0 })),
    billingInterest: Type.Optional(BillingPeriod),
    referralCode: Type.Optional(Type.String()),
    source: Type.Optional(Type.String()),
    notes: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const LeadStatusBody = Type.Object(
  {
    expectedVersion: Type.Number(),
    targetStatus: LeadStatus,
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const MarkDuplicateBody = Type.Object(
  {
    expectedVersion: Type.Number(),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const MergeLeadBody = Type.Object(
  {
    expectedVersion: Type.Number(),
    targetLeadId: Type.String(),
    targetExpectedVersion: Type.Number(),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const Limits = Type.Object(
  {
    activeTrainees: Type.Optional(Type.Number({ minimum: 0 })),
    activeStaff: Type.Optional(Type.Number({ minimum: 0 })),
    storageBytes: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const ConvertLeadBody = Type.Object(
  {
    expectedVersion: Type.Number(),
    workspaceType: WorkspaceType,
    workspace: Type.Object(
      {
        name: Type.String({ minLength: 1 }),
        timezone: Type.String({ minLength: 1 }),
        defaultLanguage: Type.Optional(Language),
        country: Type.Optional(Type.String()),
        city: Type.Optional(Type.String()),
        governorate: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    subscription: Type.Object(
      {
        planVersionId: Type.String(),
        billingPeriod: BillingPeriod,
        startMode: Type.Union([Type.Literal('TRIAL'), Type.Literal('PENDING_ACTIVATION')]),
        effectiveFrom: Type.Optional(Type.String({ format: 'date-time' })),
        limits: Type.Optional(Limits),
        enabledFeatures: Type.Optional(Type.Array(Type.String())),
      },
      { additionalProperties: false },
    ),
    owner: Type.Object(
      {
        email: Type.Optional(Type.String()),
        phone: Type.Optional(Type.String()),
        firstName: Type.Optional(Type.String({ minLength: 1 })),
        lastName: Type.Optional(Type.String({ minLength: 1 })),
        preferredLanguage: Type.Optional(Language),
        timezone: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const CompleteOwnerActivationBody = Type.Object(
  {
    token: Type.String({ minLength: 1 }),
    verification: Type.Object(
      {
        challengeId: Type.String(),
        code: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    password: Type.String({ minLength: 8 }),
  },
  { additionalProperties: false },
);

export { ErrorResponse, SuccessResponse };
