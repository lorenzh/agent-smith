import { assertValidAlias } from "./namespace.ts";
import type { ConnectorRegistry } from "./registry.ts";
import type {
	BackendConfig,
	BackendInfo,
	Gateway,
	GatewayConfig,
	GatewayHost,
	GatewayServer,
	HostConfig,
	Logger,
	Middleware,
} from "./types.ts";

const consoleLogger: Logger = {
	info: (m) => console.log(`[mcp-gateway] ${m}`),
	warn: (m) => console.warn(`[mcp-gateway] ${m}`),
	error: (m) => console.error(`[mcp-gateway] ${m}`),
};

export interface HostDeps {
	registry?: ConnectorRegistry;
	logger?: Logger;
}

// Minimal mutable Gateway. Backends are stored from config but not yet connected;
// the Pool / Connector wiring lands next. See docs/SPEC.md.
class InMemoryGateway implements Gateway {
	readonly name: string;
	#backends = new Map<string, BackendConfig>();
	#instructions = new Map<string, string>(); // alias -> instructions, filled on connect
	#middleware: Middleware[] = [];
	#listeners = new Set<() => void>();
	#logger: Logger;

	constructor(name: string, config: GatewayConfig, logger: Logger) {
		this.name = name;
		this.#logger = logger;
		for (const [alias, cfg] of Object.entries(config.backends)) {
			assertValidAlias(alias);
			this.#backends.set(alias, cfg);
		}
	}

	createServer(): GatewayServer {
		// TODO: return a per-session MCP Server facade wired into the shared Pool,
		// serving instructions() in its initialize result.
		return { gatewayName: this.name };
	}

	instructions(): string {
		// TODO: source each backend's instructions from its initialize result.
		// Merge labeled by alias so a model can tell which server said what.
		return [...this.#backends.keys()]
			.map((alias) => this.#instructions.get(alias))
			.filter((text): text is string => Boolean(text))
			.join("\n\n");
	}

	async addBackend(alias: string, config: BackendConfig): Promise<void> {
		assertValidAlias(alias);
		this.#backends.set(alias, config);
		this.#logger.info(`${this.name}: + backend "${alias}"`);
		this.#emit();
	}

	async removeBackend(alias: string): Promise<void> {
		if (this.#backends.delete(alias)) {
			this.#logger.info(`${this.name}: - backend "${alias}"`);
			this.#emit();
		}
	}

	backends(): BackendInfo[] {
		return [...this.#backends.keys()].map((alias) => ({
			alias,
			status: "configured",
		}));
	}

	use(mw: Middleware): void {
		this.#middleware.push(mw);
	}

	onChange(cb: () => void): () => void {
		this.#listeners.add(cb);
		return () => this.#listeners.delete(cb);
	}

	async dispose(): Promise<void> {
		this.#backends.clear();
		this.#listeners.clear();
	}

	#emit(): void {
		// On real backends this also pushes notifications/*/list_changed to live sessions.
		for (const cb of this.#listeners) cb();
	}
}

class InMemoryHost implements GatewayHost {
	#gateways = new Map<string, Gateway>();
	#logger: Logger;

	constructor(logger: Logger) {
		this.#logger = logger;
	}

	names(): string[] {
		return [...this.#gateways.keys()];
	}

	gateway(name: string): Gateway | undefined {
		return this.#gateways.get(name);
	}

	async addGateway(name: string, config: GatewayConfig): Promise<Gateway> {
		const gw = new InMemoryGateway(name, config, this.#logger);
		this.#gateways.set(name, gw);
		this.#logger.info(`+ gateway "${name}"`);
		return gw;
	}

	async removeGateway(name: string): Promise<void> {
		const gw = this.#gateways.get(name);
		if (!gw) return;
		await gw.dispose();
		this.#gateways.delete(name);
		this.#logger.info(`- gateway "${name}"`);
	}

	async dispose(): Promise<void> {
		for (const gw of this.#gateways.values()) await gw.dispose();
		this.#gateways.clear();
	}
}

export async function createGatewayHost(
	config: HostConfig,
	deps: HostDeps = {},
): Promise<GatewayHost> {
	const logger = deps.logger ?? consoleLogger;
	const host = new InMemoryHost(logger);
	for (const [name, gwConfig] of Object.entries(config.gateways)) {
		await host.addGateway(name, gwConfig);
	}
	return host;
}
