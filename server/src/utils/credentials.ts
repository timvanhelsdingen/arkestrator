export const MIN_PASSWORD_LENGTH = 8;

export function readNonEmptyTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function readNonEmptyPassword(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.length > 0 ? value : null;
}

export function passwordLengthError(label = "Password"): string {
  return `${label} must be at least ${MIN_PASSWORD_LENGTH} characters`;
}
