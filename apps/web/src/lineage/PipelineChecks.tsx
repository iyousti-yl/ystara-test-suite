import { useState } from "react";
import { Button, CheckBox } from "@ui5/webcomponents-react";
import { refKey, type DspObjectRef, type Pipeline } from "@ystara/shared";
import { Dialog } from "../components/Dialog";
import { Fold, InfoButton, ToCheck } from "../components/Info";
import { counted } from "../format";
import { typeLabel } from "../objectTypes";

/**
 * What a pipeline should be checked for (tables that several flows load, and
 * loops), as one quiet line that opens into a short list, instead of a banner
 * per finding: a real process can have a dozen of them. Each table with
 * several loaders gets "Choose loaders" when the loaders can be changed here;
 * each loop folds its steps away.
 */
export function PipelineChecks(props: { pipeline: Pipeline; onIgnore?: (writers: DspObjectRef[]) => void; busy?: boolean }) {
  const { pipeline, onIgnore, busy } = props;
  const [choosing, setChoosing] = useState<Pipeline["ambiguousWriters"][number]>();
  const [loop, setLoop] = useState<number>();
  const several = pipeline.ambiguousWriters;
  const loops = pipeline.cycles;
  if (several.length === 0 && loops.length === 0) return null;

  const findings = [several.length > 0 && `${counted(several.length, "table")} loaded by several flows`, loops.length > 0 && counted(loops.length, "loop")].filter(Boolean);
  return (
    <>
      <ToCheck
        label="To check in this pipeline"
        summary={
          <>
            <strong>To check:</strong> {findings.join(" · ")}
          </>
        }
      >
        {several.length > 0 && (
          <div className="checks-group">
            <div className="checks-group-head">
              <span>Loaded by several flows</span>
              <InfoButton label="About tables loaded by several flows">
                Every flow that loads these tables was followed upstream, so steps of another process may be in this pipeline. Keep the loaders that belong to it and
                ignore the others: the steps, the picture and its input tables are worked out again.
              </InfoButton>
            </div>
            <ul className="checks-list">
              {several.map((a) => (
                <li key={refKey(a.table)}>
                  <span className="mono wrap-anywhere">{a.table.technicalName}</span>
                  <span className="muted">{counted(a.writers.length, "loader")}</span>
                  {onIgnore && (
                    <Button design="Transparent" disabled={busy} onClick={() => setChoosing(a)}>
                      Choose loaders
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {loops.length > 0 && (
          <div className="checks-group">
            <div className="checks-group-head">
              <span>Loops</span>
              <InfoButton label="About loops">
                These steps feed each other, so their order can&apos;t be worked out. Snapshots still measure them, but a scenario can&apos;t run through a loop. A loop
                often goes away once the loaders of another process are ignored.
              </InfoButton>
            </div>
            <ul className="checks-list">
              {loops.map((steps, i) => (
                <li key={steps.map(refKey).join()}>
                  <Fold
                    open={loop === i}
                    onToggle={(o) => setLoop(o ? i : undefined)}
                    title={<span className="mono wrap-anywhere">{steps[0].technicalName}</span>}
                    summary={`and ${counted(steps.length - 1, "more step")}`}
                  >
                    <ol className="checks-steps">
                      {steps.map((s) => (
                        <li key={refKey(s)}>
                          <span className="mono wrap-anywhere">{s.technicalName}</span> <span className="muted">{typeLabel(s.type)}</span>
                        </li>
                      ))}
                    </ol>
                  </Fold>
                </li>
              ))}
            </ul>
          </div>
        )}
      </ToCheck>
      {choosing && onIgnore && (
        <ChooseLoaders
          table={choosing.table}
          writers={choosing.writers}
          onClose={() => setChoosing(undefined)}
          onSave={(ignored) => {
            onIgnore(ignored);
            setChoosing(undefined);
          }}
        />
      )}
    </>
  );
}

/** The flows that load one table, each kept (followed) or ignored. */
function ChooseLoaders(props: { table: DspObjectRef; writers: DspObjectRef[]; onSave: (ignored: DspObjectRef[]) => void; onClose: () => void }) {
  const [kept, setKept] = useState(() => new Set(props.writers.map(refKey)));
  const ignored = props.writers.filter((w) => !kept.has(refKey(w)));
  return (
    <Dialog
      headerText="Choose loaders"
      onClose={props.onClose}
      footer={
        <div className="dialog-footer">
          <Button design="Emphasized" disabled={ignored.length === 0} onClick={() => props.onSave(ignored)}>
            {ignored.length ? `Ignore ${counted(ignored.length, "loader")}` : "Ignore loaders"}
          </Button>
          <Button design="Transparent" onClick={props.onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="dialog-body">
        <p>
          Keep the flows that load <span className="mono wrap-anywhere">{props.table.technicalName}</span> for this pipeline. The others are ignored: Ystara stops
          following them upstream. Nothing changes in Datasphere.
        </p>
        <ul className="loader-choices">
          {props.writers.map((w) => (
            <li key={refKey(w)}>
              <CheckBox
                checked={kept.has(refKey(w))}
                text={w.technicalName}
                wrappingType="Normal"
                className="mono"
                onChange={(e) =>
                  setKept((current) => {
                    const next = new Set(current);
                    if (e.target.checked) next.add(refKey(w));
                    else next.delete(refKey(w));
                    return next;
                  })
                }
              />
            </li>
          ))}
        </ul>
        {kept.size === 0 && <p className="muted">With every loader ignored, the table becomes an input table: scenarios give it test rows.</p>}
      </div>
    </Dialog>
  );
}
