import type { DspObject, DspObjectRef, LineageGraph } from "@ystara/shared";

/**
 * Connection details for one Datasphere tenant. Secrets arrive decrypted from
 * the API layer; this package never persists them.
 */
export interface TenantConnection {
  host: string;
  oauth: {
    clientId: string;
    clientSecret: string;
    authorizationUrl: string;
    tokenUrl: string;
  };
  /** Optional database user for SQL access to the test space (Open SQL schema). */
  database?: {
    host: string;
    port: number;
    user: string;
    password: string;
  };
}

/**
 * The connector interface. There are two implementations planned:
 *  - LocalConnector: runs the CLI and SQL from the platform's worker (v1, hosted).
 *  - RemoteRunnerConnector: forwards the same calls to a runner the customer hosts (later).
 * Keeping every Datasphere interaction behind this interface is what makes the
 * second one a drop-in.
 */
export interface Connector {
  listSpaces(): Promise<string[]>;
  listObjects(space: string): Promise<DspObjectRef[]>;
  readObject(ref: DspObjectRef): Promise<DspObject>;
  scanSpaces(spaces: string[]): Promise<LineageGraph>;
  /** Deploy a (possibly rewritten) object definition into a space. Returns false if the type is not deployable. */
  deployObject(space: string, definition: unknown): Promise<boolean>;
  runTaskChain(space: string, technicalName: string): Promise<{ started: boolean; detail?: string }>;
  query(space: string, sql: string): Promise<Record<string, unknown>[]>;
}
