// The parts of hdb (SAP's JavaScript client for SAP HANA, no types of its own) that sql.ts uses.
declare module "hdb" {
  type Callback<T = void> = (err: Error | null, result: T) => void;
  interface Statement {
    exec(params: unknown[], cb: Callback<unknown>): void;
    drop(cb: Callback): void;
  }
  interface Client {
    connect(cb: Callback): void;
    exec(sql: string, cb: Callback<unknown>): void;
    prepare(sql: string, cb: Callback<Statement>): void;
    disconnect(cb: Callback): void;
    close(): void;
    on(event: "error", listener: (err: Error) => void): void;
  }
  const hdb: { createClient(options: { host: string; port: number; user: string; password: string; useTLS?: boolean }): Client };
  export default hdb;
}
