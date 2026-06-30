# Security Policy

## Reporting a vulnerability

Please do not report security issues through public GitHub issues.

Report privately through GitHub's [private vulnerability reporting](https://github.com/lorenzh/agent-smith/security/advisories/new),
or email **<lorenz@losoft.dev>**. Include a description, reproduction steps, and the
impact you expect. You will get an acknowledgement as soon as possible, and we will keep
you posted while we work on a fix.

## Scope and threat model

agent-smith is a gateway that proxies many downstream MCP servers. A few things are worth
keeping in mind, since this is early software and the security machinery is still being
designed:

- **Downstream servers may be untrusted.** Running a backend in a container or microvm is
  an explicit use case. Treat backend output (tool names, resource URIs, results) as
  hostile input until the isolation and validation layers described in `docs/SPEC.md` are
  fully implemented.
- **The admin API mutates the live host** (adding gateways and backends, including ones
  that spawn local processes). Do not expose it without authentication. It is unauthenticated
  in the current scaffold and must be guarded before any real deployment.

## Supported versions

The project is pre-1.0 and unreleased. Only `main` is supported. Once we cut releases this
section will list the supported version range.
