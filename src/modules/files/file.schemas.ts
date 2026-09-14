import { Type } from '@sinclair/typebox';

export const ErrorResponse = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    correlationId: Type.Optional(Type.String()),
    details: Type.Optional(Type.Unknown()),
  }),
});

export const WorkspaceParams = Type.Object({ workspaceId: Type.String() });
export const UploadIntentParams = Type.Object({
  workspaceId: Type.String(),
  uploadIntentId: Type.String(),
});
export const FileParams = Type.Object({
  workspaceId: Type.String(),
  fileId: Type.String(),
});
export const RelationshipParams = Type.Object({
  workspaceId: Type.String(),
  relationshipId: Type.String(),
});
export const DocumentParams = Type.Object({
  workspaceId: Type.String(),
  relationshipId: Type.String(),
  documentId: Type.String(),
});
export const ListQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

const Classification = Type.Union([Type.Literal('STANDARD'), Type.Literal('SENSITIVE')]);
const Purpose = Type.Union([
  Type.Literal('DOCUMENT'),
  Type.Literal('PROGRESS_PHOTO'),
  Type.Literal('GENERIC'),
]);
const SubjectType = Type.Union([Type.Literal('COACHING_RELATIONSHIP'), Type.Literal('WORKSPACE')]);
const Category = Type.Union([
  Type.Literal('INBODY'),
  Type.Literal('BLOOD_TEST'),
  Type.Literal('MEDICAL_REPORT'),
  Type.Literal('DIET_DOCUMENT'),
  Type.Literal('TRAINING_DOCUMENT'),
  Type.Literal('INJURY_REPORT'),
  Type.Literal('OTHER'),
]);

export const UploadIntentBody = Type.Object({
  purpose: Purpose,
  subjectType: SubjectType,
  subjectId: Type.Optional(Type.String()),
  fileName: Type.String({ minLength: 1 }),
  mimeType: Type.String({ minLength: 1 }),
  sizeBytes: Type.Integer({ minimum: 1 }),
  checksumSha256: Type.Optional(Type.String()),
  classification: Type.Optional(Classification),
  sensitive: Type.Optional(Type.Boolean()),
});

export const ConfirmUploadBody = Type.Object({
  expectedVersion: Type.Integer({ minimum: 0 }),
});

export const ExpectedVersionBody = Type.Object({
  expectedVersion: Type.Integer({ minimum: 0 }),
});

export const CreateDocumentBody = Type.Object({
  fileId: Type.String(),
  category: Category,
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  classification: Type.Optional(Classification),
  documentDate: Type.Optional(Type.String()),
});
