import { MessagingProviderError } from './email.provider';

export interface PushSendInput {
  token: string;
  title: string;
  body: string;
  idempotencyKey?: string;
}

export interface PushSendResult {
  providerMessageId?: string;
  supportsIdempotency: boolean;
}

export interface PushProvider {
  readonly supportsIdempotency: boolean;
  sendPush(input: PushSendInput): Promise<PushSendResult>;
}

export class LoggingPushProvider implements PushProvider {
  readonly supportsIdempotency = false;

  async sendPush(input: PushSendInput): Promise<PushSendResult> {
    if (!input.token.trim()) {
      throw new MessagingProviderError('Invalid push token', 'PUSH_TOKEN_INVALID', false, true);
    }
    return {
      providerMessageId: `local-push:${input.idempotencyKey ?? 'no-key'}`,
      supportsIdempotency: this.supportsIdempotency,
    };
  }
}
