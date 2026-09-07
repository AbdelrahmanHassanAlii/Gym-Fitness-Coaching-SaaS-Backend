import { createHmac, randomBytes } from 'node:crypto';
import type { AppConfig } from '../../config/config.types';
import { base64UrlEncode, safeEqual, sha256Digest } from './auth-codec';

export class CredentialDigests {
  constructor(private readonly config: AppConfig) {}

  randomSecret(byteLength = 32): string {
    return base64UrlEncode(randomBytes(byteLength));
  }

  hashHighEntropySecret(secret: string): string {
    return sha256Digest(secret);
  }

  hmacLowEntropySecret(secret: string, context: string): string {
    return createHmac('sha256', this.config.auth.otpHmacSecret)
      .update(context)
      .update('\0')
      .update(secret)
      .digest('base64url');
  }

  matches(storedDigest: string, presentedDigest: string): boolean {
    return safeEqual(storedDigest, presentedDigest);
  }
}
