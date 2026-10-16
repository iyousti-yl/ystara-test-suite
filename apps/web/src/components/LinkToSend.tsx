import { useState } from "react";
import { Button, Input, MessageStrip } from "@ui5/webcomponents-react";
import { formatDateTime } from "../format";

/**
 * A one-time link to pass on (an invitation or a reset), with a Copy button.
 * Ystara sends no email, and stores only the link's hash, so this is the only
 * time it can be shown.
 */
export function LinkToSend({ path, to, until, purpose }: { path: string; to: string; until: string; purpose: string }) {
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}${path}`;
  return (
    <div className="dialog-body">
      <p>
        Send this link to {to}. It works once, until {formatDateTime(until)}. {purpose}
      </p>
      <div className="copy-row">
        <Input readonly value={link} className="mono" accessibleName="Link" />
        <Button
          icon="copy"
          onClick={() =>
            void navigator.clipboard.writeText(link).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <MessageStrip design="Critical" hideCloseButton>
        Ystara shows this link only now. If it gets lost, make a new one.
      </MessageStrip>
    </div>
  );
}
