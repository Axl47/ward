// Control-socket API shared by wardd (server) and the CLI (client): HTTP over
// the Unix socket at CONTROL_SOCKET, JSON bodies.
import { request } from "node:http";
import { CONTROL_SOCKET } from "./paths.ts";

export interface PortInfo {
  /** Port inside the ward. */
  readonly ward: number;
  /** Host port on 127.0.0.1 that reaches it. */
  readonly host: number;
  /** Whether something in the ward is listening on it right now. */
  readonly listening: boolean;
}

export interface WardInfo {
  readonly id: string;
  readonly repo: string;
  readonly worktree: string;
  /** T3 threads whose worktree this is, as of the last reconcile. */
  readonly threadIds: readonly string[];
  readonly slot: number;
  readonly running: boolean;
  readonly ports: readonly PortInfo[];
}

export type UpResult =
  | { readonly enabled: false; readonly reason: string }
  | { readonly enabled: true; readonly ward: WardInfo };

export interface Routes {
  "POST /up": { body: { worktree: string }; result: UpResult };
  /** With worktree, acts only if the ward is that worktree's. */
  "POST /stop": { body: { id: string; worktree?: string }; result: { stopped: boolean } };
  /** Moves the ward's data to the trash, or deletes it now with `now`. */
  "POST /rm": { body: { id: string; worktree?: string; now?: boolean }; result: { removed: boolean } };
  "POST /port": { body: { id: string; port: number }; result: { host: number } };
  /**
   * Starts the ward if needed, then its desktop; with `thread`, the desktop of a
   * T3 thread that has no ward, whose programs start in `cwd`. Answers once the desktop is up,
   * or with `ward`, the thread's warded worktree, whose desktop it should use instead.
   */
  "POST /desktop": { body: { id: string; worktree?: string } | { thread: string; cwd: string }; result: { ward?: string } };
  "POST /gc": { body: Record<string, never>; result: { actions: string[] } };
  /** Starts the host's adb server, which a ward's adb can reach but not start (bin/ward adb-server). */
  "POST /adb-server": { body: Record<string, never>; result: { ok: boolean } };
  "GET /ls": { body: Record<string, never>; result: WardInfo[] };
}

export type Route = keyof Routes;

/** wardd → broker (src/broker.js), over Node IPC. */
export type BrokerRequest =
  | {
      readonly t: "connect";
      readonly req: number;
      /** Addresses to try in order, e.g. ["127.0.0.1", "::1"]. */
      readonly hosts: readonly string[];
      readonly port: number;
    }
  /** Listen on the ward's 127.0.0.1:port and hand each connection to wardd ("accepted"), which relays it to the host's. */
  | { readonly t: "relay"; readonly port: number }
  | { readonly t: "unrelay"; readonly port: number };

/** broker → wardd; "connected" and "accepted" come with the socket. */
export type BrokerReply =
  | { readonly t: "ready" }
  | { readonly t: "connected"; readonly req: number }
  | { readonly t: "failed"; readonly req: number; readonly message: string }
  | { readonly t: "accepted"; readonly port: number };

export class WardError extends Error {}

/** Call wardd. Rejects with WardError carrying the daemon's message on failure. */
export function call<R extends Route>(route: R, body: Routes[R]["body"]): Promise<Routes[R]["result"]> {
  const [method, path] = route.split(" ") as [string, string];
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: CONTROL_SOCKET, method, path }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode === 200) return resolve(JSON.parse(data) as Routes[R]["result"]);
        let message = `wardd answered HTTP ${res.statusCode}`;
        try {
          message = (JSON.parse(data) as { error: string }).error;
        } catch {}
        reject(new WardError(message));
      });
    });
    req.on("error", reject);
    // Generous: `up` may wait up to 60s for a ward to become ready.
    req.setTimeout(70_000, () => req.destroy(new WardError("wardd did not answer within 70s")));
    req.end(method === "GET" ? undefined : JSON.stringify(body));
  });
}
