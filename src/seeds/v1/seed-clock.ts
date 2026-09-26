export const seedNow = new Date('2026-01-15T10:00:00.000Z');
export const seedWorkspaceTimezone = 'Africa/Cairo';

export function offsetDays(days: number): Date {
  return new Date(seedNow.getTime() + days * 24 * 60 * 60 * 1000);
}
