import type { CliObjectKind } from "./readonly.js";
import type { ListedObject } from "./cli.js";

/**
 * What discovery needs from a tenant. Read-only by construction: there is no
 * method that could change anything.
 *
 * Two implementations are planned:
 *  - DatasphereCli: runs the CLI from the platform's worker or a developer machine (now).
 *  - A remote runner the customer hosts, forwarding the same calls (later).
 * Discovery depends only on this interface, so the second is a drop-in.
 */
export interface ObjectSource {
  listObjects(space: string, kind: CliObjectKind): Promise<ListedObject[]>;
  readObject(space: string, kind: CliObjectKind, technicalName: string): Promise<unknown>;
}
