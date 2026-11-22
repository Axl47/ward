import assert from "node:assert/strict";
import { once } from "node:events";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { after, test } from "node:test";
import { acceptAdb, ask, frame, needsDevice } from "../src/adb.ts";

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

const dial = (port: number) => {
  const socket = connect({ host: "127.0.0.1", port });
  return once(socket, "connect").then(() => socket);
};

/** Everything a socket receives until the other side ends. */
async function drain(socket: Socket): Promise<string> {
  let text = "";
  for await (const chunk of socket) text += String(chunk);
  return text;
}

/**
 * A ward's port 5037 as wardd serves it, with a stand-in for the ward's adb
 * server that answers with what it was sent. `calls` gets "device" each time
 * the ward's device is asked for.
 */
async function ward(calls: string[], device: () => Promise<unknown> = async () => {}): Promise<number> {
  const server = await listen(createServer((socket) => socket.once("data", (sent: Buffer) => socket.end(`got ${sent.toString()}`))));
  return listen(
    createServer({ pauseOnConnect: true }, (client) => {
      void acceptAdb(client, { device: () => (calls.push("device"), device()), server: () => dial(server) });
    }),
  );
}

test("requests about the adb server don't need the ward's device; anything else does", () => {
  for (const request of ["host:version", "host:kill", "host:host-features", "host:connect:10.0.0.2:5555", "host:mdns:check"])
    assert.equal(needsDevice(request), false, request);
  for (const request of ["host:devices", "host:devices-l", "host:track-devices", "host:transport-any", "host:tport:serial:emulator-5584", "host-serial:emulator-5584:get-state", "host:features", "something new"])
    assert.equal(needsDevice(request), true, request);
});

test("a request about the server goes to the ward's adb server without starting the device", async () => {
  const calls: string[] = [];
  const client = await dial(await ward(calls));
  client.write(frame("host:version"));
  assert.equal(await drain(client), "got 000chost:version");
  assert.deepEqual(calls, []);
});

test("a request about a device starts the ward's device first, then passes on unchanged with what follows it", async () => {
  const calls: string[] = [];
  let started = false;
  const port = await ward(calls, async () => {
    await new Promise((r) => setTimeout(r, 50));
    started = true;
  });
  const client = await dial(port);
  client.write(`${frame("host:transport-any")}0008shell:id`); // both in one packet, as adb may send them
  const answer = await drain(client);
  assert.equal(started, true);
  assert.equal(answer, "got 0012host:transport-any0008shell:id");
  assert.deepEqual(calls, ["device"]);
});

test("a device that can't start fails the request the way adb does, with the reason", async () => {
  const client = await dial(await ward([], () => Promise.reject(new Error("all 8 ward devices are in use"))));
  client.write(frame("host:devices"));
  assert.equal(await drain(client), `FAIL${frame("ward: all 8 ward devices are in use")}`);
});

test("what isn't an adb request is dropped", async () => {
  const calls: string[] = [];
  const client = await dial(await ward(calls));
  client.write("GET / HTTP/1.1\r\n\r\n");
  assert.equal(await drain(client), "");
  assert.deepEqual(calls, []);
});

test("ask returns an adb server's answer, and throws with its reason when it fails the request", async () => {
  const answers = new Map([
    [frame("host:devices"), `OKAY${frame("emulator-5584\tdevice\n")}`],
    [frame("host:nonsense"), `FAIL${frame("unknown host service")}`],
  ]);
  // In pieces, as a socket may deliver it.
  const port = await listen(
    createServer((socket) =>
      socket.once("data", (sent: Buffer) => {
        const answer = answers.get(sent.toString()) ?? "";
        socket.write(answer.slice(0, 6), () => setTimeout(() => socket.end(answer.slice(6)), 10));
      }),
    ),
  );
  assert.equal(await ask(await dial(port), "host:devices"), "emulator-5584\tdevice\n");
  await assert.rejects(ask(await dial(port), "host:nonsense"), /unknown host service/);
});
