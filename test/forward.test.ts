import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { after, test } from "node:test";
import type { BrokerReply, BrokerRequest } from "../src/api.ts";
import { mappedServer, relayToHost, splice } from "../src/splice.ts";

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
/** Relay port → what wardd does with a connection the broker accepted on it. */
const accepted = new Map<number, (socket: Socket) => void>();
broker.on("message", (reply: BrokerReply, socket: unknown) => {
  if (reply.t === "accepted") accepted.get(reply.port)?.(socket as Socket);
  else if (reply.t === "unrelayed") unrelayed.get(reply.port)?.();
  else if (reply.t !== "ready") pending.get(reply.req)?.(socket as Socket | undefined);
});
/** Port → called when the broker says it could not listen there. */
const unrelayed = new Map<number, () => void>();
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

/** Resolves once something accepts on the port, or with false after `ms`. */
async function accepting(port: number, ms = 2000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
    const s = connect({ host: "127.0.0.1", port });
    const ok = await new Promise<boolean>((r) => s.once("connect", () => r(true)).once("error", () => r(false)));
    s.destroy();
    if (ok) return true;
  }
  return false;
}

// T3's device daemon the other way round: the broker listens on a relay port and
// wardd connects what it accepts to the host's port. Without a namespace both
// sides share a loopback, so the test relays a free port to the service's.
test("a relay port reaches the host service, half-close included, until it is unrelayed", async () => {
  const echo = createServer({ allowHalfOpen: true }, (s) => {
    let n = 0;
    s.on("data", (d: Buffer) => (n += d.length)).on("end", () => s.end(`GOT ${n}`));
  });
  const hostPort = await listen(echo);
  const free = createServer();
  const relayPort = await listen(free);
  free.close();
  accepted.set(relayPort, (s) => relayToHost(s, hostPort));
  broker.send({ t: "relay", port: relayPort } satisfies BrokerRequest);
  assert.ok(await accepting(relayPort));
  assert.equal(await exchange(relayPort, (s) => s.end("abcdef")), "GOT 6");
  broker.send({ t: "unrelay", port: relayPort } satisfies BrokerRequest);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await accepting(relayPort, 100), false);
});

// A ward's port 5037 when an adb server took it before the broker did: wardd has
// to hear of it, to tell that server to exit and ask again.
test("a relay port that is taken is reported, and relayed when asked again once it is free", async () => {
  const holder = createServer();
  const port = await listen(holder);
  const reported = new Promise<void>((resolve) => unrelayed.set(port, resolve));
  broker.send({ t: "relay", port } satisfies BrokerRequest);
  await reported;
  holder.close();
  await once(holder, "close");
  accepted.set(port, (s) => s.on("error", () => {}).end("relayed")); // `accepting` hangs up on its probe
  broker.send({ t: "relay", port } satisfies BrokerRequest);
  assert.ok(await accepting(port));
  assert.equal(await exchange(port, (s) => s.end()), "relayed");
  broker.send({ t: "unrelay", port } satisfies BrokerRequest);
});
