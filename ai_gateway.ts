// =============================================================================
// ai_gateway.ts — Cloudflare AI Gateway client
// =============================================================================

import { Secrets } from "./env.ts";

const GATEWAY_PROVIDERS = new Set([
  "anthropic","openai","groq","mistral","cohere","perplexity-ai","workers-ai",
  "google-ai-studio","grok","deepseek","cerebras","azure-openai","aws-bedrock",
  "cartesia","elevenlabs","google-vertex-ai","huggingface","openrouter","replicate",
]);

const OPENAI_COMPAT = new Set([
  "anthropic","openai","groq","mistral","cohere","perplexity-ai","workers-ai",
  "google-ai-studio","grok","deepseek","cerebras","openrouter",
]);

export class CloudflareAIGateway {
  static readonly #ORIGIN = "https://gateway.ai.cloudflare.com/v1";

  static isSupported(name: string, openAICompat = false): boolean {
    return openAICompat ? OPENAI_COMPAT.has(name) : GATEWAY_PROVIDERS.has(name);
  }

  readonly #accountId: string;
  readonly #gatewayId: string;
  readonly #apiKey?:   string;

  constructor(accountId: string, gatewayId: string, apiKey?: string) {
    if (!accountId || !gatewayId) throw new Error("AI Gateway: accountId and gatewayId required");
    this.#accountId = accountId;
    this.#gatewayId = gatewayId;
    this.#apiKey    = apiKey;
  }

  baseUrl(provider?: string): string {
    const b = `${CloudflareAIGateway.#ORIGIN}/${this.#accountId}/${this.#gatewayId}`;
    return provider ? `${b}/${provider}` : b;
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(this.#apiKey ? { "cf-aig-authorization": `Bearer ${this.#apiKey}` } : {}),
      ...extra,
    };
  }

  buildUniversalRequest(data: unknown[], extra: Record<string, string> = {}): [string, RequestInit] {
    return [this.baseUrl(), { method: "POST", headers: this.#headers(extra), body: JSON.stringify(data) }];
  }

  buildProviderRequest(o: {
    provider: string; path: string; method?: string;
    body?: BodyInit | null; headers?: Record<string, string>; signal?: AbortSignal;
  }): [string, RequestInit] {
    const { provider, path, method = "POST", body = null, headers = {}, signal } = o;
    const url   = `${this.baseUrl(provider)}/${path.replace(/^\/+/, "")}`;
    const upper = method.toUpperCase();
    const init: RequestInit = { method, headers: this.#headers(headers) };
    if (body !== null && upper !== "GET" && upper !== "HEAD") init.body = body;
    if (signal) init.signal = signal;
    return [url, init];
  }

  buildCompatRequest(o: {
    method: string; path: string;
    headers?: Record<string, string>; body?: BodyInit | null; signal?: AbortSignal;
  }): [string, RequestInit] {
    const { method, path, headers = {}, body, signal } = o;
    const merged = new Headers(this.#headers());
    for (const [k, v] of Object.entries(headers)) merged.set(k, v);
    const upper = method.toUpperCase();
    const init: RequestInit = { method, headers: merged };
    if (body !== null && body !== undefined && upper !== "GET" && upper !== "HEAD") init.body = body;
    if (signal) init.signal = signal;
    return [`${this.baseUrl()}${path.startsWith("/") ? path : `/${path}`}`, init];
  }

  buildChatCompletionsRequest(o: {
    provider: string; body: BodyInit | null;
    headers: Record<string, string>; apiKeyName: string;
  }): [string, RequestInit] {
    const parsed = JSON.parse(o.body as string) as Record<string, unknown>;
    const data   = Secrets.getAll(o.apiKeyName, true).map((key) => {
      const h = new Headers(o.headers);
      h.set("authorization", `Bearer ${key}`);
      return {
        provider: "compat", endpoint: "chat/completions",
        headers: Object.fromEntries(h.entries()),
        query: { ...parsed, model: `${o.provider}/${parsed.model}` },
      };
    });
    return [this.baseUrl(), { method: "POST", headers: this.#headers(o.headers), body: JSON.stringify(data) }];
  }
}
