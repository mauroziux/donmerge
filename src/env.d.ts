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

// ── Web Crypto types ─────────────────────────────────────────────────────────

declare class CryptoKey {
  readonly type: KeyType;
  readonly extractable: boolean;
  readonly algorithm: Record<string, unknown>;
  readonly usages: KeyUsage[];
}

type KeyType = 'public' | 'private' | 'secret';
type KeyUsage = 'encrypt' | 'decrypt' | 'sign' | 'verify' | 'deriveKey' | 'deriveBits' | 'wrapKey' | 'unwrapKey';

interface Crypto {
  readonly subtle: SubtleCrypto;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
  randomUUID(): string;
}

interface SubtleCrypto {
  importKey(
    format: 'raw' | 'pkcs8' | 'spki' | 'jwk',
    keyData: BufferSource | JsonWebKey,
    algorithm: AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams | HmacImportParams | AesKeyAlgorithm,
    extractable: boolean,
    keyUsages: KeyUsage[]
  ): Promise<CryptoKey>;
  encrypt(
    algorithm: AlgorithmIdentifier | AesCbcParams | AesGcmParams | RsaOaepParams,
    key: CryptoKey,
    data: BufferSource
  ): Promise<ArrayBuffer>;
  decrypt(
    algorithm: AlgorithmIdentifier | AesCbcParams | AesGcmParams | RsaOaepParams,
    key: CryptoKey,
    data: BufferSource
  ): Promise<ArrayBuffer>;
  sign(
    algorithm: AlgorithmIdentifier | RsaPssParams | EcdsaParams,
    key: CryptoKey,
    data: BufferSource
  ): Promise<ArrayBuffer>;
  digest(
    algorithm: AlgorithmIdentifier,
    data: BufferSource
  ): Promise<ArrayBuffer>;
}

declare var crypto: Crypto;

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

// ── Cloudflare Workflows types ──────────────────────────────────────────────
interface WorkflowStep {
  do<T>(name: string, callback: () => Promise<T>, opts?: {
    retries?: { limit: number; delay?: string | number; backoff?: string };
    timeout?: string | number;
  }): Promise<T>;
}

interface WorkflowEvent<T = unknown> {
  payload: T;
  timestamp: Date;
  instanceId: string;
}

interface Workflow<PARAMS = unknown> {
  create(opts: {
    id?: string;
    params: PARAMS;
    delay?: string | number;
  }): Promise<WorkflowInstance>;
  get(id: string): Promise<WorkflowInstance>;
  list(opts?: { completed?: boolean; status?: string }): Promise<WorkflowInstance[]>;
}

interface WorkflowInstance {
  id: string;
  status(): Promise<{ status: string; output?: unknown }>;
  cancel(): Promise<void>;
  terminate(): Promise<void>;
}

// ── DurableObject base class ─────────────────────────────────────────────────
// Matches the pattern: import { DurableObject } from 'cloudflare:workers'
declare module 'cloudflare:workers' {
  export class DurableObject<Env = unknown, State = unknown> {
    constructor(ctx: DurableObjectState, env: Env);
    fetch?(request: Request): Promise<Response>;
    alarm?(): Promise<void>;
  }

  export interface WorkflowStep {
    do<T>(name: string, callback: () => Promise<T>, opts?: {
      retries?: { limit: number; delay?: string | number; backoff?: string };
      timeout?: string | number;
    }): Promise<T>;
  }

  export interface WorkflowEvent<T = unknown> {
    payload: T;
    timestamp: Date;
    instanceId: string;
  }

  export class WorkflowEntrypoint<Env = unknown, T = unknown> {
    protected env: Env;
    constructor(ctx: unknown, env: Env);
    run(event: WorkflowEvent<T>, step: WorkflowStep): Promise<void>;
  }
}

// ── ExecutionContext (used by Workers fetch handler) ─────────────────────────
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// ── Cloudflare D1 Database types ──────────────────────────────────────────────

interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  dump(): Promise<ArrayBuffer>;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(): Promise<T[]>;
  run(): Promise<D1Result>;
}

interface D1Result<T = Record<string, unknown>> {
  results?: T[];
  success: boolean;
  error?: string;
  meta?: Record<string, unknown>;
}

interface D1ExecResult {
  count: number;
  duration: number;
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
