// =============================================================================
// middlewares.ts — all middleware + router
// =============================================================================

import { Env, getConfig, resetConfig, authenticate } from "./env.ts";
import { CloudflareAIGateway } from "./ai_gateway.ts";
import { getAllProviders } from "./providers.ts";
import { chatCompletions, models, proxy, compat, universalEndpoint, status } from "./requests.ts";
import { AppError, UnauthorizedError, NotFoundError, logger } from "./core.ts";
import { compose, type Middleware, type Ctx } from "./core.ts";
import { generateRequestId, cleanPathname, getPathname } from "./helpers.ts";

export { compose };

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
  "Access-Control-Max-Age":       "86400",
};

// ---------------------------------------------------------------------------
// error — outermost, wraps everything
// ---------------------------------------------------------------------------

export const errorMiddleware: Middleware = async (ctx, next) => {
  try {
    return await next();
  } catch (err) {
    const isApp    = err instanceof AppError;
    const status   = isApp ? err.status : 500;
    const message  = err instanceof Error ? err.message : "Internal Server Error";
    const hdrs: Record<string, string> = { "Content-Type": "application/json" };

    if (isApp && "retryAfter" in err && err.retryAfter)
      hdrs["Retry-After"] = String(err.retryAfter);

    if (!isApp) ctx.log.error("unhandled", { error: message, stack: err instanceof Error ? err.stack : undefined });

    return new Response(JSON.stringify({ error: { message, status } }), { status, headers: hdrs });
  }
};

// ---------------------------------------------------------------------------
// request setup — requestId · pathname · env · timing log
// ---------------------------------------------------------------------------

export const requestMiddleware: Middleware = async (ctx, next) => {
  resetConfig();
  Env.set(ctx.env);

  ctx.requestId = generateRequestId();
  ctx.log       = logger.child({ requestId: ctx.requestId });
  ctx.pathname  = getPathname(ctx.request);

  const t0 = Date.now();
  ctx.log.info("req", { method: ctx.request.method, pathname: ctx.pathname });

  const res = await next();

  ctx.log.info("res", { status: res.status, ms: Date.now() - t0 });
  return res;
};

// ---------------------------------------------------------------------------
// CORS — handles OPTIONS before auth
// ---------------------------------------------------------------------------

export const corsMiddleware: Middleware = async (ctx, next) => {
  if (ctx.request.method !== "OPTIONS") return next();
  const req = ctx.request;
  if (req.headers.get("Origin") && req.headers.get("Access-Control-Request-Method")) {
    return new Response(null, { headers: { ...CORS, "Access-Control-Allow-Headers": req.headers.get("Access-Control-Request-Headers") ?? "*" } });
  }
  return new Response(null, { headers: { Allow: "GET, HEAD, POST, OPTIONS" } });
};

// ---------------------------------------------------------------------------
// apiKeyPath — /key/N/... or /key/N-M/...
// ---------------------------------------------------------------------------

export const apiKeyPathMiddleware: Middleware = async (ctx, next) => {
  const m = ctx.pathname.match(/^\/key\/(?:(\d+)?-(\d+)?|(\d+))/);
  if (m) {
    ctx.apiKeyIndex = m[3] !== undefined
      ? parseInt(m[3], 10)
      : { start: m[1] !== undefined ? parseInt(m[1], 10) : undefined,
          end:   m[2] !== undefined ? parseInt(m[2], 10) : undefined };
    ctx.pathname = ctx.pathname.replace(/^\/key\/[^/]+/, "") || "/";
  }
  return next();
};

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

export const authMiddleware: Middleware = async (ctx, next) => {
  ctx.pathname = cleanPathname(ctx.pathname);
  if (!getConfig().isDev && !authenticate(ctx.request)) throw new UnauthorizedError();
  return next();
};

// ---------------------------------------------------------------------------
// aiGateway — attaches CloudflareAIGateway to ctx
// ---------------------------------------------------------------------------

export const aiGatewayMiddleware: Middleware = async (ctx, next) => {
  const { accountId, name: gwName, token } = getConfig().aiGateway;

  if (ctx.pathname.startsWith("/g/") && accountId) {
    const parts      = ctx.pathname.split("/");
    ctx.aiGateway    = new CloudflareAIGateway(accountId, parts[2]!, token);
    ctx.pathname     = `/${parts.slice(3).join("/")}`;
  } else if (accountId && gwName) {
    ctx.aiGateway = new CloudflareAIGateway(accountId, gwName, token);
  }

  return next();
};

// ---------------------------------------------------------------------------
// router — final handler
// ---------------------------------------------------------------------------

export const routerMiddleware: Middleware = async (ctx) => {
  const { request, pathname, aiGateway, apiKeyIndex, requestId } = ctx;
  const method = request.method;

  if (pathname === "/ping")   return new Response("Pong", { status: 200 });
  if (pathname === "/status") return status(aiGateway);

  if (aiGateway && /^\/compat(?:$|\/|\?)/.test(pathname))
    return compat(request, pathname, aiGateway);

  if (method === "POST" && (pathname === "/chat/completions" || pathname === "/v1/chat/completions"))
    return chatCompletions(request, apiKeyIndex, aiGateway, requestId);

  if (method === "GET" && (pathname === "/models" || pathname === "/v1/models"))
    return models(apiKeyIndex, aiGateway, requestId);

  for (const name of getAllProviders().keys()) {
    if (pathname.startsWith(`/${name}/`))
      return proxy(request, name, pathname.slice(name.length + 1) || "/", apiKeyIndex, aiGateway);
  }

  if (aiGateway && method === "POST" && pathname === "/")
    return universalEndpoint(request, aiGateway);

  throw new NotFoundError();
};

// Exported chain for index.ts
export const middlewareChain = compose([
  errorMiddleware,
  requestMiddleware,
  corsMiddleware,
  apiKeyPathMiddleware,
  authMiddleware,
  aiGatewayMiddleware,
  routerMiddleware,
]);
