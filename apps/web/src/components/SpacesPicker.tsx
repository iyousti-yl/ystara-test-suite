import { useState } from "react";
import { CheckBox, Input, Label, MessageStrip, RadioButton } from "@ui5/webcomponents-react";
import type { SpaceScope } from "@ystara/shared";
import { useMe } from "../api";
import { parseSpaceIds } from "../fields";

/**
 * Which spaces a member sees: every space, or only some, ticked from those the
 * account's scans covered, plus any other space ID typed in (for a space not
 * scanned yet). `onChange` gets null for every space, the list otherwise, and
 * undefined while the choice isn't complete (no space, or a typo).
 */
export function SpacesPicker({ id, value, known, onChange }: { id: string; value: SpaceScope; known: string[]; onChange: (spaces: SpaceScope | undefined) => void }) {
  const [limited, setLimited] = useState(value !== null);
  const [ticked, setTicked] = useState(() => new Set((value ?? []).filter((s) => known.includes(s))));
  const [typed, setTyped] = useState(() => (value ?? []).filter((s) => !known.includes(s)).join(", "));
  const others = parseSpaceIds(typed);

  const report = (next: { limited: boolean; ticked: Set<string>; typed: string }) => {
    if (!next.limited) return onChange(null);
    const extra = parseSpaceIds(next.typed);
    const all = extra && [...new Set([...next.ticked, ...extra])].sort();
    onChange(all && all.length > 0 ? all : undefined);
  };
  const update = (change: Partial<{ limited: boolean; ticked: Set<string>; typed: string }>) => {
    const next = { limited, ticked, typed, ...change };
    setLimited(next.limited);
    setTicked(next.ticked);
    setTyped(next.typed);
    report(next);
  };

  return (
    <div className="spaces-picker" role="radiogroup" aria-label="Spaces">
      <RadioButton name={id} text="Every space" checked={!limited} onChange={() => update({ limited: false })} />
      <RadioButton name={id} text="Only some spaces" checked={limited} onChange={() => update({ limited: true })} />
      {limited && (
        <div className="spaces-picker-some">
          {known.length > 0 && (
            <div className="spaces-picker-known">
              {known.map((space) => (
                <CheckBox
                  key={space}
                  text={space}
                  checked={ticked.has(space)}
                  className="mono"
                  onChange={(e) => {
                    const next = new Set(ticked);
                    if (e.target.checked) next.add(space);
                    else next.delete(space);
                    update({ ticked: next });
                  }}
                />
              ))}
            </div>
          )}
          <Label for={`${id}-other`}>{known.length > 0 ? "Other space IDs" : "Space IDs"}</Label>
          <Input
            id={`${id}-other`}
            value={typed}
            placeholder="SALES, STOCK"
            valueState={others ? "None" : "Negative"}
            onInput={(e) => update({ typed: e.target.value })}
          >
            {!others && <div slot="valueStateMessage">Space IDs contain only letters, digits and underscores; separate them with commas.</div>}
          </Input>
          <span className="muted">
            They see pipelines whose output is in one of these spaces, with every step of them, and only these spaces of a scan, in every tenant of the account.
          </span>
        </div>
      )}
    </div>
  );
}

/** "Every space", or "SALES, STOCK". */
export const spacesLabel = (spaces: SpaceScope) => (spaces === null ? "Every space" : spaces.join(", "));

/** For a member limited to some spaces: which ones, on the pages that leave the others out. Nothing for everyone else. */
export function SpacesNote({ what }: { what: string }) {
  const spaces = useMe().data?.spaces;
  if (!spaces) return null;
  return (
    <MessageStrip design="Information" hideCloseButton className="block">
      Your access is limited to <span className="mono">{spaces.join(", ")}</span>: {what}
    </MessageStrip>
  );
}
