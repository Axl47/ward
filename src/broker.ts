// Runs inside a ward's network namespace as a child of wardd, over Node IPC.
// It opens TCP connections to the ward's own loopback and hands the connected
// sockets to wardd, which splices them to host-side listeners. No traffic flows
// through the broker itself.
import { connect, type Socket } from "node:net";

export type BrokerRequest = {
  readonly t: "connect";
  readonly req: number;
  /** Addresses to try in order, e.g. ["127.0.0.1", "::1"]. */
  readonly hosts: readonly string[];
  readonly port: number;
};

export type BrokerReply =
  | { readonly t: "ready" }
  | { readonly t: "connected"; readonly req: number }
  | { readonly t: "failed"; readonly req: number; readonly message: string };

const send = process.send?.bind(process);
if (send === undefined) {
  console.error("ward broker: must run as a child of wardd with an IPC channel");
  process.exit(2);
}

function tryConnect(hosts: readonly string[], port: number): Promise<Socket> {
  const [host, ...rest] = hosts;
  if (host === undefined) return Promise.reject(new Error(`nothing listening on port ${port}`));
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", () => {
      socket.destroy();
      tryConnect(rest, port).then(resolve, reject);
    });
  });
}

process.on("message", (message: BrokerRequest) => {
  if (message.t !== "connect") return;
  tryConnect(message.hosts, message.port).then(
    (socket) => {
      const reply: BrokerReply = { t: "connected", req: message.req };
      send(reply, socket, { keepOpen: false });
    },
    (error: unknown) => {
      const reply: BrokerReply = { t: "failed", req: message.req, message: String(error) };
      send(reply);
    },
  );
});

// Tells wardd this process is now inside the ward's namespaces.
send({ t: "ready" } satisfies BrokerReply);

// wardd going away closes the IPC channel; the broker has no purpose without it.
process.on("disconnect", () => process.exit(0));
