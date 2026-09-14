import { describe, expect, test } from 'bun:test';
import pino from 'pino';
import type { AppConfig } from '../src/config/config.types';
import { createLoggerOptions } from '../src/core/logging/logger';

describe('logger redaction', () => {
  test('redacts signed upload and download URL credentials in structured logs', () => {
    const lines: string[] = [];
    const logger = pino(
      createLoggerOptions({
        logging: { level: 'info' },
        env: 'test',
      } as AppConfig),
      {
        write(chunk) {
          lines.push(String(chunk));
        },
      },
    );
    const signed =
      'https://storage.example.com/private/key?X-Amz-Credential=AKIA%2Fscope&X-Amz-Signature=abc&X-Amz-Security-Token=token';
    logger.info({
      uploadUrl: signed,
      body: { data: { downloadUrl: signed, publicUrl: 'https://example.com/help' } },
      err: new Error(`failed for ${signed}`),
    });

    const output = lines.join('\n');
    expect(output).not.toContain('X-Amz-Signature');
    expect(output).not.toContain('X-Amz-Credential');
    expect(output).not.toContain('X-Amz-Security-Token');
    expect(output).not.toContain(signed);
    expect(output).toContain('https://example.com/help');
  });
});
