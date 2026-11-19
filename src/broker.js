// @ts-check
// Runs inside a ward's network namespace as a child of wardd, over Node IPC.
// It opens TCP connections to the ward's own loopback and hands the connected
// sockets to wardd, which copies bytes between them and host-side connections.
// Plain JavaScript (type-checked through JSDoc): one runs per ward, and Node's
// TypeScript support would double its memory.
import { connect } from "node:net";

/** @import { Socket } from "node:net" */
/** @import { BrokerReply, BrokerRequest } from "./api.ts" */

const send = process.send?.bind(process);
if (send === undefined) {
  console.error("ward broker: must run as a child of wardd with an IPC channel");
  process.exit(2);
}

/**
 * @param {readonly string[]} hosts
 * @param {number} port
 * @returns {Promise<Socket>}
 */
function tryConnect(hosts, port) {
  const [host, ...rest] = hosts;
  if (host === undefined) return Promise.reject(new Error(`nothing listening on port ${port}`));
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    socket.once("connect", () => {
      // Paused before Node starts reading, so nothing the server sends first (a greeting,
      // or data and FIN) lands in this process; it all stays in the socket for wardd.
      socket.pause();
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", () => {
      socket.destroy();
      tryConnect(rest, port).then(resolve, reject);
    });
  });
}

process.on("message", (/** @type {BrokerRequest} */ message) => {
  if (message.t !== "connect") return;
  tryConnect(message.hosts, message.port).then(
    (socket) => {
      /** @type {BrokerReply} */
      const reply = { t: "connected", req: message.req };
      send(reply, socket, { keepOpen: false });
    },
    (error) => {
      /** @type {BrokerReply} */
      const reply = { t: "failed", req: message.req, message: String(error) };
      send(reply);
    },
  );
});

// Tells wardd this process is now inside the ward's namespaces.
send(/** @type {BrokerReply} */ ({ t: "ready" }));

// wardd going away closes the IPC channel; the broker has no purpose without it.
process.on("disconnect", () => process.exit(0));
