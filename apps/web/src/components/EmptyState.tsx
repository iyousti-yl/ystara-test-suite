import type { ReactNode } from "react";
import { Icon } from "@ui5/webcomponents-react";

/** Where a list has nothing yet: an icon, one sentence on what goes here, and the one action that adds it. */
export function EmptyState({ icon, title, children, action }: { icon: string; title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <Icon name={icon} className="empty-state-icon" mode="Decorative" />
      <p className="empty-state-title">{title}</p>
      <p className="muted">{children}</p>
      {action}
    </div>
  );
}
