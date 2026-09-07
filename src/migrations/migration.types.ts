import type { Db } from 'mongodb';

export interface Migration {
  id: string;
  description: string;
  up(db: Db): Promise<void>;
}
