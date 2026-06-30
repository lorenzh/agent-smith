import type { BackendConnector, ConnectorFactory, Logger } from "./types.ts";

/** Maps a backend `type` to the connector that knows how to reach it. */
export class ConnectorRegistry {
	#factories = new Map<string, ConnectorFactory>();

	register(type: string, factory: ConnectorFactory): this {
		this.#factories.set(type, factory);
		return this;
	}

	has(type: string): boolean {
		return this.#factories.has(type);
	}

	create(
		type: string,
		alias: string,
		config: unknown,
		logger: Logger,
	): BackendConnector {
		const factory = this.#factories.get(type);
		if (!factory) {
			throw new Error(`no connector registered for type "${type}"`);
		}
		return factory(config, { alias, logger });
	}
}
