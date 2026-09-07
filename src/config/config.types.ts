export type NodeEnvironment = 'development' | 'test' | 'production';

export interface AppConfig {
  env: NodeEnvironment;
  app: {
    host: string;
    port: number;
    docsEnabled: boolean;
    trustProxy: boolean;
    allowedOrigins: string[];
  };
  mongo: {
    uri: string;
    dbName: string;
    connectTimeoutMs: number;
  };
  logging: {
    level: string;
  };
  worker: {
    id: string;
    outboxPollIntervalMs: number;
    outboxLockMs: number;
    outboxMaxAttempts: number;
    jobLeaseMs: number;
  };
  support: {
    defaultSessionMinutes: number;
    maxSessionMinutes: number;
  };
}
