// The part of Node's experimental `node:ffi` (Node 26) that src/caller.ts uses;
// @types/node doesn't describe the module yet.
declare module "node:ffi" {
  type FFIType = "void" | "int32" | "uint32" | "int64" | "uint64" | "buffer" | "pointer";
  interface FunctionDefinition {
    readonly arguments: readonly FFIType[];
    readonly return: FFIType;
  }
  interface Library<T> {
    readonly functions: { readonly [K in keyof T]: (...args: (number | Buffer)[]) => number };
  }
  export function dlopen<const T extends Record<string, FunctionDefinition>>(path: string, definitions: T): Library<T>;
}
