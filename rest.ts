// The GitHub REST v3 surface: /api/v3 root, meta, the token's user, repositories, branches,
// git refs, commits, contents, labels, issues, comments and pull requests. Every reply is JSON
// with a non-empty X-GitHub-Request-Id (set by app.ts); errors are {message} objects.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit, parseTree } from './gitobj.ts';
import {
  ForgeError,
  addComment,
  branchFiles,
  commitLog,
  commitOnBranch,
  createIssue,
  createPull,
  createRepo,
  deleteRepo,
  getObject,
  getRepo,
  mergePull,
  notFound,
  objects,
  pullFiles,
  repoGlobalId,
  reposOf,
  requireRepo,
  resolveRef,
  storeObject,
  tickIso,
  viewerUser,
  type CommentRec,
  type IssueRec,
  type LabelRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { USERS, VIEWER, type ScenarioUser } from './scenario.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

export function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof ForgeError) {
    sendJson(res, error.status, { message: error.message });
    return;
  }
  sendJson(res, 500, { message: error instanceof Error ? error.message : 'Internal error' });
}

function hasAuth(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.trim() !== '';
}

// ------------------------------------------------------------------ views

export function userView(user: ScenarioUser): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: Buffer.from(`User:${user.login}`, 'utf8').toString('base64'),
    type: 'User',
    site_admin: false,
    name: user.name,
    email: user.email,
    html_url: `https://forge.invalid/${user.login}`,
    url: `/api/v3/users/${user.login}`,
    avatar_url: '',
    gravatar_id: '',
  };
}

export function repoView(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userView(USERS.find((user) => user.login === repo.owner) ?? VIEWER),
    private: repo.isPrivate,
    description: repo.description,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    license: null,
    topics: [],
  };
}

function labelView(repo: RepoRec, label: LabelRec): Record<string, unknown> {
  let hash = 0;
  for (let i = 0; i < label.name.length; i += 1) hash = (hash * 31 + label.name.charCodeAt(i)) >>> 0;
  return {
    id: hash,
    node_id: Buffer.from(`Label:${repo.dbId}:${label.name}`, 'utf8').toString('base64'),
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
  };
}

export function issueView(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.dbId}:${issue.number}`, 'utf8').toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => labelView(repo, repo.labels.get(name) ?? { name, color: 'ededed', description: null })),
    user: userView(VIEWER),
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

export function commentView(repo: RepoRec, issue: IssueRec, comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${repo.dbId}:${issue.number}:${comment.id}`, 'utf8').toString('base64'),
    body: comment.body,
    user: userView(VIEWER),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function refSideView(repo: RepoRec, refName: string): Record<string, unknown> {
  const tip = repo.refs.get(`refs/heads/${refName}`);
  return {
    label: `${repo.owner}:${refName}`,
    ref: refName,
    sha: tip ?? '',
    user: userView(VIEWER),
    repo: repoView(repo),
  };
}

export function pullView(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${repo.dbId}:${pull.number}`, 'utf8').toString('base64'),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    locked: false,
    draft: false,
    user: userView(VIEWER),
    head: refSideView(repo, pull.headRef),
    base: refSideView(repo, pull.baseRef),
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    diff_url: `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
  };
}

function parseAuthorLine(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (!match) return { name: line, email: '', date: new Date(0).toISOString() };
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(Number(match[3]) * 1000).toISOString(),
  };
}

export function commitView(oid: string): Record<string, unknown> {
  const object = getObject(oid);
  const info = object && object.type === 'commit' ? parseCommit(object.data) : null;
  const author = parseAuthorLine(info?.author ?? '');
  const committer = parseAuthorLine(info?.committer ?? '');
  const userFor = (email: string): Record<string, unknown> | null => {
    const user = USERS.find((candidate) => candidate.email === email);
    return user ? userView(user) : null;
  };
  return {
    sha: oid,
    node_id: Buffer.from(`Commit:${oid}`, 'utf8').toString('base64'),
    commit: {
      author,
      committer,
      message: info ? info.message.replace(/\n$/, '') : '',
      tree: { sha: info?.tree ?? '', url: '' },
      comment_count: 0,
    },
    author: userFor(author.email),
    committer: userFor(committer.email),
    parents: (info?.parents ?? []).map((parent) => ({ sha: parent, url: '', html_url: '' })),
    html_url: '',
    url: '',
  };
}

function branchView(repo: RepoRec, name: string): Record<string, unknown> {
  return {
    name,
    commit: { sha: repo.refs.get(`refs/heads/${name}`) ?? '', url: '' },
    protected: false,
  };
}

function refView(ref: string, oid: string): Record<string, unknown> {
  const object = getObject(oid);
  return {
    ref,
    node_id: Buffer.from(`Ref:${ref}`, 'utf8').toString('base64'),
    url: '',
    object: { type: object?.type ?? 'commit', sha: oid, url: '' },
  };
}

// ------------------------------------------------------------------ helpers

interface Page {
  readonly perPage: number;
  readonly page: number;
}

function pageOf(url: URL): Page {
  const perPageRaw = Number(url.searchParams.get('per_page'));
  const pageRaw = Number(url.searchParams.get('page'));
  return {
    perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1,
  };
}

/** Slice `items` for the page and set the Link header (absolute, same-origin) when more pages follow. */
function paginate<T>(req: IncomingMessage, res: ServerResponse, url: URL, items: readonly T[]): T[] {
  const { perPage, page } = pageOf(url);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const host = req.headers.host ?? '127.0.0.1';
  const base = `http://${host}${url.pathname}`;
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const links: string[] = [];
  const withPage = (target: number): string => {
    const params = new URLSearchParams(url.searchParams);
    params.set('per_page', String(perPage));
    params.set('page', String(target));
    return `${base}?${params.toString()}`;
  };
  if (page < lastPage) {
    links.push(`<${withPage(page + 1)}>; rel="next"`);
    links.push(`<${withPage(lastPage)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${withPage(1)}>; rel="first"`);
    links.push(`<${withPage(page - 1)}>; rel="prev"`);
  }
  if (links.length > 0) res.setHeader('link', links.join(', '));
  return slice;
}

function parseBody(body: Buffer): Record<string, unknown> {
  if (body.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new ForgeError(400, 'Problems parsing JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ForgeError(400, 'Problems parsing JSON');
  }
  return parsed as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

// ------------------------------------------------------------------ contents helpers

/** Walk a tree to `path`; returns the blob entry, a directory's tree oid, or null. */
function treeAtPath(rootTreeOid: string, path: string): { kind: 'file'; mode: string; oid: string } | { kind: 'dir'; oid: string } | null {
  if (path === '') return { kind: 'dir', oid: rootTreeOid };
  const parts = path.split('/');
  let current = rootTreeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const object = getObject(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) {
      return entry.mode === '40000' ? { kind: 'dir', oid: entry.oid } : { kind: 'file', mode: entry.mode, oid: entry.oid };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

function contentLinks(repo: RepoRec, path: string): Record<string, unknown> {
  const url = `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`;
  return { self: url, git: '', html: `https://forge.invalid/${repo.owner}/${repo.name}/blob/main/${path}` };
}

// ------------------------------------------------------------------ the handler

export function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer): void {
  try {
    route(req, res, url, body);
  } catch (error) {
    sendError(res, error);
  }
}

function route(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer): void {
  const method = req.method ?? 'GET';
  const segments = url.pathname.split('/').filter((segment) => segment !== '').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  // segments[0] === 'api', segments[1] === 'v3' (guaranteed by app.ts).
  const rest = segments.slice(2);

  if (rest.length === 0) {
    if (method !== 'GET') throw notFound();
    res.setHeader('x-oauth-scopes', 'repo, read:org');
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      current_user_repositories_url: '/api/v3/user/repos',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
    });
    return;
  }
  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') throw notFound();
    sendJson(res, 200, { installed_version: '1.0.0', github_services_sha: 'github-core-clone' });
    return;
  }
  if (rest[0] === 'rate_limit' && rest.length === 1) {
    sendJson(res, 200, {
      resources: { core: { limit: 5000, remaining: 4999, reset: 1735689600, used: 1 } },
      rate: { limit: 5000, remaining: 4999, reset: 1735689600, used: 1 },
    });
    return;
  }

  if (!hasAuth(req)) throw new ForgeError(401, 'Requires authentication');

  if (rest[0] === 'user' && rest.length === 1) {
    if (method !== 'GET') throw notFound();
    sendJson(res, 200, userView(VIEWER));
    return;
  }
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      sendJson(res, 200, paginate(req, res, url, reposOf(VIEWER.login)).map(repoView));
      return;
    }
    if (method === 'POST') {
      const data = parseBody(body);
      const name = stringField(data, 'name');
      if (!name) throw new ForgeError(422, 'Repository creation failed: name is required');
      const repo = createRepo(VIEWER.login, name, data.private !== false, stringField(data, 'description') ?? '');
      sendJson(res, 201, repoView(repo));
      return;
    }
    throw notFound();
  }
  if (rest[0] === 'users' && rest.length === 3 && rest[2] === 'repos') {
    if (method !== 'GET') throw notFound();
    sendJson(res, 200, paginate(req, res, url, reposOf(rest[1] as string)).map(repoView));
    return;
  }

  if (rest[0] !== 'repos' || rest.length < 3) throw notFound();
  const owner = rest[1] as string;
  const repoName = rest[2] as string;
  const tail = rest.slice(3);
  const repo = requireRepo(owner, repoName);

  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoView(repo));
      return;
    }
    if (method === 'PATCH') {
      const data = parseBody(body);
      const description = stringField(data, 'description');
      if (description !== undefined) repo.description = description;
      if (typeof data.private === 'boolean') repo.isPrivate = data.private;
      repo.updatedAt = tickIso();
      sendJson(res, 200, repoView(repo));
      return;
    }
    if (method === 'DELETE') {
      deleteRepo(owner, repoName);
      res.writeHead(204, { 'content-type': JSON_TYPE });
      res.end();
      return;
    }
    throw notFound();
  }

  switch (tail[0]) {
    case 'branches':
      return branchesRoute(req, res, url, repo, tail.slice(1), method);
    case 'git':
      return gitDataRoute(req, res, url, repo, tail.slice(1), method, body);
    case 'commits':
      return commitsRoute(req, res, url, repo, tail.slice(1), method);
    case 'contents':
      return contentsRoute(req, res, url, repo, tail.slice(1).join('/'), method, body);
    case 'labels':
      return labelsRoute(req, res, repo, tail.slice(1), method, body);
    case 'issues':
      return issuesRoute(req, res, url, repo, tail.slice(1), method, body);
    case 'pulls':
      return pullsRoute(req, res, url, repo, tail.slice(1), method, body);
    default:
      throw notFound();
  }
}

function branchesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: RepoRec,
  tail: string[],
  method: string,
): void {
  void req;
  void url;
  if (method !== 'GET') throw notFound();
  if (tail.length === 0) {
    const names = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ref.slice('refs/heads/'.length))
      .sort();
    sendJson(res, 200, names.map((name) => branchView(repo, name)));
    return;
  }
  const name = tail.join('/');
  if (!repo.refs.has(`refs/heads/${name}`)) throw notFound('Branch not found');
  sendJson(res, 200, branchView(repo, name));
}

function gitDataRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: RepoRec,
  tail: string[],
  method: string,
  body: Buffer,
): void {
  void req;
  void url;
  if (tail[0] !== 'refs') throw notFound();
  if (tail.length === 1) {
    if (method === 'GET') {
      const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
      sendJson(res, 200, refs.map(([ref, oid]) => refView(ref, oid)));
      return;
    }
    if (method === 'POST') {
      const data = parseBody(body);
      const ref = stringField(data, 'ref');
      const sha = stringField(data, 'sha');
      if (!ref || !sha) throw new ForgeError(422, 'Validation Failed: ref and sha are required');
      if (!getObject(sha)) throw new ForgeError(422, 'Validation Failed: sha does not name an object');
      repo.refs.set(ref, sha);
      repo.updatedAt = tickIso();
      sendJson(res, 201, refView(ref, sha));
      return;
    }
    throw notFound();
  }
  if (method !== 'GET') throw notFound();
  const joined = tail.slice(1).join('/');
  const ref = joined.startsWith('refs/') ? joined : `refs/${joined}`;
  const oid = repo.refs.get(ref);
  if (!oid) throw notFound('Reference not found');
  sendJson(res, 200, refView(ref, oid));
}

function commitsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: RepoRec,
  tail: string[],
  method: string,
): void {
  void req;
  if (method !== 'GET') throw notFound();
  if (tail.length === 1) {
    const oid = tail[0] as string;
    if (!getObject(oid) || getObject(oid)?.type !== 'commit') throw notFound('Commit not found');
    sendJson(res, 200, commitView(oid));
    return;
  }
  if (tail.length !== 0) throw notFound();
  const ref = url.searchParams.get('sha') ?? repo.defaultBranch;
  const tip = resolveRef(repo, ref);
  if (!tip) {
    sendJson(res, 200, []);
    return;
  }
  const all = commitLog(tip);
  sendJson(res, 200, paginate(req, res, url, all).map(commitView));
}

function contentsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: RepoRec,
  path: string,
  method: string,
  body: Buffer,
): void {
  void req;
  if (method === 'GET') {
    const ref = url.searchParams.get('ref') ?? repo.defaultBranch;
    const commit = resolveRef(repo, ref);
    if (!commit) throw notFound();
    const commitObject = getObject(commit);
    if (!commitObject) throw notFound();
    const treeOid = (commitObject.data ? parseCommit(commitObject.data).tree : '') as string;
    const found = treeAtPath(treeOid, path);
    if (!found) throw notFound();
    if (found.kind === 'file') {
      const blob = getObject(found.oid);
      const data = blob?.data ?? Buffer.alloc(0);
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: path.split('/').pop() ?? path,
        path,
        sha: found.oid,
        content: data.toString('base64'),
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        html_url: `https://forge.invalid/${repo.owner}/${repo.name}/blob/${ref}/${path}`,
        git_url: '',
        _links: contentLinks(repo, path),
      });
      return;
    }
    const treeObject = getObject(found.oid);
    if (!treeObject || treeObject.type !== 'tree') throw notFound();
    const entries = parseTree(treeObject.data).map((entry) => {
      const isDir = entry.mode === '40000';
      const entryPath = path === '' ? entry.name : `${path}/${entry.name}`;
      const size = isDir ? 0 : (getObject(entry.oid)?.data.length ?? 0);
      return {
        type: isDir ? 'dir' : 'file',
        size,
        name: entry.name,
        path: entryPath,
        sha: entry.oid,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${entryPath}`,
        html_url: '',
        git_url: '',
        _links: contentLinks(repo, entryPath),
      };
    });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    sendJson(res, 200, entries);
    return;
  }

  if (method === 'PUT') {
    const data = parseBody(body);
    const message = stringField(data, 'message') ?? 'Update file';
    const content = stringField(data, 'content');
    if (content === undefined) throw new ForgeError(422, 'Validation Failed: content is required');
    const branch = stringField(data, 'branch') ?? repo.defaultBranch;
    const files = branchFiles(repo, branch);
    if (!repo.refs.has(`refs/heads/${branch}`) && branch !== repo.defaultBranch) {
      // A contents write names a branch that does not exist yet: start it from the default branch.
      for (const [filePath, entry] of branchFiles(repo, repo.defaultBranch)) files.set(filePath, entry);
    }
    const existing = files.get(path);
    const sha = stringField(data, 'sha');
    if (existing && sha !== undefined && sha !== existing.oid) {
      throw new ForgeError(409, `${path} has changed since ${sha}`);
    }
    const bytes = Buffer.from(content.replace(/\s+/g, ''), 'base64');
    const blobOid = storeObject('blob', bytes);
    files.set(path, { mode: '100644', oid: blobOid });
    const commitOid = commitOnBranch(repo, branch, files, message);
    sendJson(res, existing ? 200 : 201, {
      content: {
        type: 'file',
        encoding: 'base64',
        size: bytes.length,
        name: path.split('/').pop() ?? path,
        path,
        sha: blobOid,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        html_url: '',
        git_url: '',
        _links: contentLinks(repo, path),
      },
      commit: commitView(commitOid),
    });
    return;
  }

  if (method === 'DELETE') {
    const data = parseBody(body);
    const message = stringField(data, 'message') ?? 'Delete file';
    const branch = stringField(data, 'branch') ?? repo.defaultBranch;
    const files = branchFiles(repo, branch);
    const existing = files.get(path);
    if (!existing) throw notFound();
    const sha = stringField(data, 'sha');
    if (sha !== undefined && sha !== existing.oid) {
      throw new ForgeError(409, `${path} has changed since ${sha}`);
    }
    files.delete(path);
    const commitOid = commitOnBranch(repo, branch, files, message);
    sendJson(res, 200, { content: null, commit: commitView(commitOid) });
    return;
  }

  throw notFound();
}

function labelsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  repo: RepoRec,
  tail: string[],
  method: string,
  body: Buffer,
): void {
  void req;
  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map((label) => labelView(repo, label)));
      return;
    }
    if (method === 'POST') {
      const data = parseBody(body);
      const name = stringField(data, 'name');
      if (!name) throw new ForgeError(422, 'Validation Failed: name is required');
      const existing = repo.labels.get(name);
      if (existing) {
        sendJson(res, 201, labelView(repo, existing));
        return;
      }
      const label: LabelRec = {
        name,
        color: (stringField(data, 'color') ?? 'ededed').replace(/^#/, ''),
        description: stringField(data, 'description') ?? null,
      };
      repo.labels.set(name, label);
      sendJson(res, 201, labelView(repo, label));
      return;
    }
    throw notFound();
  }
  if (method !== 'GET') throw notFound();
  const label = repo.labels.get(tail.join('/'));
  if (!label) throw notFound('Label not found');
  sendJson(res, 200, labelView(repo, label));
}

function issuesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: RepoRec,
  tail: string[],
  method: string,
  body: Buffer,
): void {
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      sendJson(res, 200, paginate(req, res, url, list).map((issue) => issueView(repo, issue)));
      return;
    }
    if (method === 'POST') {
      const data = parseBody(body);
      const title = stringField(data, 'title');
      if (!title) throw new ForgeError(422, 'Validation Failed: title is required');
      const labels = Array.isArray(data.labels) ? data.labels.filter((label): label is string => typeof label === 'string') : [];
      const issue = createIssue(repo, { title, body: stringField(data, 'body') ?? '', labels });
      sendJson(res, 201, issueView(repo, issue));
      return;
    }
    throw notFound();
  }

  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number <= 0) throw notFound();
  const issue = repo.issues.get(number);
  if (!issue) throw notFound('Issue not found');

  if (tail.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, issueView(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const data = parseBody(body);
      const title = stringField(data, 'title');
      if (title !== undefined) issue.title = title;
      const issueBody = stringField(data, 'body');
      if (issueBody !== undefined) issue.body = issueBody;
      const state = stringField(data, 'state');
      if (state === 'closed' || state === 'open') {
        issue.state = state;
        issue.closedAt = state === 'closed' ? tickIso() : null;
      }
      if (Array.isArray(data.labels)) {
        const labels = data.labels.filter((label): label is string => typeof label === 'string');
        for (const label of labels) {
          if (!repo.labels.has(label)) throw new ForgeError(422, `Label '${label}' does not exist in this repository`);
        }
        issue.labels = labels;
      }
      issue.updatedAt = tickIso();
      sendJson(res, 200, issueView(repo, issue));
      return;
    }
    throw notFound();
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((comment) => commentView(repo, issue, comment)));
      return;
    }
    if (method === 'POST') {
      const data = parseBody(body);
      const commentBody = stringField(data, 'body');
      if (!commentBody) throw new ForgeError(422, 'Validation Failed: body is required');
      const comment = addComment(repo, issue, commentBody);
      sendJson(res, 201, commentView(repo, issue, comment));
      return;
    }
    throw notFound();
  }

  void req;
  throw notFound();
}

function pullsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: RepoRec,
  tail: string[],
  method: string,
  body: Buffer,
): void {
  void req;
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      sendJson(res, 200, paginate(req, res, url, list).map((pull) => pullView(repo, pull)));
      return;
    }
    if (method === 'POST') {
      const data = parseBody(body);
      const title = stringField(data, 'title');
      const head = stringField(data, 'head');
      const base = stringField(data, 'base');
      if (!title || !head || !base) throw new ForgeError(422, 'Validation Failed: title, head and base are required');
      const pull = createPull(repo, { title, body: stringField(data, 'body') ?? '', head, base });
      sendJson(res, 201, pullView(repo, pull));
      return;
    }
    throw notFound();
  }

  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number <= 0) throw notFound();
  const pull = repo.pulls.get(number);

  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (!pull) throw notFound('Pull request not found');
    parseBody(body);
    const sha = mergePull(repo, pull);
    sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }
  if (!pull) throw notFound('Pull request not found');
  if (tail.length === 1 && method === 'GET') {
    sendJson(res, 200, pullView(repo, pull));
    return;
  }
  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    const files = pullFiles(repo, pull).map((change) => ({
      sha: '',
      filename: change.filename,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.changes,
      blob_url: '',
      raw_url: '',
      contents_url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${change.filename}`,
    }));
    sendJson(res, 200, paginate(req, res, url, files));
    return;
  }
  throw notFound();
}

export { objects };
