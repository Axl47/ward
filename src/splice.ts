// The byte copy between a host-side connection and the ward-side socket the
// broker dialed. wardd runs one per connection through a mapped port.
import type { Socket } from "node:net";

/**
 * Copy both ways until both sides are done. Half-close passes through (a
 * client may send FIN and still read the reply), so `client` must come from
 * a server with allowHalfOpen; an error on either side drops both.
 */
export function splice(client: Socket, upstream: Socket): void {
  upstream.allowHalfOpen = true; // a socket received over IPC can't be created with it
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
