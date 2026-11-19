// Parsing of /proc/<pid>/net/tcp{,6}: which TCP ports a network namespace
// listens on, and where to dial each one from inside it.

/**
 * Listening ports in one /proc/net/tcp or tcp6 file, each with the addresses to
 * dial it on. Sockets bound to a specific non-loopback address are skipped.
 */
export function listeningPorts(text: string): Map<number, string[]> {
  const found = new Map<number, string[]>();
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields[3] !== "0A" || fields[1] === undefined) continue; // 0A = LISTEN
    const [hexAddr = "", hexPort = ""] = fields[1].split(":");
    const hosts = dialAddresses(hexAddr);
    if (hosts === undefined) continue;
    const port = parseInt(hexPort, 16);
    found.set(port, [...new Set([...(found.get(port) ?? []), ...hosts])]);
  }
  return found;
}

/**
 * Where to connect for a socket bound to this /proc/net address, or undefined
 * when it is bound to a specific non-loopback address (such as Podman's DNS on
 * a container bridge), which is internal to the ward.
 */
export function dialAddresses(hex: string): string[] | undefined {
  if (hex.length === 8) {
    if (hex === "00000000") return ["127.0.0.1"];
    const bytes = (hex.match(/../g) ?? []).map((b) => parseInt(b, 16)).reverse();
    return bytes[0] === 127 ? [bytes.join(".")] : undefined;
  }
  if (/^0+$/.test(hex)) return ["::1", "127.0.0.1"];
  if (hex === "00000000000000000000000001000000") return ["::1"];
  if (hex.startsWith("0000000000000000FFFF0000")) return dialAddresses(hex.slice(24));
  return undefined;
}
