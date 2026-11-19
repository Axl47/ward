import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { after, test } from "node:test";
import type { BrokerReply, BrokerRequest } from "../src/api.ts";
import { mappedServer, splice } from "../src/splice.ts";

// The mapped-port path as wardd runs it, minus the namespace: a host listener asks
// the broker to dial a port, receives the socket over IPC and splices the two.
const broker = spawn(process.execPath, [new URL("../src/broker.js", import.meta.url).pathname], {
  stdio: ["ignore", "inherit", "inherit", "ipc"],
});
const servers: Server[] = [];
after(() => {
  broker.kill();
  for (const s of servers) s.close();
});
const pending = new Map<number, (socket: Socket | undefined) => void>();
broker.on("message", (reply: BrokerReply, socket: unknown) => {
  if (reply.t !== "ready") pending.get(reply.req)?.(socket as Socket | undefined);
});
let nextReq = 1;

async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

/** A host port that forwards to `port` the way a ward's mapped port does. */
function mapped(port: number): Promise<number> {
  return listen(
    mappedServer((client) => {
      const req = nextReq++;
      pending.set(req, (upstream) => (upstream ? splice(client, upstream) : client.destroy()));
      broker.send({ t: "connect", req, port, hosts: ["127.0.0.1"] } satisfies BrokerRequest);
    }),
  );
}

/** Connect, run fn on the socket, and collect everything received until close. */
async function exchange(port: number, fn: (s: Socket) => void): Promise<string> {
  const s = connect({ host: "127.0.0.1", port, allowHalfOpen: true });
  let received = "";
  s.setEncoding("latin1").on("data", (d: string) => (received += d)).on("end", () => s.end());
  fn(s);
  await once(s, "close");
  return received;
}

test("what a server sends before the client speaks, and its FIN, reach the client", async () => {
  const body = "HELLO\n" + "x".repeat(1 << 20);
  const port = await mapped(await listen(createServer((s) => s.end(body))));
  // Many at once, so sockets also wait in the broker's IPC queue.
  const got = await Promise.all(Array.from({ length: 50 }, () => exchange(port, () => {})));
  for (const g of got) assert.equal(g.length, body.length);
});

test("a client's half-close passes through and the reply after it arrives", async () => {
  const echo = createServer({ allowHalfOpen: true }, (s) => {
    let n = 0;
    s.on("data", (d: Buffer) => (n += d.length)).on("end", () => s.end(`GOT ${n}`));
  });
  const port = await mapped(await listen(echo));
  assert.equal(await exchange(port, (s) => s.end("abcdef")), "GOT 6");
});

test("a server's half-close passes through and what the client sends after it arrives", async () => {
  let resolveGot: (n: number) => void = () => {};
  const got = new Promise<number>((r) => (resolveGot = r));
  const server = createServer({ allowHalfOpen: true }, (s) => {
    let n = 0;
    s.end("BYE");
    s.on("data", (d: Buffer) => (n += d.length)).on("end", () => resolveGot(n)).on("error", () => resolveGot(-1));
  });
  const port = await mapped(await listen(server));
  const s = connect({ host: "127.0.0.1", port, allowHalfOpen: true });
  let received = "";
  s.setEncoding("latin1").on("data", (d: string) => (received += d));
  // Sends only after the server's FIN has arrived.
  s.on("end", () => setTimeout(() => s.end("abcdef"), 50));
  await once(s, "close");
  assert.equal(received, "BYE");
  assert.equal(await got, 6);
});
