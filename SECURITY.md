# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| >= 1.3.x | Yes |
| < 1.3.0 | No |

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
- **Atomic file writes** — snapshots use temp file + `fs.rename` to prevent TOCTOU races
- **Key truncation** — error messages truncate long keys to prevent log injection
- **CLI safeguards** — mass deletion requires `--force`, Redis passwords are masked in output
- **Stats endpoint protection** — defaults to protected mode, requires explicit opt-in for public access
