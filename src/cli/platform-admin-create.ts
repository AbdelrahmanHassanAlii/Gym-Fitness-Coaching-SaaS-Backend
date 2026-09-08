import { ObjectId } from 'mongodb';
import { createAppContainer } from '../bootstrap/app-container';
import { loadConfig } from '../config/config';
import { normalizePhoneToE164 } from '../core/auth/phone-normalizer';
import { AppError } from '../core/errors/app-error';
import { normalizeEmail } from '../modules/auth/auth.normalization';

const config = loadConfig();
const container = await createAppContainer(config);

try {
  const args = parseArgs(Bun.argv.slice(2));
  const normalizedEmail = args.email ? normalizeEmail(args.email) : undefined;
  const normalizedPhone = args.phone ? normalizePhoneToE164(args.phone) : undefined;
  const permissionProfileId = args.permissionProfileId
    ? objectId(args.permissionProfileId, 'BOOTSTRAP_PERMISSION_PROFILE_INVALID')
    : undefined;
  if (!normalizedEmail && !normalizedPhone) {
    throw new AppError({
      code: 'BOOTSTRAP_IDENTIFIER_REQUIRED',
      httpStatus: 422,
      message: 'Supply --email or --phone.',
    });
  }
  if (!args.password || args.password.length < 8) {
    throw new AppError({
      code: 'BOOTSTRAP_PASSWORD_REQUIRED',
      httpStatus: 422,
      message: 'Supply --password with at least 8 characters.',
    });
  }
  const password = args.password;

  const result = await container.unitOfWork.withTransaction(async (tx) => {
    const byEmail = normalizedEmail
      ? await container.identity.findByNormalizedEmail(normalizedEmail, tx)
      : null;
    const byPhone = normalizedPhone
      ? await container.identity.findByNormalizedPhone(normalizedPhone, tx)
      : null;

    if (byEmail && byPhone && !byEmail._id.equals(byPhone._id)) {
      throw new AppError({
        code: 'BOOTSTRAP_IDENTIFIER_CONFLICT',
        httpStatus: 409,
        message: 'Email and phone resolve to different global users.',
      });
    }

    const user =
      byEmail ??
      byPhone ??
      (await container.identity.create(
        {
          ...compact({
            email: args.email,
            normalizedEmail,
            phone: args.phone,
            normalizedPhone,
          }),
          passwordHash: await container.passwordHasher.hash(password),
          firstName: args.firstName ?? 'Platform',
          lastName: args.lastName ?? 'Admin',
          preferredLanguage: args.preferredLanguage ?? 'en',
          timezone: args.timezone ?? 'Africa/Cairo',
        },
        tx,
      ));

    const existing = await container.platformMemberships.findByUserId(user._id, tx);
    if (permissionProfileId) {
      const profile = await container.permissionProfiles.findById(permissionProfileId, tx);
      if (profile?.context !== 'PLATFORM' || profile.status !== 'ACTIVE') {
        throw new AppError({
          code: 'BOOTSTRAP_PERMISSION_PROFILE_INVALID',
          httpStatus: 422,
          message: 'The permission profile must be an active Platform profile.',
        });
      }
    }

    if (existing?.status === 'ACTIVE') {
      if (permissionProfileId) {
        const updated = await container.platformMemberships.replacePermissionProfiles(
          existing._id,
          existing.accessVersion ?? 0,
          [permissionProfileId],
          new Date(),
          tx,
        );
        return {
          status: 'PROFILE_ASSIGNED',
          userId: user._id.toHexString(),
          platformMembershipId: updated._id.toHexString(),
          permissionProfileIds: updated.permissionProfileIds.map((id) => id.toHexString()),
          accessVersion: updated.accessVersion ?? 0,
        };
      }
      return {
        status: 'UNCHANGED_ACTIVE',
        userId: user._id.toHexString(),
        platformMembershipId: existing._id.toHexString(),
        permissionProfileIds: existing.permissionProfileIds.map((id) => id.toHexString()),
        accessVersion: existing.accessVersion ?? 0,
      };
    }
    if (existing) {
      throw new AppError({
        code: 'BOOTSTRAP_PLATFORM_MEMBERSHIP_INACTIVE',
        httpStatus: 409,
        message:
          'The resolved user has a non-active Platform membership. Use the normal lifecycle command.',
        details: { status: existing.status },
      });
    }

    const membership = await container.platformMemberships.createActive(user._id, new Date(), tx);
    const assignedMembership = permissionProfileId
      ? await container.platformMemberships.replacePermissionProfiles(
          membership._id,
          membership.accessVersion ?? 0,
          [permissionProfileId],
          new Date(),
          tx,
        )
      : membership;
    return {
      status: 'CREATED',
      userId: user._id.toHexString(),
      platformMembershipId: assignedMembership._id.toHexString(),
      permissionProfileIds: assignedMembership.permissionProfileIds.map((id) => id.toHexString()),
      accessVersion: assignedMembership.accessVersion ?? 0,
    };
  });

  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (error instanceof AppError) {
    console.error(`${error.code}: ${error.message}`);
    if (error.details) console.error(JSON.stringify(error.details));
    process.exitCode = 1;
  } else {
    console.error(error);
    process.exitCode = 1;
  }
} finally {
  await container.database.close();
}

function parseArgs(argv: string[]): {
  email?: string;
  phone?: string;
  password?: string;
  firstName?: string;
  lastName?: string;
  preferredLanguage?: 'ar' | 'en';
  timezone?: string;
  permissionProfileId?: string;
} {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item) continue;
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new AppError({
        code: 'BOOTSTRAP_ARG_INVALID',
        httpStatus: 422,
        message: `Missing value for --${key}.`,
      });
    }
    parsed[key] = value;
    index += 1;
  }
  return compact({
    email: parsed.email,
    phone: parsed.phone,
    password: parsed.password,
    firstName: parsed['first-name'],
    lastName: parsed['last-name'],
    preferredLanguage: language(parsed['preferred-language']),
    timezone: parsed.timezone,
    permissionProfileId: parsed['permission-profile-id'],
  });
}

function objectId(value: string, code: string) {
  if (!ObjectId.isValid(value)) {
    throw new AppError({
      code,
      httpStatus: 422,
      message: 'The supplied ObjectId is invalid.',
    });
  }
  return new ObjectId(value);
}

function language(value: string | undefined): 'ar' | 'en' | undefined {
  if (value === undefined) return undefined;
  if (value === 'ar' || value === 'en') return value;
  throw new AppError({
    code: 'BOOTSTRAP_LANGUAGE_INVALID',
    httpStatus: 422,
    message: 'Preferred language must be ar or en.',
  });
}

function compact<T extends Record<string, unknown>>(input: T) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
