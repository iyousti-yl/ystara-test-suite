import { useRef, useState } from "react";
import { Button, Menu, MenuItem } from "@ui5/webcomponents-react";

export interface MoreAction {
  text: string;
  icon: string;
  onClick: () => void;
  disabled?: boolean;
}

/**
 * Actions a page needs now and then, such as Delete or Remove, kept out of the
 * way behind a "…" button so the page's one primary action stands out. Left
 * out (false or undefined) actions don't show; with none left, neither does
 * the button.
 *
 * The picked action runs once the menu has closed and handed the focus back
 * to "…", so a dialog it opens gives the focus back to "…" too (Dialog).
 */
export function MoreActions({ actions, label = "More actions" }: { actions: (MoreAction | false | undefined | null)[]; label?: string }) {
  const [opener, setOpener] = useState<HTMLElement>();
  const picked = useRef<MoreAction>(undefined);
  const shown = actions.filter((a): a is MoreAction => !!a);
  if (shown.length === 0) return null;
  return (
    <>
      <Button design="Transparent" icon="overflow" tooltip={label} accessibleName={label} onClick={(e) => setOpener(e.currentTarget ?? undefined)} />
      <Menu
        open={opener !== undefined}
        opener={opener}
        onClose={() => {
          setOpener(undefined);
          const action = picked.current;
          picked.current = undefined;
          action?.onClick();
        }}
        onItemClick={(e) => {
          picked.current = shown[Number(e.detail.item.dataset.index)];
        }}
      >
        {shown.map((a, i) => (
          <MenuItem key={a.text} data-index={i} text={a.text} icon={a.icon} disabled={a.disabled} />
        ))}
      </Menu>
    </>
  );
}
