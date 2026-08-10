// =============================================================================
// providers.ts — base · registry · all built-ins · custom endpoint
// =============================================================================

import { Secrets, getConfig, type ApiKeySelection, type CustomEndpointConfig } from "./env.ts";
import { ProviderNotSupportedError } from "./core.ts";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ModelObject {
  id:        string;
  object:    string;
  created:   number;
  owned_by:  string;
  [k: string]: unknown;
}
export interface ModelList { object: "list"; data: ModelObject[]; }

export interface BuildChatArgs { body: string; headers: Headers; apiKeyIndex: number; }

// Standard OpenAI params — providers strip anything not in this set
const STANDARD_PARAMS = new Set([
  "messages","model","store","metadata","frequency_penalty","logit_bias","logprobs",
  "max_tokens","max_completion_tokens","n","modalities","prediction","audio",
  "presence_penalty","response_format","seed","service_tier","stop","stream",
  "stream_options","suffix","temperature","top_p","tools","tool_choice",
  "parallel_tool_calls","user","function_call","functions",
]);

// ---------------------------------------------------------------------------
// Self-registration registry
// ---------------------------------------------------------------------------

type Ctor = new () => ProviderBase;
const _registry = new Map<string, Ctor>();

export const Registry = {
  add:   (name: string, ctor: Ctor) => { _registry.set(name, ctor); },
  get:   (name: string) => { const C = _registry.get(name); return C ? new C() : undefined; },
  all:   () => new Map([..._registry].map(([n, C]) => [n, new C()])),
  names: () => [..._registry.keys()],
};

/** Class decorator — registers the provider on module load */
function provider(name: string) {
  return <T extends Ctor>(ctor: T): T => { Registry.add(name, ctor); return ctor; };
}

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

export abstract class ProviderBase {
  abstract readonly name:       string;
  abstract readonly apiKeyName: string | undefined;

  protected readonly baseUrlVal:       string      = "https://example.com";
  protected readonly supportedParams:  Set<string> = STANDARD_PARAMS;
  readonly aiGatewayCompat:            boolean     = false;

  get chatPath():   string { return "/chat/completions"; }
  get modelsPath(): string { return "/models"; }

  baseUrl():  string { return this.baseUrlVal; }
  available(): boolean { return this.getKeys().length > 0; }

  getKeys(): string[] {
    return this.apiKeyName ? Secrets.getAll(this.apiKeyName) : [];
  }

  async nextKeyIdx(): Promise<number> {
    const keys = this.getKeys();
    if (keys.length <= 1) return 0;
    return this.apiKeyName ? Secrets.next(this.apiKeyName) : 0;
  }

  async headers(_idx: number): Promise<Record<string, string>> { return {}; }

  async fetch(path: string, init: RequestInit, idx = 0, requestId?: string): Promise<Response> {
    const [url, reqInit] = await this.buildRequest(path, init, idx);
    if (requestId) console.log(JSON.stringify({ level: "info", message: "sub-request", requestId, method: init.method ?? "GET", url }));
    return fetch(url, reqInit);
  }

  async buildRequest(path: string, init: RequestInit, idx: number): Promise<[string, RequestInit]> {
    return [
      this.baseUrl() + path,
      { ...init, headers: { ...init.headers, ...await this.headers(idx) } },
    ];
  }

  async buildChatRequest(args: BuildChatArgs): Promise<[string, RequestInit]> {
    const data    = JSON.parse(args.body) as Record<string, unknown>;
    const trimmed = Object.fromEntries(Object.entries(data).filter(([k]) => this.supportedParams.has(k)));
    return [
      this.chatPath,
      {
        method: "POST",
        body:   JSON.stringify(trimmed),
        headers: { ...await this.headers(args.apiKeyIndex), ...Object.fromEntries(args.headers.entries()) },
      },
    ];
  }

  async buildModelsRequest(idx: number): Promise<[string, RequestInit]> {
    return [this.modelsPath, { method: "GET", headers: await this.headers(idx) }];
  }

  modelsToOpenAI(data: unknown): ModelList { return data as ModelList; }
  staticModels(): ModelList | undefined    { return undefined; }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible base — Bearer token auth
// ---------------------------------------------------------------------------

abstract class OAIBase extends ProviderBase {
  override readonly aiGatewayCompat = true;

  override async headers(idx: number): Promise<Record<string, string>> {
    const keys = this.getKeys();
    if (!keys.length) return {};
    return { "Content-Type": "application/json", Authorization: `Bearer ${keys[idx % keys.length]}` };
  }
}

// ---------------------------------------------------------------------------
// Built-in providers (self-register via @provider decorator)
// ---------------------------------------------------------------------------

@provider("anthropic")
export class Anthropic extends ProviderBase {
  readonly name = "anthropic"; readonly apiKeyName = "ANTHROPIC_API_KEY";
  override readonly aiGatewayCompat = true;
  protected override readonly baseUrlVal = "https://api.anthropic.com";
  override get chatPath()   { return "/v1/chat/completions"; }
  override get modelsPath() { return "/v1/models"; }

  override async headers(idx: number): Promise<Record<string, string>> {
    return { "Content-Type": "application/json", "x-api-key": Secrets.get(this.apiKeyName!, idx), "anthropic-version": "2023-06-01" };
  }

  override modelsToOpenAI(data: { data: Array<{ id: string; type: string; created_at: string; [k: string]: unknown }> }): ModelList {
    return { object: "list", data: data.data.map(({ id, type, created_at, ...r }) =>
      ({ id, object: type, created: Math.floor(Date.parse(created_at) / 1000), owned_by: "anthropic", _: r })) };
  }
}

@provider("openai")
export class OpenAI extends OAIBase {
  readonly name = "openai"; readonly apiKeyName = "OPENAI_API_KEY";
  protected override readonly baseUrlVal = "https://api.openai.com/v1";
}

@provider("google-ai-studio")
export class GoogleAiStudio extends ProviderBase {
  readonly name = "google-ai-studio"; readonly apiKeyName = "GEMINI_API_KEY";
  override readonly aiGatewayCompat = true;
  protected override readonly baseUrlVal = "https://generativelanguage.googleapis.com";
  protected override readonly supportedParams = new Set([
    "messages","model","max_tokens","max_completion_tokens","n","response_format",
    "stop","stream","stream_options","temperature","top_p","tools","tool_choice",
  ]);
  override get chatPath()   { return "/v1beta/openai/chat/completions"; }
  override get modelsPath() { return "/v1beta/models"; }

  override async headers(idx: number): Promise<Record<string, string>> {
    return { "Content-Type": "application/json", "x-goog-api-key": Secrets.get(this.apiKeyName!, idx) };
  }

  override async fetch(path: string, init: RequestInit, idx = 0, rid?: string): Promise<Response> {
    if (path.startsWith("/v1beta/openai")) {
      // OpenAI-compat path requires Bearer auth, not x-goog-api-key
      const h = new Headers(init.headers as HeadersInit);
      h.set("Content-Type", "application/json");
      h.set("Authorization", `Bearer ${Secrets.get(this.apiKeyName!, idx)}`);
      h.delete("x-goog-api-key");
      return super.fetch(path, { ...init, headers: Object.fromEntries(h) }, idx, rid);
    }
    return super.fetch(path, init, idx, rid);
  }

  override modelsToOpenAI(data: { models: Array<{ name: string; [k: string]: unknown }> }): ModelList {
    return { object: "list", data: data.models.map(({ name, ...r }) =>
      ({ id: name.replace("models/", ""), object: "model", created: 0, owned_by: "google_ai_studio", _: r })) };
  }
}

@provider("groq")
export class Groq extends OAIBase {
  readonly name = "groq"; readonly apiKeyName = "GROQ_API_KEY";
  protected override readonly baseUrlVal = "https://api.groq.com/openai/v1";

  override modelsToOpenAI(data: { data: Array<{ id: string; object: string; created: number; owned_by: string; [k: string]: unknown }> }): ModelList {
    return { object: "list", data: data.data.map(({ id, object, created, owned_by, ...r }) => ({ id, object, created, owned_by, _: r })) };
  }
}

@provider("mistral")
export class Mistral extends OAIBase {
  readonly name = "mistral"; readonly apiKeyName = "MISTRAL_API_KEY";
  protected override readonly baseUrlVal = "https://api.mistral.ai";
  override get chatPath()   { return "/v1/chat/completions"; }
  override get modelsPath() { return "/v1/models"; }

  override modelsToOpenAI(data: { data: Array<{ id: string; object: string; created: number; owned_by: string; [k: string]: unknown }> }): ModelList {
    return { object: "list", data: data.data.map(({ id, object, created, owned_by, ...r }) => ({ id, object, created, owned_by, _: r })) };
  }
}

@provider("deepseek")
export class DeepSeek extends OAIBase {
  readonly name = "deepseek"; readonly apiKeyName = "DEEPSEEK_API_KEY";
  protected override readonly baseUrlVal = "https://api.deepseek.com";
}

@provider("grok")
export class Grok extends OAIBase {
  readonly name = "grok"; readonly apiKeyName = "GROK_API_KEY";
  protected override readonly baseUrlVal = "https://api.x.ai";
  override get chatPath()   { return "/v1/chat/completions"; }
  override get modelsPath() { return "/v1/models"; }
}

@provider("cohere")
export class Cohere extends OAIBase {
  readonly name = "cohere"; readonly apiKeyName = "COHERE_API_KEY";
  protected override readonly baseUrlVal = "https://api.cohere.com";
  protected override readonly supportedParams = new Set([
    "messages","model","frequency_penalty","max_tokens","presence_penalty",
    "response_format","seed","stop","stream","temperature","top_p","tools",
  ]);
  override get chatPath()   { return "/compatibility/v1/chat/completions"; }
  override get modelsPath() { return "/v1/models?page_size=100&endpoint=chat"; }

  override modelsToOpenAI(data: { models: Array<{ name: string; [k: string]: unknown }> }): ModelList {
    return { object: "list", data: data.models.map(({ name, ...r }) => ({ id: name, object: "model", created: 0, owned_by: "cohere", _: r })) };
  }
}

@provider("cerebras")
export class Cerebras extends OAIBase {
  readonly name = "cerebras"; readonly apiKeyName = "CEREBRAS_API_KEY";
  protected override readonly baseUrlVal = "https://api.cerebras.ai/v1";
  protected override readonly supportedParams = new Set([
    "messages","model","store","metadata","max_tokens","max_completion_tokens","n",
    "modalities","prediction","audio","response_format","seed","stop","stream",
    "stream_options","suffix","temperature","top_p","tools","tool_choice","user",
    "function_call","functions",
  ]);
}

@provider("perplexity-ai")
export class PerplexityAi extends OAIBase {
  readonly name = "perplexity-ai"; readonly apiKeyName = "PERPLEXITYAI_API_KEY";
  protected override readonly baseUrlVal = "https://api.perplexity.ai";
  override get chatPath()   { return "/v1/chat/completions"; }
  override get modelsPath() { return "/v1/models"; }
  override async buildModelsRequest(_idx: number): Promise<[string, RequestInit]> {
    throw new ProviderNotSupportedError("Perplexity AI: models list not supported");
  }
}

@provider("openrouter")
export class OpenRouter extends OAIBase {
  readonly name = "openrouter"; readonly apiKeyName = "OPENROUTER_API_KEY";
  protected override readonly baseUrlVal = "https://openrouter.ai/api";
  override get chatPath()   { return "/v1/chat/completions"; }
  override get modelsPath() { return "/v1/models"; }

  override modelsToOpenAI(data: { data: Array<{ id: string; created: number; [k: string]: unknown }> }): ModelList {
    return { object: "list", data: data.data.map(({ id, created, ...r }) => ({ id, object: "model", created, owned_by: "openrouter", _: r })) };
  }
}

@provider("ollama")
export class Ollama extends OAIBase {
  readonly name = "ollama"; readonly apiKeyName = "OLLAMA_API_KEY";
  protected override readonly baseUrlVal = "https://ollama.com/v1";
}

@provider("workers-ai")
export class WorkersAi extends ProviderBase {
  readonly name = "workers-ai"; readonly apiKeyName = "CLOUDFLARE_API_KEY";
  readonly #acctKey = "CLOUDFLARE_ACCOUNT_ID";
  override get chatPath()   { return "/v1/chat/completions"; }
  override get modelsPath() { return "/models/search?task=Text Generation"; }
  override available()      { return Secrets.getAll(this.apiKeyName!).length > 0 && Secrets.getAll(this.#acctKey).length > 0; }
  override baseUrl()        { return `https://api.cloudflare.com/client/v4/accounts/${Secrets.get(this.#acctKey)}/ai`; }
  override async headers(idx: number): Promise<Record<string, string>> {
    return { "Content-Type": "application/json", Authorization: `Bearer ${Secrets.get(this.apiKeyName!, idx)}` };
  }
  override modelsToOpenAI(data: { result: Array<{ name: string; [k: string]: unknown }> }): ModelList {
    return { object: "list", data: data.result.map(({ name, ...r }) => ({ id: name, object: "model", created: 0, owned_by: "workers_ai", _: r })) };
  }
}

// Proxy-only providers (no chat/models support)
const noChat    = (): never => { throw new ProviderNotSupportedError("chat completions not supported"); };
const noModels  = (): never => { throw new ProviderNotSupportedError("models list not supported"); };

@provider("huggingface")
export class HuggingFace extends ProviderBase {
  readonly name = "huggingface"; readonly apiKeyName = "HUGGINGFACE_API_KEY";
  protected override readonly baseUrlVal = "https://api-inference.huggingface.co/models";
  override get chatPath()   { return ""; }
  override get modelsPath() { return ""; }
  override async buildChatRequest():   Promise<never> { return noChat(); }
  override async buildModelsRequest(): Promise<never> { return noModels(); }
}

@provider("replicate")
export class Replicate extends ProviderBase {
  readonly name = "replicate"; readonly apiKeyName = "REPLICATE_API_KEY";
  protected override readonly baseUrlVal = "https://api.replicate.com/v1";
  override get chatPath()   { return ""; }
  override get modelsPath() { return ""; }
  override async buildChatRequest():   Promise<never> { return noChat(); }
  override async buildModelsRequest(): Promise<never> { return noModels(); }
}

// ---------------------------------------------------------------------------
// Custom OpenAI-compatible endpoint
// ---------------------------------------------------------------------------

export class CustomProvider extends ProviderBase {
  readonly name:       string;
  readonly apiKeyName = undefined;
  readonly #cfg:       CustomEndpointConfig;

  constructor(cfg: CustomEndpointConfig) {
    super();
    this.#cfg = cfg;
    this.name = cfg.name;
  }

  override get chatPath()   { return this.#cfg.chatCompletionPath ?? super.chatPath; }
  override get modelsPath() { return this.#cfg.modelsPath ?? super.modelsPath; }
  override baseUrl()        { return this.#cfg.baseUrl; }
  override available()      { return true; }

  override getKeys(): string[] {
    const k = this.#cfg.apiKeys;
    return k ? (Array.isArray(k) ? k : [k]) : [];
  }

  override async nextKeyIdx(): Promise<number> {
    const keys = this.getKeys();
    return keys.length <= 1 ? 0 : Secrets.nextIndex(this.name, keys.length);
  }

  override async headers(idx: number): Promise<Record<string, string>> {
    const keys = this.getKeys();
    if (!keys.length) return { "Content-Type": "application/json" };
    return { "Content-Type": "application/json", Authorization: `Bearer ${keys[idx % keys.length]}` };
  }

  override staticModels(): ModelList | undefined {
    const { models } = this.#cfg;
    if (!models?.length) return undefined;
    return { object: "list", data: models.map((id) => ({ id, object: "model", created: Math.floor(Date.now() / 1000), owned_by: this.name })) };
  }
}

// ---------------------------------------------------------------------------
// Public provider resolution helpers
// ---------------------------------------------------------------------------

let _customRegistered = false;

function ensureCustom() {
  if (_customRegistered) return;
  _customRegistered = true;
  for (const cfg of getConfig().customEndpoints ?? []) {
    const captured = cfg;
    Registry.add(cfg.name, class extends CustomProvider { constructor() { super(captured); } } as unknown as Ctor);
  }
}

export function getProvider(name: string): ProviderBase | undefined {
  ensureCustom();
  return Registry.get(name);
}

export function getAllProviders(): Map<string, ProviderBase> {
  ensureCustom();
  return Registry.all();
}
