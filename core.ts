// =============================================================================
// core.ts — errors · logger · middleware types · compose
// =============================================================================

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AppError extends Error {
  constructor(message: string, readonly status = 500) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class UnauthorizedError  extends AppError { constructor(m = "Unauthorized")  { super(m, 401); } }
export class NotFoundError      extends AppError { constructor(m = "Not Found")      { super(m, 404); } }
export class BadRequestError    extends AppError { constructor(m = "Bad Request")    { super(m, 400); } }
export class TimeoutError       extends AppError { constructor(p: string)            { super(`Provider "${p}" timed out`, 504); } }

export class UpstreamError extends AppError {
  constructor(
    message: string,
    readonly upstreamStatus: number,
    readonly retryAfter?: string,
  ) {
    super(message, upstreamStatus >= 500 ? 502 : upstreamStatus);
  }
}

export class ProviderNotSupportedError extends Error {}

// ---------------------------------------------------------------------------
// Logger — JSON Lines, compatible with Cloudflare Logpush
// ---------------------------------------------------------------------------

type Level = "debug" | "info" | "warn" | "error";

const RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN: Level = ((globalThis as Record<string, unknown>).LOG_LEVEL as Level) ?? "info";

const CONSOLE: Record<Level, (s: string) => void> = {
  debug: console.log.bind(console),
  info:  console.log.bind(console),
  warn:  console.warn.bind(console),
  error: console.error.bind(console),
};

function emit(level: Level, message: string, fields: Record<string, unknown> = {}) {
  if (RANK[level] < RANK[MIN]) return;
  CONSOLE[level](JSON.stringify({ level, message, ts: new Date().toISOString(), ...fields }));
}

type Fields = Record<string, unknown>;
type Log    = { debug(m: string, f?: Fields): void; info(m: string, f?: Fields): void;
                warn(m: string,  f?: Fields): void; error(m: string, f?: Fields): void };

const mkLog = (bound: Fields = {}): Log => ({
  debug: (m, f) => emit("debug", m, { ...bound, ...f }),
  info:  (m, f) => emit("info",  m, { ...bound, ...f }),
  warn:  (m, f) => emit("warn",  m, { ...bound, ...f }),
  error: (m, f) => emit("error", m, { ...bound, ...f }),
});

export const logger = { ...mkLog(), child: mkLog };
export type ChildLog = ReturnType<typeof mkLog>;

// ---------------------------------------------------------------------------
// Middleware — context · compose
// ---------------------------------------------------------------------------

import type { CloudflareAIGateway } from "./ai_gateway.ts";
import type { ApiKeySelection }     from "./env.ts";
import type { Env }                 from "./env.ts";

export interface Ctx {
  request:     Request;
  env:         Env;
  ctx:         ExecutionContext;
  pathname:    string;
  requestId:   string;
  log:         ChildLog;
  aiGateway?:  CloudflareAIGateway;
  apiKeyIndex?: ApiKeySelection;
}

export type Next       = () => Promise<Response>;
export type Middleware  = (ctx: Ctx, next: Next) => Promise<Response>;

export function compose(chain: Middleware[]): (ctx: Ctx) => Promise<Response> {
  return (ctx) => {
    let i = -1;
    const step = (n: number): Promise<Response> => {
      if (n <= i) return Promise.reject(new Error("next() called multiple times"));
      i = n;
      if (n === chain.length) return Promise.reject(new Error("No handler matched"));
      return chain[n]!(ctx, () => step(n + 1));
    };
    return step(0);
  };
}

// ---------------------------------------------------------------------------
// Validation — schema helpers (was validation.ts)
// ---------------------------------------------------------------------------

export interface ChatCompletionRequest {
  model: string;
  messages: unknown[];
  stream?: boolean;
  [key: string]: unknown;
}

export interface UniversalItem {
  provider: string;
  endpoint?: string;
  headers?: Record<string, string>;
  query?: unknown;
}

export function parseChatBody(raw: unknown): ChatCompletionRequest {
  if (typeof raw !== "object" || raw === null)
    throw new BadRequestError("Request body must be a JSON object");
  const o = raw as Record<string, unknown>;
  if (typeof o.model !== "string" || !o.model.trim())
    throw new BadRequestError('"model" must be a non-empty string');
  if (!Array.isArray(o.messages))
    throw new BadRequestError('"messages" must be an array');
  return o as ChatCompletionRequest;
}

export function parseUniversalBody(raw: unknown): UniversalItem[] {
  if (!Array.isArray(raw)) throw new BadRequestError("Body must be a JSON array");
  return raw.map((item, idx) => {
    if (typeof item !== "object" || item === null)
      throw new BadRequestError(`Item[${idx}] must be an object`);
    const o = item as Record<string, unknown>;
    if (typeof o.provider !== "string")
      throw new BadRequestError(`Item[${idx}] missing "provider"`);
    return o as UniversalItem;
  });
}
