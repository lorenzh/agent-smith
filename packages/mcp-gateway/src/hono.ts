import type { Gateway } from "./types.ts";

// Structural subset of Hono's Context so core stays framework-free.
interface McpContext {
	req: { raw: Request };
}

/**
 * Build a fetch-native handler that serves one gateway over Streamable HTTP.
 *
 * Hello-world stub: returns the gateway's backend list. The real version keeps a
 * Map<sessionId, WebStandardStreamableHTTPServerTransport>, calls gateway.createServer()
 * on new sessions, and returns transport.handleRequest(c.req.raw). See docs/SPEC.md.
 */
export function honoMcp(gateway: Gateway) {
	return async (_c: McpContext): Promise<Response> => {
		return Response.json({
			gateway: gateway.name,
			backends: gateway.backends(),
			note: "stub: Streamable HTTP transport not wired yet",
		});
	};
}
