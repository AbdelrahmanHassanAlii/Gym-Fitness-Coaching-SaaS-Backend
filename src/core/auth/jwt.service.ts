import { createPrivateKey, createPublicKey, randomUUID, sign, verify } from 'node:crypto';
import type { AppConfig } from '../../config/config.types';
import { AppError } from '../errors/app-error';
import type { AuthenticationMethod } from './auth.types';
import { base64UrlDecode, base64UrlEncode } from './auth-codec';

interface AccessTokenPayload {
  sub: string;
  sid: string;
  jti: string;
  iat: number;
  exp: number;
  amr: AuthenticationMethod[];
}

export interface CreateAccessTokenInput {
  userId: string;
  authSessionId: string;
  authenticationMethods: AuthenticationMethod[];
  now?: Date;
}

export class JwtService {
  constructor(private readonly config: AppConfig) {}

  createAccessToken(input: CreateAccessTokenInput): string {
    const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
    const payload: AccessTokenPayload = {
      sub: input.userId,
      sid: input.authSessionId,
      jti: randomUUID(),
      iat: nowSeconds,
      exp: nowSeconds + this.config.auth.accessTokenTtlSeconds,
      amr: input.authenticationMethods,
    };

    const header = {
      alg: 'EdDSA',
      typ: 'JWT',
      kid: this.config.auth.jwtActiveKeyId,
    };

    const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(
      JSON.stringify(payload),
    )}`;
    const privateKey = createPrivateKey(this.config.auth.jwtPrivateKey);
    const signature = sign(null, Buffer.from(signingInput), privateKey);
    return `${signingInput}.${base64UrlEncode(signature)}`;
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
    if (!encodedHeader || !encodedPayload || !encodedSignature) {
      throw this.invalidToken();
    }

    const header = JSON.parse(base64UrlDecode(encodedHeader).toString('utf8')) as {
      alg?: string;
      kid?: string;
    };

    if (header.alg !== 'EdDSA' || !header.kid) {
      throw this.invalidToken();
    }

    const publicKeyPem = this.config.auth.jwtPublicKeys[header.kid];
    if (!publicKeyPem) {
      throw this.invalidToken();
    }

    const publicKey = createPublicKey(publicKeyPem);
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const verified = verify(
      null,
      Buffer.from(signingInput),
      publicKey,
      base64UrlDecode(encodedSignature),
    );

    if (!verified) {
      throw this.invalidToken();
    }

    const payload = JSON.parse(
      base64UrlDecode(encodedPayload).toString('utf8'),
    ) as AccessTokenPayload;
    if (payload.exp <= Math.floor(Date.now() / 1000)) {
      throw new AppError({
        code: 'AUTH_TOKEN_EXPIRED',
        httpStatus: 401,
        message: 'The access token has expired.',
      });
    }

    return payload;
  }

  private invalidToken(): AppError {
    return new AppError({
      code: 'AUTH_TOKEN_INVALID',
      httpStatus: 401,
      message: 'The access token is invalid.',
    });
  }
}
