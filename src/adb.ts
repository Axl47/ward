// adb inside a ward (docs/DESIGN.md: Devices). A ward runs a stock adb server of
// its own, on ADB_SERVER_PORT, and the only emulator that server can find is the
// ward's device, whose two ports the broker relays in from the host. So nothing
// here decides what a ward may reach; its network namespace does.
//
// What is here is how the device starts by itself. Port 5037, where every adb
// client looks for the server, is the broker's in a ward: it hands each
// connection to wardd, which reads the client's first request, starts the device
// if the request is about one, and then connects the client to the ward's server
// and copies bytes.
import type { Socket } from "node:net";
import { splice } from "./splice.ts";

/** Where adb clients look for the server: in a ward, the broker's, relayed to wardd. */
export const ADB_PORT = 5037;
/** Where a ward's own adb server listens. */
export const ADB_SERVER_PORT = 5038;
/** How long a connection may take to send its request. */
const REQUEST_TIMEOUT_MS = 30_000;
/** How long an adb server may take to answer `ask`. */
const ANSWER_TIMEOUT_MS = 10_000;

/** Requests about the adb server itself. Every other one is about a device, or lists them, so the ward's must be up to answer it. */
const SERVER_ONLY = /^host:(version|kill|host-features|server-status|reconnect-offline|(mdns|connect|disconnect|pair):.*)$/s;
export const needsDevice = (request: string) => !SERVER_ONLY.test(request);

/** A request or an answer's text as adb frames it: its length in four hex digits, then the text. */
export const frame = (text: string) => `${Buffer.byteLength(text).toString(16).padStart(4, "0")}${text}`;

/**
 * The first request on an adb connection, or undefined when the client sent
 * something else, nothing in time, or hung up. Reads exactly the request: what
 * follows it stays in the socket.
 */
function readRequest(socket: Socket): Promise<string | undefined> {
  return new Promise((resolve) => {
    let length: number | undefined;
    const done = (request: string | undefined) => {
      socket.off("readable", read).off("close", gone).off("timeout", gone).setTimeout(0);
      resolve(request);
    };
    const gone = () => done(undefined);
    const read = () => {
      if (length === undefined) {
        const head = socket.read(4) as Buffer | null;
        if (head === null) return;
        if (!/^[0-9a-fA-F]{4}$/.test(head.toString("latin1"))) return done(undefined);
        length = parseInt(head.toString("latin1"), 16);
      }
      const body = length === 0 ? Buffer.alloc(0) : (socket.read(length) as Buffer | null);
      if (body !== null) done(body.length === length ? body.toString() : undefined);
    };
    socket.on("readable", read).once("close", gone).setTimeout(REQUEST_TIMEOUT_MS, gone);
    read();
  });
}

/**
 * Ask an adb server one thing over a new connection to it and close it: the
 * text of its answer. Throws with the server's reason when it fails the request,
 * and when it doesn't answer in time.
 */
export function ask(server: Socket, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let answer = Buffer.alloc(0);
    const fail = (reason: string) => (server.destroy(), reject(new Error(reason)));
    server
      .setTimeout(ANSWER_TIMEOUT_MS, () => fail("the adb server did not answer"))
      .on("data", (chunk: Buffer) => {
        answer = Buffer.concat([answer, chunk]);
        if (answer.length < 8) return;
        const length = parseInt(answer.subarray(4, 8).toString("latin1"), 16);
        if (Number.isNaN(length)) return fail("the adb server answered with something that isn't adb's");
        if (answer.length < 8 + length) return;
        const text = answer.subarray(8, 8 + length).toString();
        if (answer.subarray(0, 4).toString("latin1") !== "OKAY") return fail(text);
        server.destroy();
        resolve(text);
      })
      .on("error", (error) => fail(error.message))
      .on("close", () => reject(new Error("the adb server hung up")));
    server.write(frame(request));
  });
}

/** The ward on the other end of an adb connection, as wardd knows it. */
export interface AdbWard {
  /** Start its device unless it is up, and have its adb server find it. */
  readonly device: () => Promise<unknown>;
  /** A new connection to its adb server, which is started first if it isn't running. */
  readonly server: () => Promise<Socket>;
}

/**
 * Serve one connection a ward made to its port 5037 (see the top of this file).
 * When its device can't start, the client gets adb's own failure answer with
 * the reason, which adb prints.
 */
export async function acceptAdb(client: Socket, ward: AdbWard): Promise<void> {
  client.on("error", () => client.destroy());
  const request = await readRequest(client);
  if (request === undefined) return void client.destroy();
  let server: Socket;
  try {
    if (needsDevice(request)) await ward.device();
    server = await ward.server();
  } catch (error) {
    return void client.end(`FAIL${frame(`ward: ${error instanceof Error ? error.message : String(error)}`)}`);
  }
  if (client.destroyed) return void server.destroy(); // it hung up while its device started
  server.write(frame(request));
  client.allowHalfOpen = true; // as splice does for the other side: neither socket was made here
  splice(client, server);
}
