// Who is calling wardd. The control socket sits in XDG_RUNTIME_DIR, which wards
// share with the host, so its path admits every ward. wardd therefore asks the
// kernel who connected (SO_PEERCRED) and tells callers apart by network
// namespace: the host's own, one ward's, or neither (refused).
import { dlopen } from "node:ffi";
import { readlinkSync } from "node:fs";
import type { Socket } from "node:net";

export type Caller = { readonly kind: "host" } | { readonly kind: "ward"; readonly id: string };

const SOL_SOCKET = 1;
const SO_PEERCRED = 17;
let libc: ReturnType<typeof openLibc> | undefined;
const openLibc = () => dlopen("libc.so.6", { getsockopt: { arguments: ["int32", "int32", "int32", "buffer", "buffer"], return: "int32" } });

/**
 * The pid and uid of the process that connected to this Unix socket, as the
 * kernel recorded them at connect time (pid as seen from wardd's PID namespace).
 * Node has no API for it, so this calls getsockopt through node:ffi on the
 * socket's file descriptor.
 */
export function peerCredentials(socket: Socket): { readonly pid: number; readonly uid: number } | undefined {
  // Internal, but stable: a connected Unix socket's libuv handle exposes its fd.
  const fd = (socket as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
  if (typeof fd !== "number" || fd < 0) return undefined;
  libc ??= openLibc();
  const cred = Buffer.alloc(12); // struct ucred { pid_t pid; uid_t uid; gid_t gid; }
  const len = Buffer.alloc(4);
  len.writeUInt32LE(cred.length);
  if (libc.functions.getsockopt(fd, SOL_SOCKET, SO_PEERCRED, cred, len) !== 0) return undefined;
  return { pid: cred.readInt32LE(0), uid: cred.readUInt32LE(4) };
}

const netns = (pid: number) => {
  try {
    return readlinkSync(`/proc/${pid}/ns/net`);
  } catch {
    return undefined;
  }
};

/**
 * The caller on this connection: the host when it shares wardd's network
 * namespace, the ward whose namespace it is in (`wards`: each ward's id and the
 * pid holding its namespace), or undefined for anyone else (another uid, a
 * namespace that is no ward's, a process gone before it could be looked up).
 * A ward can't enter the host's network namespace or another ward's, so the
 * namespace is an identity it can't forge.
 */
export function identify(socket: Socket, wards: Iterable<readonly [id: string, pid: number | undefined]>): Caller | undefined {
  const peer = peerCredentials(socket);
  if (peer === undefined || peer.uid !== process.getuid?.()) return undefined;
  const ns = netns(peer.pid);
  if (ns === undefined) return undefined;
  if (ns === netns(process.pid)) return { kind: "host" };
  for (const [id, pid] of wards) if (pid !== undefined && netns(pid) === ns) return { kind: "ward", id };
  return undefined;
}
