// =============================================================================
// env.ts — environment · config · secrets · auth
// =============================================================================

import { randomInt } from "node:crypto";
import * as process  from "node:process";

// ---------------------------------------------------------------------------
// Env — raw access
// ---------------------------------------------------------------------------

export interface Env {
  [key: string]: string | undefined;
  KEY_ROTATION_MANAGER?: DurableObjectNamespace;
}

export interface CustomEndpointConfig {
  name:                string;
  baseUrl:             string;
  apiKeys?:            string | string[];
  models?:             string[];
  chatCompletionPath?: string;
  modelsPath?:         string;
}

let _env: Env | undefined;

export const Env = {
  set: (e: Env) => { _env = e; },
  get: (): Env  => _env ?? (process.env as Env),

  read:      (k: string)  => Env.get()[k],
  readBool:  (k: string)  => { const v = Env.read(k); return v !== undefined && v !== "false" && v !== "False" && v !== "0"; },

  readArray(k: string): string[] {
    const raw = Env.read(k);
    if (!raw) return [];
    try { const p = JSON.parse(raw); if (Array.isArray(p)) return p.map(String); } catch { /* not JSON */ }
    return raw.includes(",") ? raw.split(",").map((s) => s.trim()) : [raw];
  },
};

// ---------------------------------------------------------------------------
// Config — parsed & cached
// ---------------------------------------------------------------------------

export interface Config {
  isDev:              boolean;
  proxyApiKeys:       string[] | undefined;
  defaultModel:       string | undefined;
  globalRoundRobin:   boolean;
  aiGateway:          { accountId?: string; name?: string; token?: string };
  customEndpoints:    CustomEndpointConfig[] | undefined;
}

let _cfg: Config | undefined;

export const getConfig   = (): Config => _cfg ??= parseConfig();
export const resetConfig = ()         => { _cfg = undefined; };

function parseConfig(): Config {
  let customEndpoints: CustomEndpointConfig[] | undefined;
  const raw = Env.read("CUSTOM_OPENAI_ENDPOINTS");
  if (raw) {
    try { const p = JSON.parse(raw); if (Array.isArray(p)) customEndpoints = p; }
    catch { console.warn("[config] CUSTOM_OPENAI_ENDPOINTS is invalid JSON — ignored"); }
  }

  const proxyRaw = Env.read("PROXY_API_KEY");

  return {
    isDev:            Env.readBool("DEV"),
    proxyApiKeys:     proxyRaw ? Env.readArray("PROXY_API_KEY") : undefined,
    defaultModel:     Env.read("DEFAULT_MODEL"),
    globalRoundRobin: Env.read("ENABLE_GLOBAL_ROUND_ROBIN") === "true",
    aiGateway: {
      accountId: Env.read("CLOUDFLARE_ACCOUNT_ID"),
      name:      Env.read("AI_GATEWAY_NAME"),
      token:     Env.read("CF_AIG_TOKEN"),
    },
    customEndpoints,
  };
}

// ---------------------------------------------------------------------------
// Secrets — key-array access + round-robin
// ---------------------------------------------------------------------------

export type ApiKeySelection = number | { start?: number; end?: number };

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export const Secrets = {
  getAll(key: string, shuf = false): string[] {
    const vals = Env.readArray(key);
    return shuf && vals.length > 1 ? shuffle(vals) : vals;
  },

  get(key: string, idx = 0): string {
    const all = Secrets.getAll(key);
    return all.length === 0 ? "" : (all[idx % all.length] ?? "");
  },

  async nextIndex(id: string, len: number): Promise<number> {
    if (len <= 1) return 0;
    const env = Env.get();
    if (env.KEY_ROTATION_MANAGER && getConfig().globalRoundRobin) {
      const stub = env.KEY_ROTATION_MANAGER.get(env.KEY_ROTATION_MANAGER.idFromName(id));
      return (stub as unknown as { getNextIndex(id: string, len: number): Promise<number> })
        .getNextIndex(id, len);
    }
    return randomInt(len);
  },

  async next(key: string): Promise<number> {
    return Secrets.nextIndex(key, Secrets.getAll(key).length);
  },

  resolve(sel: ApiKeySelection, len: number): number {
    if (typeof sel === "number") return sel % len;
    const start = (sel.start ?? 0) % len;
    const end   = sel.end === undefined ? len - 1 : Math.min(sel.end, len - 1);
    return start >= end ? start : randomInt(start, end + 1);
  },
};

// ---------------------------------------------------------------------------
// Auth — validates proxy API key
// ---------------------------------------------------------------------------

const AUTH_HEADERS = ["Authorization", "x-api-key", "x-goog-api-key"] as const;

export function authenticate(request: Request): boolean {
  const { proxyApiKeys } = getConfig();
  if (!proxyApiKeys) return true;

  for (const h of AUTH_HEADERS) {
    const v = request.headers.get(h);
    if (v) return proxyApiKeys.includes(v.split(/\s/)[1] ?? v);
  }

  const key = new URL(request.url).searchParams.get("key");
  return key !== null && proxyApiKeys.includes(key);
}
