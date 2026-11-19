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
  "POST /stop": { body: { id: string }; result: { stopped: boolean } };
  "POST /rm": { body: { id: string }; result: { removed: boolean } };
  "POST /port": { body: { id: string; port: number }; result: { host: number } };
  "POST /gc": { body: Record<string, never>; result: { actions: string[] } };
  "GET /ls": { body: Record<string, never>; result: WardInfo[] };
}

export type Route = keyof Routes;

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
    req.end(method === "GET" ? undefined : JSON.stringify(body));
  });
}
