# makefun-github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ham919390/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ham919390/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in dependency-free TypeScript (Node standard library
only): one in-memory store served over four surfaces — git smart HTTP, REST v3,
GraphQL v4 and an MCP endpoint — built for the
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01) bounty on make.fun.

## What it implements

- **Git smart HTTP** — v0 and v2 `info/refs` advertisements, v2 `ls-refs` with
  ref-prefix filtering and peeled annotated tags, fetch (incremental, shallow,
  deepen) and v0 `receive-pack` with fast-forward validation and report-status.
  Git objects are content-addressed SHA-1 with pack read/write (plain and
  OFS/REF deltas) in `gitobj.ts`; the protocol lives in `githttp.ts`.
- **REST v3** (`rest.ts`) — root and meta, the authenticated user, repositories
  CRUD with Link-header pagination, branches, git refs, commits, contents
  (create/update with 409 on a stale sha, directory listings, delete), labels,
  issues with comments, and pull requests with file diffs and squash merges.
  Errors follow GitHub's 401/404/422 JSON discipline, and every reply carries an
  `X-GitHub-Request-Id`.
- **GraphQL v4** (`graphql.ts`) — a small real parser and fixed-schema executor:
  `viewer`, `repository`, `node(id)`, `__type` introspection, issue and pull
  request connections with cursor pagination, and the create/close/merge/comment
  mutations.
- **MCP** (`mcp.ts`) — a JSON-RPC endpoint with the modern `server/discover`
  handshake plus the legacy initialize flow, exposing the six canonical
  github-mcp-server tools against the same store.

State is deterministic: a logical clock seeded from the trial scenario
(`scenario.ts`, a byte-exact port of the harness's seeded scenario) advances one
second per event, so responses never depend on wall time or randomness.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port and registers it with the harness env at
`MAKEFUN_ENV_URL`; there is nothing to install.

## Local verification

Against the kit's own conformance environment (git, GraphQL, issues, MCP,
protocol, pulls, repos): **120/120 checks pass**, across repeated runs.
