// =============================================================================
// requests.ts — all request handlers
// =============================================================================

import { getConfig, Secrets, type ApiKeySelection } from "./env.ts";
import { getProvider, getAllProviders, CustomProvider, Registry } from "./providers.ts";
import { CloudflareAIGateway } from "./ai_gateway.ts";
import {
  BadRequestError, NotFoundError, UpstreamError,
  ProviderNotSupportedError, TimeoutError,
  parseChatBody, parseUniversalBody,
} from "./core.ts";

const CHAT_TIMEOUT_MS   = 25_000;
const MODELS_TIMEOUT_MS =  5_000;

// ---------------------------------------------------------------------------
// Shared utils
// ---------------------------------------------------------------------------

function resolveKeyIdx(
  getKeys: () => string[],
  getNext: () => Promise<number>,
  sel: ApiKeySelection | undefined,
): Promise<number> {
  if (sel !== undefined) return Promise.resolve(Secrets.resolve(sel, getKeys().length));
  return getNext();
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  providerName: string,
): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: abort.signal });
    if (!res.ok) {
      throw new UpstreamError(
        `Upstream "${providerName}" returned ${res.status}`,
        res.status,
        res.headers.get("Retry-After") ?? undefined,
      );
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// POST /chat/completions
// ---------------------------------------------------------------------------

export async function chatCompletions(
  request:     Request,
  sel:         ApiKeySelection | undefined,
  aiGateway:   CloudflareAIGateway | undefined,
  requestId:   string,
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete("Authorization");

  const body  = parseChatBody(JSON.parse(await request.text()));
  const model = body.model === "default" ? getConfig().defaultModel : body.model;

  if (!model) throw new BadRequestError('"default" model requested but DEFAULT_MODEL is not configured');

  const slash = model.indexOf("/");
  if (slash < 1) throw new BadRequestError(`Model must be "provider/name", got: "${model}"`);

  const providerName = model.slice(0, slash);
  const modelName    = model.slice(slash + 1);
  const provider     = getProvider(providerName);

  if (!provider) throw new BadRequestError(`Unknown provider: "${providerName}"`);

  const idx = await resolveKeyIdx(() => provider.getKeys(), () => provider.nextKeyIdx(), sel);

  const [path, init] = await provider.buildChatRequest({
    body:        JSON.stringify({ ...body, model: modelName }),
    headers,
    apiKeyIndex: idx,
  });

  if (aiGateway && CloudflareAIGateway.isSupported(providerName, true)) {
    const [url, gInit] = aiGateway.buildChatCompletionsRequest({
      provider:   providerName,
      body:       init.body ?? null,
      headers:    Object.fromEntries(new Headers(init.headers as HeadersInit).entries()),
      apiKeyName: provider.apiKeyName ?? "",
    });
    return fetchWithTimeout(url, gInit, CHAT_TIMEOUT_MS, providerName);
  }

  const [url, reqInit] = await provider.buildRequest(path, init, idx);
  return fetchWithTimeout(url, reqInit, CHAT_TIMEOUT_MS, providerName);
}

// ---------------------------------------------------------------------------
// GET /models
// ---------------------------------------------------------------------------

export async function models(
  sel:       ApiKeySelection | undefined,
  aiGateway: CloudflareAIGateway | undefined,
  requestId: string,
): Promise<Response> {
  const entries = [...getAllProviders()];

  const results = await Promise.allSettled(
    entries.map(([name, p]) => fetchOneProvider(name, p, sel, aiGateway)),
  );

  const data = results.flatMap((r, i) => {
    if (r.status === "rejected") {
      if (!(r.reason instanceof ProviderNotSupportedError))
        console.warn(JSON.stringify({ level: "warn", message: `models fetch failed: ${entries[i]![0]}`, error: String(r.reason) }));
      return [];
    }
    return (r.value.data ?? []).map(({ id, ...rest }) => ({ id: `${entries[i]![0]}/${id}`, ...rest }));
  });

  return Response.json({ object: "list", data });
}

async function fetchOneProvider(
  name:      string,
  provider:  ReturnType<typeof getProvider> & object,
  sel:       ApiKeySelection | undefined,
  aiGateway: CloudflareAIGateway | undefined,
) {
  if (!provider.available()) return { object: "list" as const, data: [] };
  const staticList = provider.staticModels();
  if (staticList) return staticList;

  const idx   = sel !== undefined ? Secrets.resolve(sel, provider.getKeys().length) : 0;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), MODELS_TIMEOUT_MS);

  try {
    const [path, init] = await provider.buildModelsRequest(idx);
    const res = await (
      aiGateway && CloudflareAIGateway.isSupported(name)
        ? fetch(...aiGateway.buildProviderRequest({ provider: name, method: "GET", path, headers: await provider.headers(idx), signal: abort.signal }))
        : provider.fetch(path, { ...init, signal: abort.signal }, idx)
    );
    return provider.modelsToOpenAI(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// /{providerName}/... transparent proxy
// ---------------------------------------------------------------------------

export async function proxy(
  request:   Request,
  name:      string,
  pathname:  string,
  sel:       ApiKeySelection | undefined,
  aiGateway: CloudflareAIGateway | undefined,
): Promise<Response> {
  const provider = getProvider(name);
  if (!provider) throw new NotFoundError();

  const idx = sel !== undefined
    ? Secrets.resolve(sel, provider.getKeys().length)
    : await provider.nextKeyIdx();

  if (aiGateway && CloudflareAIGateway.isSupported(name)) {
    return fetch(...aiGateway.buildProviderRequest({
      provider: name, method: request.method, path: pathname, body: request.body,
      headers: { ...await provider.headers(idx), ...Object.fromEntries(request.headers) },
    }));
  }

  return provider.fetch(pathname, { method: request.method, body: request.body, headers: request.headers }, idx);
}

// ---------------------------------------------------------------------------
// /compat/... AI Gateway passthrough
// ---------------------------------------------------------------------------

export function compat(request: Request, pathname: string, gw: CloudflareAIGateway): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  return fetch(...gw.buildCompatRequest({
    method: request.method, path: pathname,
    headers: Object.fromEntries(headers), body: request.body, signal: request.signal,
  }));
}

// ---------------------------------------------------------------------------
// POST / — universal endpoint (AI Gateway fallback chain)
// ---------------------------------------------------------------------------

export async function universalEndpoint(request: Request, gw: CloudflareAIGateway): Promise<Response> {
  const items  = parseUniversalBody(await request.json());
  const mapped = await Promise.all(items.map(async ({ provider: name, endpoint, headers: extra = {}, query }) => {
    if (!CloudflareAIGateway.isSupported(name)) throw new Error(`"${name}" not supported by AI Gateway`);
    const p = Registry.get(name);
    if (!p) throw new Error(`Provider "${name}" not found`);
    const idx      = await Secrets.next(p.apiKeyName ?? "");
    const resolved = endpoint ?? p.chatPath.replace(/^\//, "");
    return { provider: name, endpoint: resolved, headers: { ...await p.headers(idx), ...extra }, query };
  }));
  return fetch(...gw.buildUniversalRequest(mapped));
}

// ---------------------------------------------------------------------------
// GET /status
// ---------------------------------------------------------------------------

const maskKey = (k: string) =>
  k.length <= 3 ? "***" : "*".repeat(Math.min(10, k.length - 3)) + k.slice(-3);

const classifyRes = (r: Response): "valid" | "invalid" | "unknown" =>
  r.ok ? "valid" : r.status === 401 || r.status === 403 ? "invalid" : "unknown";

async function checkConn(
  name: string,
  p:    ReturnType<typeof getProvider> & object,
  idx:  number,
  gw:   CloudflareAIGateway | undefined,
): Promise<"valid" | "invalid" | "unknown"> {
  if (!p.modelsPath) return "unknown";
  try {
    const res = await (gw && CloudflareAIGateway.isSupported(name)
      ? fetch(...gw.buildProviderRequest({ provider: name, method: "GET", path: p.modelsPath, headers: await p.headers(idx) }))
      : p.fetch(...await p.buildModelsRequest(idx), idx));
    return classifyRes(res);
  } catch (e) {
    return e instanceof ProviderNotSupportedError ? "unknown" : "invalid";
  }
}

export async function status(gw: CloudflareAIGateway | undefined): Promise<Response> {
  const cfg = getConfig();
  const providersStatus: Record<string, unknown> = {};

  for (const [name, p] of getAllProviders()) {
    const keys = p instanceof CustomProvider ? p.getKeys()
      : p.apiKeyName ? Secrets.getAll(p.apiKeyName) : [];

    if (!keys.length) {
      providersStatus[name] = { available: p.available(), keys: [] };
      continue;
    }

    providersStatus[name] = {
      available: p.available(),
      keys: await Promise.all(keys.map(async (k, i) => ({ key: maskKey(k), status: await checkConn(name, p, i, gw) }))),
    };
  }

  return Response.json({
    config:    { DEV: cfg.isDev, DEFAULT_MODEL: cfg.defaultModel ?? null, AI_GATEWAY: cfg.aiGateway, GLOBAL_ROUND_ROBIN: cfg.globalRoundRobin },
    providers: providersStatus,
  });
}
