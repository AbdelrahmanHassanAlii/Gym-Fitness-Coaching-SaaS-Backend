import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';

export class SeedIdFactory {
  private readonly seen = new Map<string, string>();

  constructor(
    private readonly namespace: string,
    private readonly dataset: string,
  ) {}

  objectId(kind: string, logicalKey: string): ObjectId {
    const input = `v1|${this.namespace}|${this.dataset}|${kind}|${logicalKey}`;
    const hex = createHash('sha256').update(input).digest('hex').slice(0, 24);
    const existing = this.seen.get(hex);
    if (existing && existing !== input) {
      throw new Error(`Deterministic seed ObjectId collision for ${input} and ${existing}.`);
    }
    this.seen.set(hex, input);
    return new ObjectId(hex);
  }
}
