import { PassThrough } from "stream";
import type * as koa from "koa";
import type {
  AppLoadContext,
  ServerBuild,
  RequestInit as NodeRequestInit,
  Response as NodeResponse,
} from "@remix-run/node";
import {
  // This has been added as a global in node 15+
  AbortController,
  createRequestHandler as createRemixRequestHandler,
  Headers as NodeHeaders,
  Request as NodeRequest,
} from "@remix-run/node";

/**
 * A function that returns the value to use as `context` in route `loader` and
 * `action` functions.
 *
 * You can think of this as an escape hatch that allows you to pass
 * environment/platform-specific values through to your loader/action.
 */
export interface GetLoadContextFunction {
  (ctx: koa.Context): AppLoadContext;
}

export type RequestHandler = ReturnType<typeof createRequestHandler>;

export function createRequestHandler({
  build,
  getLoadContext,
  mode = process.env.NODE_ENV,
}: {
  build: ServerBuild;
  getLoadContext?: GetLoadContextFunction;
  mode?: string;
}) {
  let handleRequest = createRemixRequestHandler(build, mode);

  return async (ctx: koa.Context, next: koa.Next) => {
    let abortController = new AbortController();
    let request = createNodeRequest(ctx.request, abortController);
    let loadContext =
      typeof getLoadContext === "function" ? getLoadContext(ctx) : undefined;

    let response = (await handleRequest(
      request as unknown as Request,
      loadContext
    )) as unknown as NodeResponse;

    sendNodeResponse(ctx, response, abortController);
  };
}

export function createNodeHeaders(
  koaRequestHeaders: koa.Request["headers"]
): NodeHeaders {
  let nodeHeaders = new NodeHeaders();

  for (let [key, values] of Object.entries(koaRequestHeaders)) {
    if (values) {
      if (Array.isArray(values)) {
        for (let value of values) {
          nodeHeaders.append(key, value);
        }
      } else {
        nodeHeaders.set(key, values);
      }
    }
  }

  return nodeHeaders;
}

export function createNodeRequest(
  koaRequest: koa.Request,
  abortController?: AbortController
): NodeRequest {
  let origin = `${koaRequest.protocol}://${koaRequest.get("host")}`;
  let url = new URL(koaRequest.url, origin);

  let init: NodeRequestInit = {
    method: koaRequest.method,
    headers: createNodeHeaders(koaRequest.headers),
    signal: abortController?.signal,
    abortController,
  };

  if (koaRequest.method !== "GET" && koaRequest.method !== "HEAD") {
    init.body = koaRequest.req.pipe(new PassThrough({ highWaterMark: 16384 }));
  }

  return new NodeRequest(url.href, init);
}

function sendNodeResponse(
  ctx: koa.Context,
  nodeResponse: NodeResponse,
  abortController: AbortController
): void {
  ctx.message = nodeResponse.statusText;
  ctx.status = nodeResponse.status;

  for (let [key, values] of Object.entries(nodeResponse.headers.raw())) {
    for (let value of values) {
      ctx.append(key, value);
    }
  }

  if (abortController.signal.aborted) {
    ctx.set("Connection", "close");
  }

  if (Buffer.isBuffer(nodeResponse.body)) {
    ctx.body = nodeResponse.body;
  } else if (nodeResponse.body?.pipe) {
    ctx.body = nodeResponse.body.pipe(
      new PassThrough({ highWaterMark: 16384 })
    );
  }
}
