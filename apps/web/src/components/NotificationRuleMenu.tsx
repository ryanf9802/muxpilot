import { Check } from "lucide-react";
import type { NotificationRuleType } from "@muxpilot/core";
import { NOTIFICATION_RULE_TYPES, notificationRuleLabel } from "../utils/notifications.js";

export function NotificationRuleMenu({
  enabledRules,
  onToggle,
  disabled = false
}: {
  enabledRules: readonly NotificationRuleType[];
  onToggle: (type: NotificationRuleType, enabled: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <>
      {NOTIFICATION_RULE_TYPES.map((type) => {
        const enabled = enabledRules.includes(type);
        return (
          <button key={type} type="button" role="menuitemcheckbox" aria-checked={enabled} disabled={disabled} onClick={() => onToggle(type, !enabled)}>
            <span className="menu-check-slot">{enabled ? <Check size={15} /> : null}</span>
            {notificationRuleLabel(type)}
          </button>
        );
      })}
    </>
  );
}
