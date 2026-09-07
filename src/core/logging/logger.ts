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
      censor: '[REDACTED]',
    },
  };
}

export function createLogger(config: AppConfig) {
  return pino(createLoggerOptions(config));
}
