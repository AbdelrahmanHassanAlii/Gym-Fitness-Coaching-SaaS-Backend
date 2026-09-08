import type { FastifyRequest } from 'fastify';
import { ObjectId } from 'mongodb';
import type { AppContainer } from '../../bootstrap/app-container';
import type { PermissionScope } from '../../modules/permissions/permission.types';
import { AppError } from '../errors/app-error';
import type { AuthorizationRequirement } from './access-control.types';

export function requireAccess(container: AppContainer, requirement: AuthorizationRequirement) {
  return async (request: FastifyRequest) => {
    const workspaceId =
      requirement.context === 'WORKSPACE'
        ? objectId((request.params as Record<string, string>).workspaceId, 'WORKSPACE_NOT_FOUND')
        : undefined;
    const scope = scopeFromParams(requirement, request.params as Record<string, string>);
    await container.accessControl.authorize(request.ctx, {
      context: requirement.context,
      permission: requirement.permission,
      ...(workspaceId ? { workspaceId } : {}),
      ...(scope ? { scope } : {}),
      ...(requirement.mfaRequired === true
        ? { mfaSatisfied: Boolean(request.ctx.mfaSatisfied) }
        : {}),
    });
  };
}

function scopeFromParams(
  requirement: AuthorizationRequirement,
  params: Record<string, string>,
): PermissionScope | undefined {
  if (!requirement.scope) return { type: 'WORKSPACE' };
  const resourceId = requirement.scope.resourceIdParam
    ? objectId(params[requirement.scope.resourceIdParam], 'SCOPE_RESOURCE_NOT_FOUND')
    : undefined;
  return {
    type: requirement.scope.type,
    ...(resourceId ? { resourceIds: [resourceId] } : {}),
    ...(requirement.scope.requiresAssignment === false ? { requiresAssignment: false } : {}),
  };
}

function objectId(value: string | undefined, code: string): ObjectId {
  if (!value || !ObjectId.isValid(value)) {
    throw new AppError({ code, httpStatus: 404, message: 'Resource not found.' });
  }
  return new ObjectId(value);
}
