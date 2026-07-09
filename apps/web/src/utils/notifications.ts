import type { NotificationRuleType, NotificationSettings, NotificationTriggeredPayload, PushSubscriptionInput } from "@muxpilot/core";
import { api } from "../api/client.js";

export const NOTIFICATION_RULE_TYPES: readonly NotificationRuleType[] = ["done_task", "approval_gate", "status_change"];

export function notificationRuleLabel(type: NotificationRuleType): string {
  if (type === "done_task") return "Done task";
  if (type === "approval_gate") return "Approval gate";
  return "Status change";
}

export function notificationRulesLabel(rules: readonly NotificationRuleType[]): string {
  return rules.map(notificationRuleLabel).join(", ");
}

export function sessionNotificationRules(settings: NotificationSettings | null, sessionId: string): NotificationRuleType[] {
  return settings?.sessionRules[sessionId] ?? [];
}

export function globalNotificationRules(settings: NotificationSettings | null): NotificationRuleType[] {
  return settings?.globalRules ?? [];
}

export function notificationPushEnabled(settings: NotificationSettings | null): boolean {
  return settings?.delivery.pushEnabled ?? false;
}

export function notificationSoundEnabled(settings: NotificationSettings | null): boolean {
  return settings?.delivery.soundEnabled ?? true;
}

export function notificationToastMessage(payload: NotificationTriggeredPayload): string {
  return `${payload.sessionName}: ${notificationStatusLabel(payload.status)}`;
}

export function notificationStatusLabel(status: NotificationTriggeredPayload["status"]): string {
  if (status === "plan_ready") return "plan ready";
  return status.replace(/_/g, " ");
}

export function playNotificationBell(): void {
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) return;
  const context = new AudioContextConstructor();
  const gain = context.createGain();
  const oscillator = context.createOscillator();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(880, context.currentTime);
  oscillator.frequency.exponentialRampToValueAtTime(1320, context.currentTime + 0.08);
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.5);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.52);
  oscillator.onended = () => void context.close();
}

export function isPushNotificationAvailable(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  return (
    window.isSecureContext &&
    isInstalledPwa() &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export async function ensurePushSubscription(): Promise<boolean> {
  if (!isPushNotificationAvailable()) return false;
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return false;
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    await api.upsertPushSubscription(pushSubscriptionInput(existing));
    return true;
  }
  const { publicKey } = await api.notificationPushKey();
  if (!publicKey) return false;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToArrayBuffer(publicKey)
  });
  await api.upsertPushSubscription(pushSubscriptionInput(subscription));
  return true;
}

export async function disablePushSubscription(): Promise<void> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (!existing) return;
  await api.deletePushSubscription(existing.endpoint);
  await existing.unsubscribe();
}

function pushSubscriptionInput(subscription: PushSubscription): PushSubscriptionInput {
  const json = subscription.toJSON();
  return {
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime,
    keys: {
      p256dh: json.keys?.p256dh ?? "",
      auth: json.keys?.auth ?? ""
    }
  };
}

function urlBase64ToArrayBuffer(value: string): ArrayBuffer {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }
  return output.buffer;
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

function isInstalledPwa(): boolean {
  const standaloneNavigator = navigator as Navigator & { standalone?: boolean };
  return standaloneNavigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}
