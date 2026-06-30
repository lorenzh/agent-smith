import { expect, test } from "bun:test";
import { ConnectorRegistry, createGatewayHost } from "./index.ts";

test("host builds gateways from config", async () => {
	const host = await createGatewayHost({
		gateways: {
			"project-a": {
				backends: { fs: { type: "command", command: "mcp-server-fs" } },
			},
		},
	});
	expect(host.names()).toEqual(["project-a"]);
	expect(host.gateway("project-a")?.backends()).toEqual([
		{ alias: "fs", status: "configured" },
	]);
});

test("gateways and backends are mutable at runtime", async () => {
	const host = await createGatewayHost({ gateways: {} });

	const gw = await host.addGateway("project-b", { backends: {} });
	let changes = 0;
	gw.onChange(() => changes++);

	await gw.addBackend("gh", { type: "http", url: "https://example.com/mcp" });
	expect(gw.backends().map((b) => b.alias)).toEqual(["gh"]);
	expect(changes).toBe(1);

	await gw.removeBackend("gh");
	expect(gw.backends()).toEqual([]);
	expect(changes).toBe(2);

	await host.removeGateway("project-b");
	expect(host.names()).toEqual([]);
});

test("backends with unsafe aliases are rejected", async () => {
	const host = await createGatewayHost({ gateways: {} });
	const gw = await host.addGateway("p", { backends: {} });
	await expect(gw.addBackend("fs__evil", { type: "command" })).rejects.toThrow(
		/invalid alias/,
	);
	// config-seeded bad aliases throw at construction too
	expect(
		createGatewayHost({ gateways: { p2: { backends: { "a+b": {} } } } }),
	).rejects.toThrow(/invalid alias/);
});

test("registry rejects unknown connector types", () => {
	const registry = new ConnectorRegistry();
	expect(() => registry.create("docker", "x", {}, console as never)).toThrow(
		/no connector registered/,
	);
});
