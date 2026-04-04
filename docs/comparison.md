# Layercache Comparison

## layercache vs. node-cache-manager

| Capability | layercache | node-cache-manager |
| --- | --- | --- |
| Multi-layer read-through cache | Yes | Partial |
| Built-in tag invalidation | Yes | No |
| Cross-instance L1 invalidation | Yes | No |
| Warm/preload API | Yes | No |
| Namespaces | Yes | No |
| Snapshot/import/export | Yes | No |
| Compression in Redis layer | Yes | No |
| Built-in CLI | Yes | No |

## layercache vs. keyv

| Capability | layercache | keyv |
| --- | --- | --- |
| Layered cache hierarchy | Yes | No |
| Stampede protection | Yes | No |
| Distributed single-flight | Yes | No |
| Stale strategies | Yes | No |
| Cache warming | Yes | No |
| Operational stats handler | Yes | No |

## layercache vs. cacheable

| Capability | layercache | cacheable |
| --- | --- | --- |
| Layered memory + Redis workflow | Yes | Partial |
| Tag invalidation | Yes | No |
| Decorator/wrap helpers | Yes | Partial |
| Graceful degradation | Yes | No |
| Circuit breaker support | Yes | No |
| Admin CLI | Yes | No |
