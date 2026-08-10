// =============================================================================
// index.ts — Worker entry point
// =============================================================================

// Trigger provider self-registration
import "./providers.ts";

import { middlewareChain } from "./middlewares.ts";
import { logger }          from "./core.ts";
import type { Env }        from "./env.ts";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return middlewareChain({
      request,
      env,
      ctx,
      pathname:  "",
      requestId: "",
      log:       logger.child({}),
    });
  },
} satisfies ExportedHandler<Env>;

export { KeyRotationManager } from "./key_rotation_manager.ts";
