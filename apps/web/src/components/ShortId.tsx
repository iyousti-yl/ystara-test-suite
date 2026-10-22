import { useState } from "react";
import { Button } from "@ui5/webcomponents-react";

/** "sb-1a2b3c4d…!b3650": the start and end of a long ID that fit on one line. */
export const shortened = (id: string, start = 14, end = 8) => (id.length <= start + end + 1 ? id : `${id.slice(0, start)}…${id.slice(-end)}`);

/**
 * A long ID (a technical client's) cut to its start and end on one line, the
 * whole ID in its tooltip, and a button that copies the whole of it.
 */
export function ShortId({ id, what }: { id: string; what: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="short-id">
      <span className="mono" title={id}>
        {shortened(id)}
      </span>
      <Button
        design="Transparent"
        icon={copied ? "accept" : "copy"}
        tooltip={copied ? "Copied" : `Copy the whole ${what}`}
        accessibleName={`Copy the whole ${what}`}
        onClick={() =>
          void navigator.clipboard.writeText(id).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
      />
    </span>
  );
}
