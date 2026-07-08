export const SESSION_NAME_MIN_LENGTH = 2;
export const SESSION_NAME_MAX_LENGTH = 32;
export const SESSION_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function normalizeSessionName(input: string): string {
  return normalizeSessionNameInput(input).replace(/-+$/g, "");
}

export function normalizeSessionNameInput(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/g, "")
    .slice(0, SESSION_NAME_MAX_LENGTH);
}

export function isValidSessionName(name: string): boolean {
  return name.length >= SESSION_NAME_MIN_LENGTH && name.length <= SESSION_NAME_MAX_LENGTH && SESSION_NAME_PATTERN.test(name);
}
