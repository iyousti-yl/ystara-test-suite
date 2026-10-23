import { useEffect, useRef, useState } from "react";
import { Dialog as Ui5Dialog, type DialogDomRef, type DialogPropTypes } from "@ui5/webcomponents-react";

/**
 * Every dialog of the app. A page shows one only while it is open
 * (`{open && <XDialog />}`), so UI5 never closes it itself and can't put the
 * keyboard focus back where it was: this remembers the element that had the
 * focus when the dialog opened, and focuses it again once the dialog is gone,
 * if that element is still on the page (a button that opened it, not one on a
 * page left meanwhile).
 */
export function Dialog(props: Omit<DialogPropTypes, "open">) {
  const [opener] = useState(() => document.activeElement);
  const dialog = useRef<DialogDomRef>(null);
  useEffect(
    () => () => {
      // After React has removed the dialog: in development, StrictMode runs this once with the dialog still there.
      requestAnimationFrame(() => {
        if (!dialog.current?.isConnected && opener instanceof HTMLElement && opener.isConnected) opener.focus();
      });
    },
    [opener],
  );
  return <Ui5Dialog {...props} ref={dialog} open />;
}
