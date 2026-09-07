import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import type { AppConfig } from '../../config/config.types';
import { base64UrlDecode, base64UrlEncode } from './auth-codec';

export class TotpService {
  constructor(private readonly config: AppConfig) {}

  generateSecret(): string {
    return base64UrlEncode(randomBytes(20));
  }

  encryptSecret(secret: string): string {
    const key = Buffer.from(this.config.auth.totpEncryptionKey, 'base64');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${base64UrlEncode(iv)}.${base64UrlEncode(tag)}.${base64UrlEncode(ciphertext)}`;
  }

  decryptSecret(encryptedSecret: string): string {
    const [encodedIv, encodedTag, encodedCiphertext] = encryptedSecret.split('.');
    if (!encodedIv || !encodedTag || !encodedCiphertext) {
      throw new Error('Invalid encrypted TOTP secret format');
    }

    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(this.config.auth.totpEncryptionKey, 'base64'),
      base64UrlDecode(encodedIv),
    );
    decipher.setAuthTag(base64UrlDecode(encodedTag));
    return Buffer.concat([
      decipher.update(base64UrlDecode(encodedCiphertext)),
      decipher.final(),
    ]).toString('utf8');
  }

  verifyCode(secret: string, code: string, now = new Date(), windowSteps = 1): boolean {
    const normalizedCode = code.trim();
    for (let offset = -windowSteps; offset <= windowSteps; offset += 1) {
      if (this.generateCode(secret, now, offset) === normalizedCode) return true;
    }
    return false;
  }

  private generateCode(secret: string, now: Date, stepOffset: number): string {
    const counter = Math.floor(now.getTime() / 1000 / 30) + stepOffset;
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64BE(BigInt(counter));
    const hmac = createHmac('sha1', base64UrlDecode(secret)).update(buffer).digest();
    const lastByte = hmac.at(-1);
    if (lastByte === undefined) {
      throw new Error('Unable to generate TOTP code');
    }

    const offset = lastByte & 0x0f;
    const b0 = hmac.at(offset);
    const b1 = hmac.at(offset + 1);
    const b2 = hmac.at(offset + 2);
    const b3 = hmac.at(offset + 3);
    if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) {
      throw new Error('Unable to generate TOTP code');
    }

    const binary = ((b0 & 0x7f) << 24) | ((b1 & 0xff) << 16) | ((b2 & 0xff) << 8) | (b3 & 0xff);
    return String(binary % 1_000_000).padStart(6, '0');
  }
}
