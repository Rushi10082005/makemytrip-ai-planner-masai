import { createStart, createCsrfMiddleware, createMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";

const errorMiddleware = createMiddleware().server(async ({ next, request }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error("[Server Error]", error);
    const isRpc =
      request?.headers?.get("accept")?.includes("application/json") ||
      request?.url?.includes("/_serverFn");
    if (isRpc) {
      return new Response(JSON.stringify({ error: "server_error", message: String(error) }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
  origin: () => true,
  secFetchSite: () => true,
  allowRequestsWithoutOriginCheck: true,
});

export const startInstance = createStart(() => ({
  requestMiddleware: [errorMiddleware, csrfMiddleware],
}));
