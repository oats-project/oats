// One cached copy of each of the plugin's reads, shared by every slot of this app window. Slots
// subscribe; the realtime channel only invalidates, and the app refetches through RPC.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginRpcClient, PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { REALTIME_CHANGED, rpcContract } from "../contract";

export type Contract = typeof rpcContract;
export type Rpc = PluginRpcClient<Contract>;
export type ReadMethod = "snapshot" | "souls" | "capabilities" | "teams" | "machines";
export type Result<Method extends keyof Contract> = PluginRpcResult<Contract[Method]>;

/** The realtime channel, checked against the contract's constant without bundling the schemas. */
const CHANGED: typeof REALTIME_CHANGED = "oats/changed";

export type Read<T> =
  | { status: "loading"; data: undefined; error: null }
  | { status: "ready"; data: T; error: null }
  /** The last attempt failed. `data` is what an earlier attempt read, if any. */
  | { status: "error"; data: T | undefined; error: string };

const LOADING: Read<never> = { status: "loading", data: undefined, error: null };

/** What a failed call says, unchanged: the kernel's code and message come through the server. */
export function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message !== "") return cause.message;
  if (typeof cause === "string" && cause !== "") return cause;
  return "The OATS plugin's server did not answer.";
}

class Resource<T> {
  private state: Read<T> = LOADING;
  private listeners = new Set<() => void>();
  private inFlight = false;
  private again: Rpc | null = null;
  private seen: string | null = null;

  constructor(private readonly method: ReadMethod) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  get = (): Read<T> => this.state;

  /** Load once: the first subscriber of an app window starts the read. */
  ensure(rpc: Rpc): void {
    if (this.state.status === "loading" && !this.inFlight) this.load(rpc);
  }

  /**
   * Reread. Never two calls at once: a request that arrives during a read runs one more read
   * after it. `token` names the invalidation, so the same event seen by several slots rereads once.
   */
  reload(rpc: Rpc, token?: string): void {
    if (token !== undefined) {
      if (token === this.seen) return;
      this.seen = token;
    }
    if (this.inFlight) this.again = rpc;
    else this.load(rpc);
  }

  reset(): void {
    this.state = LOADING;
    this.inFlight = false;
    this.again = null;
    this.seen = null;
    this.listeners.clear();
  }

  private load(rpc: Rpc): void {
    this.inFlight = true;
    const settle = (next: Read<T>) => {
      this.inFlight = false;
      this.state = next;
      for (const listener of [...this.listeners]) listener();
      const again = this.again;
      this.again = null;
      if (again !== null) this.load(again);
    };
    (rpc.call(this.method, null) as Promise<T>).then(
      (data) => settle({ status: "ready", data, error: null }),
      (cause: unknown) => settle({ status: "error", data: this.state.data, error: errorMessage(cause) }),
    );
  }
}

const resources: { [Method in ReadMethod]: Resource<Result<Method>> } = {
  snapshot: new Resource("snapshot"),
  souls: new Resource("souls"),
  capabilities: new Resource("capabilities"),
  teams: new Resource("teams"),
  machines: new Resource("machines"),
};

/** Forget every read. For tests: a new app window starts empty by construction. */
export function resetReads(): void {
  for (const resource of Object.values(resources)) resource.reset();
}

function tokenOf(payload: unknown): string | undefined {
  if (typeof payload === "object" && payload !== null && "at" in payload) {
    const at = (payload as { at: unknown }).at;
    if (typeof at === "string") return at;
  }
  return undefined;
}

/**
 * One of the plugin's reads, kept fresh: loaded on first use, reread when the server publishes
 * `oats/changed`, and after the realtime connection comes back (signals are not replayed).
 */
export function useRead<Method extends ReadMethod>(
  method: Method,
  options: { enabled?: boolean } = {},
): Read<Result<Method>> & { retry(): void } {
  const enabled = options.enabled ?? true;
  const rpc = useRpc<Contract>();
  const resource = resources[method] as unknown as Resource<Result<Method>>;
  const state = useSyncExternalStore(resource.subscribe, resource.get, resource.get);

  useEffect(() => {
    if (enabled) resource.ensure(rpc);
  }, [enabled, resource, rpc]);

  useRealtime(CHANGED, (payload) => {
    if (enabled) resource.reload(rpc, tokenOf(payload));
  });

  const connection = useRealtimeConnectionState();
  const wasConnected = useRef<boolean | null>(null);
  useEffect(() => {
    const connected = connection === "connected";
    // Every slot sees the reconnection; the shared token makes them reread once between them.
    if (connected && wasConnected.current === false && enabled) {
      resource.reload(rpc, `reconnected:${Math.floor(Date.now() / 2000)}`);
    }
    if (connected || wasConnected.current !== null) wasConnected.current = connected;
  }, [connection, enabled, resource, rpc]);

  return {
    ...state,
    retry: () => {
      // Retry asks the server to reread now, then reads what it has.
      rpc.call("refresh", null).then(
        () => resource.reload(rpc),
        () => resource.reload(rpc),
      );
    },
  };
}
