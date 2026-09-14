import type { LoggerOptions } from 'pino';
import pino from 'pino';
import type { AppConfig } from '../../config/config.types';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers.set-cookie',
  'password',
  '*.password',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'otp',
  '*.otp',
  'totpSecret',
  '*.totpSecret',
  'signedUrl',
  '*.signedUrl',
  'uploadUrl',
  '*.uploadUrl',
  '*.*.uploadUrl',
  '*.*.*.uploadUrl',
  'downloadUrl',
  '*.downloadUrl',
  '*.*.downloadUrl',
  '*.*.*.downloadUrl',
  'url',
  '*.url',
  '*.*.url',
  '*.*.*.url',
  'body.url',
  'body.*.url',
  'body.*.*.url',
  'err.message',
  'err.stack',
  'msg',
];

export function createLoggerOptions(config: AppConfig): LoggerOptions {
  return {
    level: config.logging.level,
    ...(config.env === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: !('NO_COLOR' in process.env),
              customColors: 'trace:gray,debug:cyan,info:green,warn:yellow,error:red,fatal:bgRed',
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname',
            },
          },
        }
      : {}),
    redact: {
      paths: redactPaths,
      censor: (value, path) => censorLogValue(value, path),
    },
  };
}

export function createLogger(config: AppConfig) {
  return pino(createLoggerOptions(config));
}

function censorLogValue(value: unknown, path: string[]): unknown {
  const key = path.join('.');
  if (
    key.endsWith('url') ||
    key.endsWith('Url') ||
    key === 'err.message' ||
    key === 'err.stack' ||
    key === 'msg'
  ) {
    if (typeof value === 'string' && !isSignedUrl(value)) return value;
  }
  return '[REDACTED]';
}

function isSignedUrl(value: string): boolean {
  return /([?&](X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|signature)=)/i.test(value);
}
