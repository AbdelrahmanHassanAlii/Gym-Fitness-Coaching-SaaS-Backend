import { AppError } from '../../core/errors/app-error';

export const MAX_WORKSPACE_SEARCH_CODE_POINTS = 64;

export function normalizeWorkspaceSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, ' ');
}

export function workspaceNameForPersistence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      httpStatus: 400,
      message: 'Workspace name must not be empty.',
    });
  }
  return trimmed;
}

export function normalizeWorkspaceSearchQuery(value?: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeWorkspaceSearchText(value);
  if (!normalized) return undefined;
  if (Array.from(normalized).length > MAX_WORKSPACE_SEARCH_CODE_POINTS) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      httpStatus: 400,
      message: `Workspace search must not exceed ${MAX_WORKSPACE_SEARCH_CODE_POINTS} characters.`,
    });
  }
  return normalized;
}

export function workspaceNameSearchPrefixes(name: string): string[] {
  const codePoints = Array.from(normalizeWorkspaceSearchText(name)).slice(
    0,
    MAX_WORKSPACE_SEARCH_CODE_POINTS,
  );
  const prefixes = new Set<string>();
  for (let length = 1; length <= codePoints.length; length += 1) {
    prefixes.add(codePoints.slice(0, length).join(''));
  }
  return [...prefixes];
}
