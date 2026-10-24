// The few Bun and Node globals the server uses, so `tsc` can check server/
// without a bun-types dependency (the repo has no npm dependencies). Only
// what server/*.ts touches; widen it when the server needs more.

interface ImportMeta {
  /** True when this file is the entry point (`bun server/bun.ts`). */
  readonly main: boolean;
}

declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exit(code?: number): never;
  on(event: 'SIGTERM' | 'SIGINT', fn: () => void): void;
};

declare const Buffer: { byteLength(s: string): number };

declare namespace Bun {
  interface ServerWebSocket<T> {
    data: T;
    send(data: string): number;
    close(code?: number, reason?: string): void;
  }
  interface Server {
    readonly port: number;
    upgrade<T>(req: Request, o: { data: T }): boolean;
    requestIP(req: Request): { address: string } | null;
    stop(closeActive?: boolean): void;
  }
  interface ServeOptions<T> {
    port?: number;
    hostname?: string;
    fetch(req: Request, server: Server): Response | undefined | Promise<Response | undefined>;
    websocket: {
      maxPayloadLength?: number;
      idleTimeout?: number;
      open?(ws: ServerWebSocket<T>): void;
      message(ws: ServerWebSocket<T>, msg: string | Uint8Array): void;
      close?(ws: ServerWebSocket<T>, code: number, reason: string): void;
    };
  }
  function serve<T>(o: ServeOptions<T>): Server;
}

declare namespace Bun {
  const stdin: { stream(): ReadableStream<Uint8Array> };
}
