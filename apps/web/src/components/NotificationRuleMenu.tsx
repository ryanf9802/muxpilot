import type { NotificationRuleType } from "@muxpilot/core";
import { ContextMenuCheckboxItem } from "./ContextMenu.js";
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
          <ContextMenuCheckboxItem key={type} checked={enabled} disabled={disabled} onClick={() => onToggle(type, !enabled)}>
            {notificationRuleLabel(type)}
          </ContextMenuCheckboxItem>
        );
      })}
    </>
  );
}
