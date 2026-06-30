import { ConnectorRegistry, createGatewayHost } from "@agent-smith/mcp-gateway";
import { honoMcp } from "@agent-smith/mcp-gateway/hono";
import { childProcess } from "@agent-smith/mcp-gateway-backend-child-process";
import { Hono } from "hono";
import { config } from "./config.ts";

// Register the connectors this server supports. Packages plug in here.
const registry = new ConnectorRegistry().register("command", childProcess);

const host = await createGatewayHost(config, { registry });

const app = new Hono();

app.get("/", (c) => c.json({ name: "agent-smith", gateways: host.names() }));

// One dynamic route: new gateways need no new route.
app.all("/:gateway/mcp", async (c) => {
	const gw = host.gateway(c.req.param("gateway"));
	if (!gw) return c.json({ error: "unknown gateway" }, 404);
	return honoMcp(gw)(c);
});

// Admin API: mutates the live host, no restart. Guard behind auth before prod.
const admin = new Hono();

admin.post("/gateways/:name", async (c) => {
	const name = c.req.param("name");
	const body = await c.req.json().catch(() => ({ backends: {} }));
	await host.addGateway(name, { backends: body.backends ?? {} });
	return c.json({ ok: true, name });
});

admin.delete("/gateways/:name", async (c) => {
	await host.removeGateway(c.req.param("name"));
	return c.json({ ok: true });
});

admin.post("/gateways/:name/backends", async (c) => {
	const gw = host.gateway(c.req.param("name"));
	if (!gw) return c.json({ error: "unknown gateway" }, 404);
	const { alias, config: backendConfig } = await c.req.json();
	await gw.addBackend(alias, backendConfig);
	return c.json({ ok: true, alias });
});

admin.delete("/gateways/:name/backends/:alias", async (c) => {
	const gw = host.gateway(c.req.param("name"));
	if (!gw) return c.json({ error: "unknown gateway" }, 404);
	await gw.removeBackend(c.req.param("alias"));
	return c.json({ ok: true });
});

app.route("/admin", admin);

export default app;
