// Which host loopback ports pasta forwards into a project's wards. Used by
// `ward enable --host-ports` to check input and by wardd to build each ward's list.
import { HOST_PORTS } from "./paths.ts";
import { MAX_SLOTS, PORT_BASE, SLOT_SIZE } from "./registry.ts";

/** pasta takes at most 255 forwarding rules in all; this leaves room for the rest. */
export const MAX_HOST_PORTS = 200;
const WARD_FIRST = PORT_BASE + SLOT_SIZE;
const WARD_LAST = PORT_BASE + (MAX_SLOTS + 1) * SLOT_SIZE - 1;

/** Why a host port can't be forwarded into wards, or undefined if it can. */
export function hostPortProblem(port: number): string | undefined {
  if (port === 53) return "53 is always forwarded (DNS)";
  if (port >= WARD_FIRST && port <= WARD_LAST) return `${port} is in Ward's own host port range ${WARD_FIRST}-${WARD_LAST}, so it would reach another ward`;
  return undefined;
}

/** A ward's forwarded host ports besides DNS: the global list plus the project's, deduplicated, without ports that can't be forwarded. */
export function wardHostPorts(project: readonly number[], global: readonly number[] = HOST_PORTS): number[] {
  return [...new Set([...global, ...project])].filter((p) => hostPortProblem(p) === undefined).slice(0, MAX_HOST_PORTS);
}

/**
 * Parse `--host-ports` input into the project's own list: plain decimal ports,
 * deduplicated. Ports also in the global list stay, so the stored list doesn't
 * depend on this process's view of it. Throws on anything else, or when the
 * combined list wouldn't fit.
 */
export function parseProjectHostPorts(text: string, global: readonly number[] = HOST_PORTS): number[] {
  const ports = new Set<number>();
  for (const token of text.split(",").map((t) => t.trim()).filter(Boolean)) {
    const port = /^\d{1,5}$/.test(token) ? Number(token) : NaN;
    if (!(port >= 1 && port <= 65535)) throw new Error(`bad port ${token}`);
    const problem = hostPortProblem(port);
    if (problem !== undefined) throw new Error(problem);
    ports.add(port);
  }
  const total = new Set([...global, ...ports]).size;
  if (total > MAX_HOST_PORTS) throw new Error(`${total} host ports in all; at most ${MAX_HOST_PORTS} fit`);
  return [...ports];
}
