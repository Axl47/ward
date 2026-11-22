// The byte copy between a host-side connection and the ward-side socket the
// broker dialed. wardd runs one per connection through a mapped port.
import { connect, createServer, type Server, type Socket } from "node:net";

/** The host-side listener of a mapped port: paused until the broker's socket arrives, half-close kept for splice. */
export const mappedServer = (onConnection: (client: Socket) => void): Server =>
  createServer({ pauseOnConnect: true, allowHalfOpen: true }, onConnection);

/**
 * Copy both ways until both sides are done. Half-close passes through (a
 * client may send FIN and still read the reply), so `client` must come from
 * mappedServer; an error on either side drops both.
 */
export function splice(client: Socket, upstream: Socket): void {
  upstream.allowHalfOpen = true; // a socket received over IPC can't be created with it
  // Each piece goes on as it comes: the two ends chose when to send, and a small one
  // held back here (adb's acknowledgements) stalls them for the 40 ms a delayed ACK takes.
  client.setNoDelay(true);
  upstream.setNoDelay(true);
  client.pipe(upstream).pipe(client);
  const drop = () => {
    client.destroy();
    upstream.destroy();
  };
  // A side closes once it has ended both ways; the other then finishes its writes and closes.
  client.on("error", drop).on("close", () => upstream.destroySoon());
  upstream.on("error", drop).on("close", () => client.destroySoon());
  client.resume();
}

/**
 * Connect a socket the broker accepted on a relay port inside a ward to the
 * same port on the host's loopback; `track` sees both sockets.
 */
export function relayToHost(accepted: Socket, port: number, track: (socket: Socket) => void = () => {}): void {
  const host = connect({ host: "127.0.0.1", port, allowHalfOpen: true });
  const fail = () => {
    host.destroy();
    accepted.destroy();
  };
  track(host);
  track(accepted);
  host.once("error", fail).once("connect", () => {
    host.off("error", fail);
    splice(host, accepted);
  });
}
