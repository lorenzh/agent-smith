// Namespacing: how a backend alias plus an original tool/prompt name or resource uri
// becomes a single client-facing identifier, and how it routes back to one backend.
//
// Two rules make this unambiguous and safe against hostile backend-chosen names:
//   1. Aliases are validated (ALIAS_RE) so they can never contain the separator or break
//      a uri. The operator picks the alias; the backend only controls the original part.
//   2. Routing goes through an authoritative NamespaceIndex built during aggregation, not
//      by re-parsing a backend-controlled string in the hot path. decode* exist for
//      building/echoing, but resolve() is the source of truth for "does this target exist".

/** Lowercase alphanumeric plus hyphen, must start alphanumeric. Safe in `a__b` and uris. */
export const ALIAS_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Separator for name-based primitives (tools, prompts). */
export const NAME_SEP = "__";

/** Scheme for namespaced resource uris. */
export const RESOURCE_SCHEME = "agent-smith";

export function isValidAlias(alias: string): boolean {
	return ALIAS_RE.test(alias);
}

export function assertValidAlias(alias: string): void {
	if (!isValidAlias(alias)) {
		throw new Error(
			`invalid alias "${alias}": must match ${ALIAS_RE} (lowercase alphanumeric and hyphen)`,
		);
	}
}

// --- name-based primitives (tools, prompts) ---------------------------------

export function encodeName(alias: string, name: string): string {
	return `${alias}${NAME_SEP}${name}`;
}

/**
 * Split on the FIRST separator. The alias cannot contain `__` (validated), so the prefix up
 * to the first `__` is always the alias; everything after is the original name, even if the
 * original itself contains `__`.
 */
export function decodeName(
	exposed: string,
): { alias: string; name: string } | undefined {
	const i = exposed.indexOf(NAME_SEP);
	if (i <= 0) return undefined;
	const alias = exposed.slice(0, i);
	const name = exposed.slice(i + NAME_SEP.length);
	if (name.length === 0 || !isValidAlias(alias)) return undefined;
	return { alias, name };
}

// --- uri-based primitives (resources) ---------------------------------------

export function encodeUri(alias: string, uri: string): string {
	// encodeURIComponent escapes `/` `:` etc., so the original uri collapses into one path
	// segment and cannot inject extra authority/path structure.
	return `${RESOURCE_SCHEME}://${alias}/${encodeURIComponent(uri)}`;
}

export function decodeUri(
	exposed: string,
): { alias: string; uri: string } | undefined {
	const prefix = `${RESOURCE_SCHEME}://`;
	if (!exposed.startsWith(prefix)) return undefined;
	const rest = exposed.slice(prefix.length);
	const slash = rest.indexOf("/");
	if (slash <= 0) return undefined;
	const alias = rest.slice(0, slash);
	const encoded = rest.slice(slash + 1);
	if (!isValidAlias(alias)) return undefined;
	try {
		return { alias, uri: decodeURIComponent(encoded) };
	} catch {
		return undefined;
	}
}

// --- authoritative routing map ----------------------------------------------

export interface NamespaceEntry<T> {
	alias: string;
	/** Original name or uri as the backend knows it. */
	original: string;
	/** Client-facing identifier. */
	exposed: string;
	/** Whatever the Pool needs to route or merge (e.g. the Tool, or a backend handle). */
	value: T;
}

/**
 * Built fresh on every aggregation pass. `resolve()` is how call ops find their single
 * target, so a call to an unknown or stale exposed id returns undefined (the Pool turns
 * that into a proper error) instead of being decoded and forwarded blindly.
 */
export class NamespaceIndex<T> {
	#byExposed = new Map<string, NamespaceEntry<T>>();

	add(entry: NamespaceEntry<T>): void {
		this.#byExposed.set(entry.exposed, entry);
	}

	resolve(exposed: string): NamespaceEntry<T> | undefined {
		return this.#byExposed.get(exposed);
	}

	has(exposed: string): boolean {
		return this.#byExposed.has(exposed);
	}

	list(): NamespaceEntry<T>[] {
		return [...this.#byExposed.values()];
	}

	clear(): void {
		this.#byExposed.clear();
	}
}
