import { ObjectId } from 'mongodb';
import type { AppContainer } from '../../bootstrap/app-container';
import { AppError } from '../../core/errors/app-error';
import type { RequestContext } from '../../core/request-context/request-context';

function deny(code: string, httpStatus = 403): never {
  throw new AppError({ code, httpStatus, message: 'Support access denied.' });
}

/** Fresh actor boundary; runtime mode deliberately retains the selected support context. */
export async function authorizeSupportActor(
  container: AppContainer,
  ctx: RequestContext,
  permission: string,
  runtime = false,
): Promise<void> {
  if (!runtime && ctx.supportSessionId) deny('SUPPORT_ACCESS_FORBIDDEN');
  if (!ctx.userId || !ctx.authSessionId) deny('AUTH_REQUIRED', 401);
  const [user, session] = await Promise.all([
    container.identity.findById(new ObjectId(ctx.userId)),
    container.authSessions.findActive(new ObjectId(ctx.authSessionId)),
  ]);
  if (user?.status !== 'ACTIVE' || !session?.userId.equals(user._id)) {
    deny('AUTH_REQUIRED', 401);
  }
  if (session.restrictedUntilVerified) deny('AUTH_SESSION_RESTRICTED');
  if (!session.mfaSatisfiedAt) deny('TWO_FACTOR_REQUIRED');
  const membership = await container.platformMemberships.findByUserId(user._id);
  if (!membership) deny('PLATFORM_MEMBERSHIP_REQUIRED');
  if (membership.status !== 'ACTIVE') deny('PLATFORM_MEMBERSHIP_INACTIVE');
  await container.accessControl.authorize(ctx, {
    context: 'PLATFORM',
    permission,
    scope: { type: 'WORKSPACE' },
  });
}
