import type { Logger, Middleware } from "@agent-smith/mcp-gateway";

export interface LoggingOptions {
	logger?: Pick<Logger, "info">;
}

/** Logs every operation with timing. Wraps next() so it covers both directions. */
export function logging(options: LoggingOptions = {}): Middleware {
	const log = options.logger ?? { info: (m: string) => console.log(m) };
	return async (ctx, next) => {
		const start = performance.now();
		try {
			await next();
		} finally {
			const ms = (performance.now() - start).toFixed(1);
			const targets = ctx.backends.map((b) => b.alias).join(",") || "-";
			log.info(`[mcp-gateway] ${ctx.operation.kind} [${targets}] ${ms}ms`);
		}
	};
}
