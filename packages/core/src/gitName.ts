export const GIT_STYLE_NAME_MIN_LENGTH = 2;
export const GIT_STYLE_NAME_MAX_LENGTH = 32;

const FORBIDDEN_GIT_NAME_CHARACTERS = /[\u0000-\u0020\u007f~^:?*[\\]+/g;
const HAS_FORBIDDEN_GIT_NAME_CHARACTER = /[\u0000-\u0020\u007f~^:?*[\\]/;

export function normalizeGitStyleNameInput(input: string): string {
  return input
    .normalize("NFKC")
    .replace(FORBIDDEN_GIT_NAME_CHARACTERS, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/@\{/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^[-/.]+/g, "")
    .replace(/\/\.+/g, "/")
    .slice(0, GIT_STYLE_NAME_MAX_LENGTH);
}

export function normalizeGitStyleName(input: string): string {
  return normalizeGitStyleNameInput(input).replace(/[/.]+$/g, "");
}

export function isValidGitStyleName(value: string): boolean {
  if (value.length < GIT_STYLE_NAME_MIN_LENGTH || value.length > GIT_STYLE_NAME_MAX_LENGTH) return false;
  if (value === "@" || value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".")) return false;
  if (HAS_FORBIDDEN_GIT_NAME_CHARACTER.test(value)) return false;
  if (value.includes("..") || value.includes("@{") || value.includes("//")) return false;
  return value.split("/").every((component) => Boolean(component) && !component.startsWith(".") && !component.endsWith(".lock"));
}
