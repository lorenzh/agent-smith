import type {
	BackendConnector,
	ConnectorContext,
	ConnectorFactory,
	Transport,
} from "@agent-smith/mcp-gateway";

export interface ChildProcessConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

/**
 * Runs a backend MCP server as a raw child process over stdio.
 *
 * Hello-world stub: logs what it would spawn. The real version spawns the process
 * and wraps its stdio in an SDK StdioClientTransport. See docs/SPEC.md.
 */
export const childProcess: ConnectorFactory = (
	rawConfig,
	ctx: ConnectorContext,
): BackendConnector => {
	const config = rawConfig as ChildProcessConfig;
	return {
		alias: ctx.alias,
		async connect(): Promise<Transport> {
			const cmd = [config.command, ...(config.args ?? [])].join(" ");
			ctx.logger.info(`child-process: would spawn \`${cmd}\``);
			// TODO: Bun.spawn + StdioClientTransport, then return the transport.
			return {} as Transport;
		},
	};
};
