import { Type } from '@sinclair/typebox';
import { ErrorResponse } from '../auth/auth.schemas';

const BillingPeriod = Type.Union([Type.Literal('MONTHLY'), Type.Literal('YEARLY')]);
const CustomerType = Type.Union([Type.Literal('INDIVIDUAL_TRAINER'), Type.Literal('GYM')]);

const Limits = Type.Object(
  {
    activeTrainees: Type.Optional(Type.Number({ minimum: 0 })),
    activeStaff: Type.Optional(Type.Number({ minimum: 0 })),
    storageBytes: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const WorkspaceParams = Type.Object({ workspaceId: Type.String() });
export const PlanParams = Type.Object({ planId: Type.String() });
export const PaymentParams = Type.Object({ paymentId: Type.String() });

export const CreatePlanBody = Type.Object(
  {
    key: Type.String({ minLength: 1 }),
    customerType: CustomerType,
    name: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const UpdatePlanBody = Type.Object(
  {
    expectedVersion: Type.Number(),
    name: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const ArchivePlanBody = Type.Object(
  {
    expectedVersion: Type.Number(),
  },
  { additionalProperties: false },
);

export const CreatePlanVersionBody = Type.Object(
  {
    billingOptions: Type.Array(BillingPeriod, { minItems: 1 }),
    defaultLimits: Limits,
    features: Type.Record(Type.String(), Type.Boolean()),
    trialDays: Type.Optional(Type.Number({ minimum: 1 })),
    effectiveFrom: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);

export const ChangeTermsBody = Type.Object(
  {
    expectedVersion: Type.Number(),
    planVersionId: Type.String(),
    billingPeriod: BillingPeriod,
    effectiveFrom: Type.String({ format: 'date-time' }),
    effectiveTo: Type.Optional(Type.String({ format: 'date-time' })),
    limits: Type.Optional(Limits),
    enabledFeatures: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

export const StartTrialBody = Type.Object(
  {
    expectedVersion: Type.Number(),
    planVersionId: Type.String(),
    billingPeriod: BillingPeriod,
    effectiveFrom: Type.String({ format: 'date-time' }),
    trialDays: Type.Optional(Type.Number({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const TransitionSubscriptionBody = Type.Object(
  { expectedVersion: Type.Number() },
  { additionalProperties: false },
);

export const CreateManualPaymentBody = Type.Object(
  {
    amount: Type.Number({ exclusiveMinimum: 0 }),
    currency: Type.String({ minLength: 3, maxLength: 3 }),
    paymentMethod: Type.String({ minLength: 1 }),
    paymentReference: Type.Optional(Type.String()),
    paidAt: Type.Optional(Type.String({ format: 'date-time' })),
    notes: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ApprovePaymentBody = Type.Object(
  {
    paymentExpectedVersion: Type.Number(),
    expectedVersion: Type.Number(),
    planVersionId: Type.String(),
    billingPeriod: BillingPeriod,
    effectiveFrom: Type.String({ format: 'date-time' }),
    effectiveTo: Type.Optional(Type.String({ format: 'date-time' })),
    limits: Type.Optional(Limits),
    enabledFeatures: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

export const RejectPaymentBody = Type.Object(
  {
    expectedVersion: Type.Number(),
    reason: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export { ErrorResponse };
