export interface EmailSendInput {
  to: string;
  subject: string;
  text: string;
  idempotencyKey?: string;
}

export interface EmailSendResult {
  providerMessageId?: string;
  supportsIdempotency: boolean;
}

export class MessagingProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly invalidDestination = false,
    readonly acceptedBeforeFailure = false,
  ) {
    super(message);
    this.name = 'MessagingProviderError';
  }
}

export interface EmailProvider {
  readonly supportsIdempotency: boolean;
  sendEmail(input: EmailSendInput): Promise<EmailSendResult>;
}

export class LoggingEmailProvider implements EmailProvider {
  readonly supportsIdempotency = true;

  async sendEmail(input: EmailSendInput): Promise<EmailSendResult> {
    return {
      providerMessageId: `local-email:${input.idempotencyKey ?? input.to}`,
      supportsIdempotency: this.supportsIdempotency,
    };
  }
}
