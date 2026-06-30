import type { HostConfig } from "@agent-smith/mcp-gateway";

// Startup seed only. The live state is whatever the mutable host holds after
// any admin calls. Swap this for a file/env loader later.
export const config: HostConfig = {
	gateways: {
		"project-a": {
			backends: {
				fs: {
					type: "command",
					command: "mcp-server-fs",
					args: ["--root", "."],
				},
			},
			middleware: ["@agent-smith/mcp-gateway-middleware-logging"],
		},
		"project-b": {
			backends: {
				gh: { type: "http", url: "https://example.com/mcp" },
			},
		},
	},
};
