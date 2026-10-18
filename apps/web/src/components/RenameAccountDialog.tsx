import { useState } from "react";
import { Button, Dialog, Input, Label } from "@ui5/webcomponents-react";
import { ErrorStrip } from "./Feedback";

/**
 * A new name for an account: its admins rename it on Users and roles, the
 * operator in the operator panel. Names are unique, so a taken one comes back
 * from the API as an error shown here.
 */
export function RenameAccountDialog(props: { current: string; pending: boolean; error: Error | null; onRename: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState(props.current);
  const changed = name.trim() !== "" && name.trim() !== props.current;
  return (
    <Dialog
      open
      headerText={`Rename ${props.current}`}
      onClose={props.onClose}
      footer={
        <div className="dialog-footer">
          <Button design="Emphasized" disabled={!changed || props.pending} onClick={() => props.onRename(name.trim())}>
            Rename
          </Button>
          <Button design="Transparent" onClick={props.onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="dialog-body">
        <Label for="account-new-name" required>
          Account name
        </Label>
        <Input id="account-new-name" className="full-width" value={name} maxlength={100} onInput={(e) => setName(e.target.value)} />
        <p className="muted">Every member sees the new name at once. Tenants, pipelines and sign-ins don&apos;t change.</p>
        <ErrorStrip error={props.error} />
      </div>
    </Dialog>
  );
}
