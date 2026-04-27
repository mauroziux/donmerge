/**
 * Ambient type declarations for Cloudflare Workers runtime globals.
 *
 * These declarations make tsc --noEmit pass without requiring the full
 * @cloudflare/workers-types package, which introduces strict typings
 * that conflict with existing code patterns (test mocks, DO subclassing).
 *
 * For the full type definitions, see:
 *   npm install --save-dev @cloudflare/workers-types
 */

// ── Web APIs available in the Workers runtime ────────────────────────────────

// These are already available in the Workers runtime but not in ES2022 lib.
// Minimal declarations to satisfy tsc --noEmit.

declare class URL {
  constructor(url: string, base?: string | URL);
  pathname: string;
  searchParams: URLSearchParams;
  toString(): string;
}

interface URLSearchParams {
  get(name: string): string | null;
}

type RequestInfo = Request | string;

interface RequestInit {
  method?: string;
  headers?: Headers | Record<string, string>;
  body?: string | null;
}

interface ResponseInit {
  status?: number;
  headers?: Headers | Record<string, string>;
}

declare class Headers {
  constructor(init?: Record<string, string>);
  get(name: string): string | null;
  set(name: string, value: string): void;
}

declare class Request {
  constructor(input: RequestInfo | URL, init?: RequestInit);
  json<T>(): Promise<T>;
  text(): Promise<string>;
  header(name: string): string | null;
  headers: Headers;
  url: string;
}

declare class Response {
  constructor(body?: string | null, init?: ResponseInit);
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Headers;
  json<T>(): Promise<T>;
  text(): Promise<string>;
}

declare function fetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response>;

declare const crypto: Crypto;

declare class TextEncoder {
  encode(input?: string): Uint8Array;
  encodeInto(input: string, dest: Uint8Array): { read: number; written: number };
}

declare class TextDecoder {
  decode(input?: BufferSource): string;
}

declare function atob(encoded: string): string;
declare function btoa(raw: string): string;

declare var console: Console;

// ── Cloudflare Workers-specific types ────────────────────────────────────────
interface DurableObjectNamespace<T = unknown> {
  idFromName(name: string): DurableObjectId;
  idFromString(id: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub<T>;
}

interface DurableObjectId {
  toString(): string;
  name?: string;
}

interface DurableObjectStub<T = unknown> {
  fetch(url: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  name?: string;
  // Proxy user-defined DO methods at runtime (Workers RPC protocol)
  [method: string]: unknown;
}

interface DurableObjectState {
  storage: DurableObjectStorage;
  waitUntil(promise: Promise<unknown>): void;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

interface DurableObjectStorage {
  get<T = unknown>(key: string, options?: DurableObjectGetOptions): Promise<T | undefined>;
  get<T = unknown>(keys: string[], options?: DurableObjectGetOptions): Promise<Map<string, T>>;
  put<T>(key: string, value: T, options?: DurableObjectPutOptions): Promise<void>;
  put<T>(entries: Record<string, T>, options?: DurableObjectPutOptions): Promise<void>;
  delete(key: string, options?: DurableObjectPutOptions): Promise<boolean>;
  delete(keys: string[], options?: DurableObjectPutOptions): Promise<number>;
  deleteAll(options?: DurableObjectPutOptions): Promise<void>;
  list<T = unknown>(options?: DurableObjectListOptions): Promise<Map<string, T>>;
  getAlarm(options?: { allowConcurrency?: boolean }): Promise<number | null>;
  setAlarm(scheduledTime: number | Date, options?: { allowConcurrency?: boolean }): Promise<void>;
  deleteAlarm(options?: { allowConcurrency?: boolean }): Promise<void>;
  transaction<T>(closure: (txn: DurableObjectTransaction) => Promise<T>): Promise<T>;
  sync(): Promise<void>;
}

interface DurableObjectGetOptions {
  allowConcurrency?: boolean;
  noCache?: boolean;
}

interface DurableObjectPutOptions {
  allowConcurrency?: boolean;
  allowUnconfirmed?: boolean;
  noCache?: boolean;
}

interface DurableObjectListOptions {
  start?: string;
  startAfter?: string;
  end?: string;
  prefix?: string;
  reverse?: boolean;
  limit?: number;
  allowConcurrency?: boolean;
  noCache?: boolean;
}

interface DurableObjectTransaction {
  get<T = unknown>(key: string, options?: DurableObjectGetOptions): Promise<T | undefined>;
  get<T = unknown>(keys: string[], options?: DurableObjectGetOptions): Promise<Map<string, T>>;
  put<T>(key: string, value: T, options?: DurableObjectPutOptions): Promise<void>;
  put<T>(entries: Record<string, T>, options?: DurableObjectPutOptions): Promise<void>;
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  rollback(): void;
}

// ── DurableObject base class ─────────────────────────────────────────────────
// Matches the pattern: import { DurableObject } from 'cloudflare:workers'
declare module 'cloudflare:workers' {
  export class DurableObject<Env = unknown, State = unknown> {
    constructor(ctx: DurableObjectState, env: Env);
    fetch?(request: Request): Promise<Response>;
    alarm?(): Promise<void>;
  }
}

// ── ExecutionContext (used by Workers fetch handler) ─────────────────────────
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// ── @cloudflare/sandbox shim ─────────────────────────────────────────────────
declare module '@cloudflare/sandbox' {
  export function getSandbox(
    namespace: unknown,
    sessionId: string,
    options?: Record<string, unknown>
  ): any;
  export class Sandbox<T = any> {
    constructor(state: DurableObjectState, env: unknown);
    fetch?(request: Request): Promise<Response>;
    alarm?(): Promise<void>;
  }
}

// ── @flue/cloudflare shim ────────────────────────────────────────────────────
declare module '@flue/cloudflare' {
  export class FlueRuntime {
    constructor(options: Record<string, unknown>);
    setup(): Promise<void>;
    client: {
      prompt(prompt: string, options: Record<string, unknown>): Promise<string>;
    };
  }
}

declare module '@flue/cloudflare/worker' {
  export class FlueWorker<Env = unknown> {
    get(path: string, handler: (c: any) => any): void;
    post(path: string, handler: (c: any) => any): void;
  }
}
