# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 3.x | Yes |
| 2.x | Security fixes only |
| < 2.0.0 | No |

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you discover a security issue in layercache, please report it responsibly:

- **Email**: Open a GitHub Security Advisory at [https://github.com/flyingsquirrel0419/layercache/security/advisories/new](https://github.com/flyingsquirrel0419/layercache/security/advisories/new)
- **Do not** open a public GitHub issue for security vulnerabilities

### What to Include

- A clear description of the vulnerability
- Steps to reproduce or a proof of concept
- The affected version(s)
- Any potential impact assessment

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 5 business days
- **Fix and disclosure**: Depends on severity, but we aim for critical issues within 7 days

### Disclosure Policy

- We practice coordinated disclosure
- We request 90 days before public disclosure to allow users to upgrade
- We will credit researchers who report vulnerabilities responsibly (unless you prefer to remain anonymous)

## Security Features

layercache includes several built-in security measures:

- **CSPRNG-based TTL jitter** — uses `crypto.randomBytes` instead of `Math.random()`
- **Input validation** — cache keys, patterns, and tags are validated before any operation
- **Prototype pollution protection** — all JSON/MessagePack deserialization strips dangerous keys
- **Decompression limits** — RedisLayer enforces `decompressionMaxBytes` (default 64 MiB) to prevent compression bombs
- **Snapshot path hardening** — snapshots are restricted to `snapshotBaseDir` by default, use temp file + `fs.rename`, and reject symlinked target parents before commit
- **Key truncation** — error messages truncate long keys to prevent log injection
- **Bounded work queues** — fetcher rate limiting rejects saturated queues by default, and `DiskLayer.maxWriteQueueDepth` prevents unbounded serialized disk writes
- **Circuit breaker isolation** — per-key, shared, and explicit breaker buckets are namespaced to avoid accidental dependency-bucket collisions
- **Redis CLI safeguards** — full-cache invalidation requires `--force`, Redis passwords are masked in output and nested connection errors, production `redis://` URLs are rejected unless `--allow-plaintext` is explicitly passed, and scan commands have bounded default limits
- **HTTP private-cache safeguards** — Express and Hono implicit URL caching bypasses requests with common sensitive query parameters such as access tokens, API keys, passwords, private keys, credentials, and session identifiers unless callers provide a custom `keyResolver`
- **Disk payload protection** — DiskLayer rejects unprotected plaintext entries when `encryptionKey` or `signingKey` is configured, unless `allowLegacyPlaintext` is explicitly enabled for migration
- **Telemetry key redaction** — OpenTelemetry exports hashed cache-key attributes by default; raw cache keys require explicit opt-in
- **Signed invalidation messages** — RedisInvalidationBus can sign and verify pub/sub invalidation messages with HMAC-SHA256 via `signingSecret`, and warns through the configured logger when running unsigned
- **Sharded Redis tag indexes** — RedisTagIndex defaults to 16 known-key shards to reduce single-set hot spots, with a migration command for legacy single-set deployments
- **Stats endpoint protection** — defaults to protected mode, requires explicit opt-in for public access

## Operational Guidance

- Use `rediss://` for production Redis endpoints. Only pass `--allow-plaintext` for trusted private networks where plaintext Redis is intentional.
- Set `signingSecret` on every process that shares a Redis invalidation channel outside a fully isolated Redis deployment.
- Migrate legacy RedisTagIndex known-key sets with `layercache migrate-tag-index` before depending on the v3 sharded layout in long-lived or mixed-version deployments.
- Use custom `keyResolver` functions for private HTTP responses, especially when identity or authorization data appears in query parameters.
- Keep `snapshotBaseDir` and DiskLayer directories process-owned and avoid group/world-writable parent directories.
- Treat `allowLegacyPlaintext` and `includeRawKeyAttributes` as temporary or explicitly reviewed opt-ins.
