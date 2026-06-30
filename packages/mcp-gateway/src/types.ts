// Core contracts for the MCP gateway. See docs/SPEC.md.
//
// Transport / Tool / Resource / Prompt and result types will come from
// @modelcontextprotocol/sdk once the transport is wired. Placeholder shapes for now.

export type Transport = unknown;
export type Tool = { name: string; description?: string };

export interface Logger {
	info(msg: string): void;
	warn(msg: string): void;
	error(msg: string): void;
}

// --- Connector: the per-isolation-model extension point ---------------------

export interface ConnectorContext {
	alias: string;
	logger: Logger;
}

export interface BackendConnector {
	readonly alias: string;
	/** Called on first connect and on every restart. Slow boots happen here. */
	connect(signal: AbortSignal): Promise<Transport>;
	/** Optional isolation-specific teardown beyond closing the transport. */
	dispose?(): Promise<void>;
}

export type ConnectorFactory = (
	config: unknown,
	ctx: ConnectorContext,
) => BackendConnector;

// --- Middleware -------------------------------------------------------------

/** A completion ref carries a namespaced name (prompt) or uri (resource). */
export type CompletionRef =
	| { type: "ref/prompt"; name: string }
	| { type: "ref/resource"; uri: string };

export type GatewayOperation =
	// list ops: fan out to every backend, merge
	| { kind: "tools/list" }
	| { kind: "resources/list" }
	| { kind: "resources/templates/list" }
	| { kind: "prompts/list" }
	// call ops: route to the single backend that owns the namespaced name/uri/ref
	| { kind: "tools/call"; name: string }
	| { kind: "resources/read"; uri: string }
	| { kind: "resources/subscribe"; uri: string }
	| { kind: "resources/unsubscribe"; uri: string }
	| { kind: "prompts/get"; name: string }
	| { kind: "completion/complete"; ref: CompletionRef };

export interface GatewayContext {
	operation: GatewayOperation;
	/** One entry for call ops, many for list ops. */
	backends: { alias: string }[];
	/** Mutable: rewrite args before next(). */
	request: unknown;
	/** Set after next(); mutable on the way out. */
	response?: unknown;
	/** Scratch space (timing, request id, auth principal). */
	meta: Record<string, unknown>;
}

export type Next = () => Promise<void>;
export type Middleware = (ctx: GatewayContext, next: Next) => Promise<void>;

// --- Access control ---------------------------------------------------------

export interface AccessRule {
	allow?: string[];
	deny?: string[];
}

// --- Config -----------------------------------------------------------------

export interface BackendConfig {
	type?: string; // selects the connector; defaults to "command"
	[key: string]: unknown;
}

export interface GatewayConfig {
	backends: Record<string, BackendConfig>;
	middleware?: string[];
	access?: {
		tools?: AccessRule;
		resources?: AccessRule;
		prompts?: AccessRule;
	};
}

export interface HostConfig {
	gateways: Record<string, GatewayConfig>;
}

// --- Runtime objects (mutable) ----------------------------------------------

/** Per-session MCP Server facade over a Gateway's shared Pool. Wired to the SDK later. */
export interface GatewayServer {
	readonly gatewayName: string;
}

export interface BackendInfo {
	alias: string;
	status: string;
}

export interface Gateway {
	readonly name: string;
	createServer(): GatewayServer;

	/** Merged instructions from every backend, served in the initialize result. */
	instructions(): string;

	addBackend(alias: string, config: BackendConfig): Promise<void>;
	removeBackend(alias: string): Promise<void>;
	backends(): BackendInfo[];

	use(mw: Middleware): void;
	onChange(cb: () => void): () => void;
	dispose(): Promise<void>;
}

export interface GatewayHost {
	names(): string[];
	gateway(name: string): Gateway | undefined;
	addGateway(name: string, config: GatewayConfig): Promise<Gateway>;
	removeGateway(name: string): Promise<void>;
	dispose(): Promise<void>;
}
