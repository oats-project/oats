// The plugin's reads, as every slot takes them: bb's watched RPC reads (one shared copy per app
// window, whatever number of slots ask), reread when the server publishes `oats/changed`.
//
// `snapshot` must be a watched read: the server polls OATS only while a client watches it
// (`bb.rpc.experimental_whileWatched`).
import { useEffect, useRef } from "react";
import { experimental_useRpcQuery as useRpcQuery, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginRpcClient, PluginRpcResult } from "@get-bb/plugin-sdk/app";
import { REALTIME_CHANGED, rpcContract } from "../contract";

export type Contract = typeof rpcContract;
export type Rpc = PluginRpcClient<Contract>;
export type ReadMethod = "snapshot" | "souls" | "capabilities" | "teams" | "machines";
export type Result<Method extends keyof Contract> = PluginRpcResult<Contract[Method]>;

export type Read<T> =
  | { status: "loading"; data: undefined; error: null }
  | { status: "ready"; data: T; error: null }
  /** The last attempt failed. `data` is what an earlier attempt read, if any. */
  | { status: "error"; data: T | undefined; error: string };

/** What a failed call says, unchanged: the kernel's code and message come through the server. */
export function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message !== "") return cause.message;
  if (typeof cause === "string" && cause !== "") return cause;
  return "The OATS plugin's server did not answer.";
}

/**
 * A call made from inside a promise, so a client that throws at the call itself is a rejection
 * like any other failure.
 */
export function attempt<T>(call: () => Promise<T>): Promise<T> {
  return Promise.resolve().then(call);
}

/**
 * The invalidation each read last acted on. Every mounted slot hears the same `oats/changed`
 * event; the first to hear it rereads the shared copy, the others find it already asked for.
 */
const acted = new Map<ReadMethod, string>();

/** For tests: a new app window has acted on nothing. */
export function resetReads(): void {
  acted.clear();
}

function tokenOf(payload: unknown): string | undefined {
  if (typeof payload === "object" && payload !== null && "at" in payload) {
    const at = (payload as { at: unknown }).at;
    if (typeof at === "string") return at;
  }
  return undefined;
}

/**
 * One of the plugin's reads, kept fresh: loaded on first use and reread when the server publishes
 * `oats/changed`. bb itself rereads every plugin read when its realtime connection comes back.
 * `live: false` reads once and leaves the rereading to the slots that show the read itself.
 */
export function useRead<Method extends ReadMethod>(
  method: Method,
  options: { enabled?: boolean; live?: boolean } = {},
): Read<Result<Method>> & { retry(): void } {
  const enabled = options.enabled ?? true;
  const live = options.live ?? true;
  const rpc = useRpc<Contract>();
  const query = useRpcQuery({ contract: rpcContract, method, input: null, enabled });
  const refetch = useRef(query.refetch);
  useEffect(() => {
    refetch.current = query.refetch;
  });

  useRealtime(REALTIME_CHANGED, (payload) => {
    if (!enabled || !live) return;
    const token = tokenOf(payload);
    if (token !== undefined) {
      if (acted.get(method) === token) return;
      acted.set(method, token);
    }
    void refetch.current();
  });

  const data = query.data as Result<Method> | undefined;
  const retry = () => {
    // Retry asks the server to reread OATS now, then reads what it has.
    const reread = () => void refetch.current();
    attempt(() => rpc.call("refresh", null)).then(reread, reread);
  };
  if (query.error !== null) return { status: "error", data, error: errorMessage(query.error), retry };
  if (data === undefined) return { status: "loading", data: undefined, error: null, retry };
  return { status: "ready", data, error: null, retry };
}
