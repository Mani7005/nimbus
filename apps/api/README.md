# Nimbus API and execution worker

## Production build and start

Run from the repository root with Node.js 22.13+ and pnpm 11.28.6:

```sh
pnpm install --frozen-lockfile
pnpm --filter api exec prisma generate   # required before build: the TypeScript build uses the generated client
pnpm --filter api build                  # compiles src/ to dist/
DATABASE_URL=<direct connection> pnpm --filter api exec prisma migrate deploy   # once per release, before starting
pnpm --filter api start                  # API:    node dist/server.js
pnpm --filter api worker:start           # worker: node dist/workers/execution.worker.js
```

`pnpm --filter api dev` and `pnpm --filter api worker` remain the development commands (TypeScript via tsx).

The worker runs `docker run` for every submission, so it needs access to the Docker daemon, which is equivalent to
root on that host. Run it as a dedicated user and never give the API process Docker access or expose the daemon
over TCP. Pre-pull `gcc:14` and the `JAVA_IMAGE` reference in `src/adapters/java.adapter.ts`: containers run with
`--pull=never`.

## Configuration

Settings are validated at startup; an invalid or missing required value stops the process with a list of problems.
Never commit real values.

| Variable | Used by | Notes |
| --- | --- | --- |
| `DATABASE_URL` | API, worker | `postgresql://` URL. Use a direct (non-pooled) connection for `prisma migrate deploy`. |
| `REDIS_URL` | API, worker | `redis://` or `rediss://`; keep Redis off the public internet and password-protected. |
| `JWT_SECRET` | API | 32+ characters. The worker never reads it (it is only validated at startup), so give the worker a separate random value and keep the API's secret off the code-execution host. |
| `NODE_ENV` | API, worker | `production` enables the production defaults below and requires `CORS_ORIGINS`. Set it on the worker too: without it the worker keeps all history (its startup log then reports retention as disabled). |
| `CORS_ORIGINS` | API | Comma-separated exact `https://` origins of the web app. Required in production; defaults to `http://localhost:5173` otherwise. Wildcards are rejected. The worker shares this validation, so set the same value there. |
| `TRUST_PROXY` | API | Number of reverse proxies in front of the API (0 by default). Must match the real chain, and the API port must only be reachable through them. |
| `EXECUTION_CONTAINER_CLEANUP` | worker | `dry-run` by default; set `remove` in production. |

Execution limits with different defaults in production (all can be set explicitly):

| Variable | Development/test | Production |
| --- | --- | --- |
| `EXECUTION_MAX_OUTPUT_BYTES` (per stream) | 65536 | 16384 |
| `EXECUTION_RATE_LIMIT` (per user per `EXECUTION_RATE_WINDOW_MS`) | 20 | 10 |
| `EXECUTION_MAX_ACTIVE_PER_USER` | 3 | 2 |
| `EXECUTION_MAX_ACTIVE_TOTAL` (all users; 0 disables) | 0 | 30 |
| `EXECUTION_HISTORY_MAX_PER_USER` (0 keeps all) | 0 | 50 |
| `EXECUTION_HISTORY_MAX_TOTAL` (0 keeps all) | 0 | 1000 |

A submission over the user's own cap gets HTTP 429; one that would take the service-wide number of PENDING + RUNNING
executions above `EXECUTION_MAX_ACTIVE_TOTAL` gets HTTP 503 with `Retry-After: 30`. In both cases nothing is stored
or queued. Both caps are enforced in one database transaction holding PostgreSQL advisory locks, so they hold across
concurrent requests and several API instances. While the global cap is enabled, submissions are serialized for the
duration of that short transaction. The reconciler runs inside the worker, so while the worker is stopped nothing
processes or reconciles queued executions: they stay PENDING, the global cap can remain full, and new submissions
can keep getting 503 until the worker resumes and processes or reconciles the outstanding executions.

The worker deletes the oldest finished executions (COMPLETED, FAILED, TIMEOUT) beyond the history limits every
`EXECUTION_RETENTION_INTERVAL_MS` (5 minutes by default); PENDING and RUNNING executions are never deleted. The total
limit removes the oldest history of any user. With the production defaults a finished execution stores at most
50,000 characters of code (up to about 150 KB as UTF-8), 20,000 characters of input (about 60 KB) and 4 × 16 KiB of
output (the program's and the compiler's stdout and stderr), so 1000 finished executions take under 300 MB in the
worst case, before Postgres overhead. Unfinished executions are bounded separately, by `EXECUTION_MAX_ACTIVE_PER_USER`
per user.

See `src/config/env.ts` and `src/config/sandbox.ts` for every other setting and its range.
