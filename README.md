# GitHub Core Clone — a GitHub-compatible forge in TypeScript

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ham919390/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ham919390/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

This repository is an entry for the
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01) bounty on
make.fun. It is a working git forge that speaks GitHub's four client surfaces —
git smart HTTP, the REST v3 API, the GraphQL v4 API and an MCP endpoint — all
backed by a single in-memory store, so a repository, issue or pull request
created through one surface is immediately the same object through the other
three.

Everything is written in TypeScript against the Node standard library alone:
no dependencies, nothing to install. A fresh process starts as an empty forge.

## How it runs

```sh
node --experimental-strip-types main.ts
```

Node 22.18 or newer is required (see `engines` in `package.json`). `main.ts`
is only the lifecycle the harness drives: it builds the server from `app.ts`,
binds an ephemeral port, announces that port to the trial environment with
`POST $MAKEFUN_ENV_URL/register`, then polls `GET $MAKEFUN_ENV_URL/done` until
the environment ends the trial, and exits 0. The port is never hard-coded —
8080 belongs to the environment itself.

`app.ts` is the router. It stamps every response with an
`X-GitHub-Request-Id` header, answers `GET /healthz`, and dispatches by path:
`/api/v3…` to REST, `/api/graphql` to GraphQL, `/mcp` to the MCP endpoint, and
`/<owner>/<repo>.git/…` to the git transport.

## Layout

- **`store.ts`** — the forge's state and domain rules, shared by every
  surface: repositories and their refs, the git object map, labels, issues,
  comments and pull requests (issues and pull requests draw numbers from one
  per-repository sequence, as on GitHub), three-way conflict detection for
  merges, and squash merging. It also owns the deterministic logical clock
  described below.
- **`gitobj.ts`** — the git object model underneath everything: SHA-1
  addressing for commit, tree, blob and tag objects, tree serialisation and
  parsing following git's own sort rule, packfile reading (plain objects plus
  OFS-delta and REF-delta resolution), packfile writing, and pkt-line framing.
- **`githttp.ts`** — git smart HTTP. It serves `info/refs` advertisements for
  protocol v0 and v2, the v2 `ls-refs` command with ref-prefix filtering,
  peeled annotated tags and an unborn HEAD, fetch over both protocol versions
  (incremental, up-to-date, shallow and deepen, honouring shallow-boundary
  semantics for haves), and v0 `receive-pack` pushes with fast-forward
  validation — a non-fast-forward update is refused with exactly that reason —
  and report-status returned over side-band-64k, including mixed ok/ng results
  for multi-ref pushes.
- **`rest.ts`** — the REST v3 API: the API root and meta endpoints, the
  token's user, repository CRUD with `Link`-header pagination, branches, git
  refs, commit history, file contents (create and update, where a stale `sha`
  is answered 409; directory listings; delete), labels, issues with state and
  sort filters and comments, and pull requests including the changed-files
  diff with line counts and squash merges (405 when a merge conflicts, 404 for
  unknown resources). Authentication failures are 401, validation failures
  422, and every error body follows GitHub's `{message}` shape.
- **`graphql.ts`** — the GraphQL v4 API. A hand-written parser (operations,
  variables, aliases, inline fragments, input objects, batched operation
  arrays) feeds a fixed-schema executor covering `viewer`, `repository`,
  `node(id)` and `__type` introspection, issue and pull request connections
  with cursor pagination ordered by creation time, and the `createIssue`,
  `closeIssue`, `createPullRequest`, `mergePullRequest` and `addComment`
  mutations. An unknown field is reported by name as a field error.
- **`mcp.ts`** — the MCP endpoint: JSON-RPC over streamable HTTP. It speaks
  the modern `server/discover` revision (2026-07-28) and the legacy
  `initialize` handshake, and exposes six tools under the canonical
  github-mcp-server names and argument schemas — `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request` and
  `merge_pull_request` — acting on the same store as REST. Malformed JSON is a
  `-32700` parse error answered with HTTP 400, unknown tools and missing
  arguments are `-32602`, and requests without authentication are 401.
- **`scenario.ts`** — the trial world the forge must recognise, reproduced
  faithfully from the conformance suite's seeded generator: a xorshift64*
  PRNG over BigInt, one stream per label seeded by
  `mix64(SCENARIO_SEED ^ fnv1a64(label))`, producing the twelve users (the
  trial token belongs to the first, the viewer; the next two are a teammate
  and a stranger), the organisation name and the default label set. REST
  checks address repositories as `/repos/{viewer.login}/{name}`, so the forge
  has to know these identities exactly.

## Determinism

Nothing in a response depends on the wall clock or on randomness. Timestamps
come from a logical clock in `store.ts` seeded at the scenario epoch
(1735689600) and advanced by exactly one second per event, so replaying the
same sequence of requests produces byte-identical bodies. Request ids are a
simple counter from the same store.

## Verification

The entry was exercised locally with the bounty kit's own conformance
environment, driving the server exactly the way a trial does, and passes
**120/120 conformance checks** across the git, GraphQL, issues, MCP, protocol,
pulls and repos areas, repeatably across runs.

## Provenance

The repository carries `.makefun/owner.json` naming the entering wallet, and
is MIT-licensed (see `LICENSE`).
