import {
  GIT_STYLE_NAME_MAX_LENGTH,
  GIT_STYLE_NAME_MIN_LENGTH,
  isValidGitStyleName,
  normalizeGitStyleName,
  normalizeGitStyleNameInput
} from "./gitName.js";

export const SESSION_NAME_MIN_LENGTH = GIT_STYLE_NAME_MIN_LENGTH;
export const SESSION_NAME_MAX_LENGTH = GIT_STYLE_NAME_MAX_LENGTH;

export function normalizeSessionName(input: string): string {
  return normalizeGitStyleName(input);
}

export function normalizeSessionNameInput(input: string): string {
  return normalizeGitStyleNameInput(input);
}

export function isValidSessionName(name: string): boolean {
  return isValidGitStyleName(name);
}
