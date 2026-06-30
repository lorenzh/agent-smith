import { expect, test } from "bun:test";
import {
	assertValidAlias,
	decodeName,
	decodeUri,
	encodeName,
	encodeUri,
	isValidAlias,
	NamespaceIndex,
} from "./namespace.ts";

test("alias validation accepts safe aliases, rejects unsafe ones", () => {
	for (const ok of ["fs", "github", "gh-1", "a", "x9"]) {
		expect(isValidAlias(ok)).toBe(true);
	}
	for (const bad of [
		"",
		"-fs",
		"fs__x",
		"fs+x",
		"Fs",
		"a/b",
		"a:b",
		"a.b",
		"a b",
	]) {
		expect(isValidAlias(bad)).toBe(false);
	}
	expect(() => assertValidAlias("fs__x")).toThrow(/invalid alias/);
});

test("name round-trips, even when the original tool name contains the separator", () => {
	expect(encodeName("gh", "search")).toBe("gh__search");
	expect(decodeName("gh__search")).toEqual({ alias: "gh", name: "search" });

	// hostile: backend exposes a tool literally named "foo__bar"
	const exposed = encodeName("gh", "foo__bar");
	expect(exposed).toBe("gh__foo__bar");
	// split on FIRST separator -> alias is unambiguously "gh"
	expect(decodeName(exposed)).toEqual({ alias: "gh", name: "foo__bar" });
});

test("a backend cannot forge another backend's namespace via its tool name", () => {
	// backend "gh" tries to look like it belongs to alias "secret"
	const exposed = encodeName("gh", "secret__leak");
	// the operator-chosen alias "gh" is always the prefix; it never decodes to "secret"
	expect(decodeName(exposed)).toEqual({ alias: "gh", name: "secret__leak" });
});

test("decodeName rejects malformed input", () => {
	expect(decodeName("noseparator")).toBeUndefined();
	expect(decodeName("__leading")).toBeUndefined();
	expect(decodeName("gh__")).toBeUndefined();
});

test("uri round-trips and collapses the original into one path segment", () => {
	const exposed = encodeUri("fs", "file:///etc/hosts");
	expect(exposed).toBe("agent-smith://fs/file%3A%2F%2F%2Fetc%2Fhosts");
	expect(decodeUri(exposed)).toEqual({ alias: "fs", uri: "file:///etc/hosts" });
});

test("decodeUri rejects foreign schemes and malformed input", () => {
	expect(decodeUri("file:///x")).toBeUndefined();
	expect(decodeUri("agent-smith://fs")).toBeUndefined();
	expect(decodeUri("http://fs/x")).toBeUndefined();
});

test("NamespaceIndex resolves known entries and reports unknown ones", () => {
	const idx = new NamespaceIndex<number>();
	idx.add({ alias: "gh", original: "search", exposed: "gh__search", value: 1 });

	expect(idx.resolve("gh__search")?.value).toBe(1);
	expect(idx.resolve("gh__missing")).toBeUndefined();
	expect(idx.has("gh__search")).toBe(true);
	expect(idx.list()).toHaveLength(1);

	idx.clear();
	expect(idx.list()).toHaveLength(0);
});
