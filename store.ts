// The forge's in-memory state and domain logic, shared by the REST, GraphQL, MCP and git surfaces
// so an object created through one surface is the same object through all of them. The trial mounts
// the repository read-only, so nothing here touches the filesystem; a fresh process is a fresh,
// empty forge, exactly as the suite expects.
//
// Determinism: timestamps come from a logical clock seeded at the scenario epoch and advanced by
// one second per event, never from the wall clock, so a replayed trial produces identical bodies.

import {
  buildCommitData,
  buildTreeData,
  hashObject,
  parseCommit,
  parseTagTarget,
  parseTree,
  type GitObject,
  type GitObjectType,
} from './gitobj.ts';
import { VIEWER, type ScenarioUser } from './scenario.ts';

const EPOCH_SEC = 1_735_689_600;
let clockSec = EPOCH_SEC;
let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

/** The next logical timestamp, ISO-8601. */
export function tickIso(): string {
  clockSec += 1;
  return new Date(clockSec * 1000).toISOString();
}

export function tickEpoch(): number {
  clockSec += 1;
  return clockSec;
}

export function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

// ------------------------------------------------------------------ errors

export class ForgeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const notFound = (what = 'Not Found'): ForgeError => new ForgeError(404, what);

// ------------------------------------------------------------------ git object store

export const objects = new Map<string, GitObject>();

export function storeObject(type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

export function getObject(oid: string): GitObject | undefined {
  return objects.get(oid);
}

/** Peel an object id to the commit it names (through annotated tags), or null. */
export function peelToCommit(oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTagTarget(object.data);
      continue;
    }
    return null;
  }
  return null;
}

export function commitTree(commitOid: string): string {
  const object = objects.get(commitOid);
  if (!object || object.type !== 'commit') return '';
  return parseCommit(object.data).tree;
}

/** Every commit reachable from `tip` (inclusive), breadth-first, newest first. */
export function commitLog(tip: string, limit = 100_000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0 && out.length < limit) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

export function isAncestor(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/** The best common ancestor of two commits (breadth-first from both sides), or null. */
export function mergeBase(a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsOfA = new Set(commitLog(a));
  if (ancestorsOfA.has(b)) return b;
  const queue: string[] = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const object = objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

// ------------------------------------------------------------------ trees as path maps

export interface FileEntry {
  readonly mode: string;
  readonly oid: string;
}

/** Flatten a tree (by oid) into a path -> blob map. An empty tree oid yields an empty map. */
export function flattenTree(treeOid: string): Map<string, FileEntry> {
  const out = new Map<string, FileEntry>();
  const walk = (oid: string, prefix: string): void => {
    const object = objects.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') walk(entry.oid, `${prefix}${entry.name}/`);
      else out.set(`${prefix}${entry.name}`, { mode: entry.mode, oid: entry.oid });
    }
  };
  if (treeOid) walk(treeOid, '');
  return out;
}

/** Build (and store) a tree hierarchy from a flat path map; returns the root tree oid. */
export function buildTreeFromMap(files: Map<string, FileEntry>): string {
  interface Node {
    files: Map<string, FileEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      if (!node.dirs.has(part)) node.dirs.set(part, { files: new Map(), dirs: new Map() });
      node = node.dirs.get(part) as Node;
    }
    node.files.set(parts[parts.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: { mode: string; name: string; oid: string }[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject('tree', buildTreeData(entries));
  };
  return build(root);
}

// ------------------------------------------------------------------ repositories

export interface LabelRec {
  readonly name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  readonly id: number;
  body: string;
  readonly createdAt: string;
  updatedAt: string;
}

export interface IssueRec {
  readonly number: number;
  readonly id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly comments: CommentRec[];
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface PullRec {
  readonly number: number;
  readonly id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface RepoRec {
  readonly dbId: number;
  readonly owner: string;
  readonly name: string;
  isPrivate: boolean;
  description: string;
  readonly defaultBranch: string;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, LabelRec>;
  readonly issues: Map<number, IssueRec>;
  readonly pulls: Map<number, PullRec>;
  nextNumber: number;
  readonly createdAt: string;
  updatedAt: string;
}

const reposByKey = new Map<string, RepoRec>();
const reposByDbId = new Map<number, RepoRec>();
let nextRepoDbId = 1;
let nextIssueId = 1;
let nextCommentId = 1;

export function createRepo(owner: string, name: string, isPrivate: boolean, description: string): RepoRec {
  const key = `${owner}/${name}`;
  if (reposByKey.has(key)) {
    throw new ForgeError(422, 'Repository creation failed: name already exists on this account');
  }
  const now = tickIso();
  const repo: RepoRec = {
    dbId: nextRepoDbId++,
    owner,
    name,
    isPrivate,
    description,
    defaultBranch: 'main',
    refs: new Map(),
    // No pre-seeded labels: the suite creates the labels it uses through POST /labels and
    // expects a 201 for names like 'bug', and an issue naming an uncreated label must 422.
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    createdAt: now,
    updatedAt: now,
  };
  reposByKey.set(key, repo);
  reposByDbId.set(repo.dbId, repo);
  return repo;
}

export function getRepo(owner: string, name: string): RepoRec | undefined {
  return reposByKey.get(`${owner}/${name}`);
}

export function requireRepo(owner: string, name: string): RepoRec {
  const repo = getRepo(owner, name);
  if (!repo) throw notFound('Repository not found');
  return repo;
}

export function deleteRepo(owner: string, name: string): boolean {
  const repo = getRepo(owner, name);
  if (!repo) return false;
  reposByKey.delete(`${owner}/${name}`);
  reposByDbId.delete(repo.dbId);
  return true;
}

export function reposOf(owner: string): RepoRec[] {
  return [...reposByKey.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.dbId - b.dbId);
}

export function repoByDbId(dbId: number): RepoRec | undefined {
  return reposByDbId.get(dbId);
}

// ------------------------------------------------------------------ identities

export function viewerUser(): ScenarioUser {
  return VIEWER;
}

export function authorLine(user: ScenarioUser, epochSec: number): string {
  return `${user.name} <${user.email}> ${epochSec} +0000`;
}

// ------------------------------------------------------------------ commits through the API

/** Create a commit on a branch from a full path map; returns the commit oid. */
export function commitOnBranch(repo: RepoRec, branch: string, files: Map<string, FileEntry>, message: string): string {
  const tree = buildTreeFromMap(files);
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref);
  const epoch = tickEpoch();
  const line = authorLine(VIEWER, epoch);
  const data = buildCommitData({
    tree,
    parents: parent ? [parent] : [],
    authorLine: line,
    committerLine: line,
    message,
  });
  const oid = storeObject('commit', data);
  repo.refs.set(ref, oid);
  repo.updatedAt = isoOf(epoch);
  return oid;
}

/** The flattened file map at a branch's tip (empty for an unborn branch). */
export function branchFiles(repo: RepoRec, branch: string): Map<string, FileEntry> {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) return new Map();
  const commit = peelToCommit(tip);
  if (!commit) return new Map();
  return flattenTree(commitTree(commit));
}

/** Resolve a ref name (branch, full ref, or commit sha) to a commit oid, or null. */
export function resolveRef(repo: RepoRec, ref: string): string | null {
  if (!ref) {
    const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    return tip ? peelToCommit(tip) : null;
  }
  const branchTip = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref);
  if (branchTip) return peelToCommit(branchTip);
  if (/^[0-9a-f]{40}$/.test(ref) && objects.has(ref)) return peelToCommit(ref);
  return null;
}

// ------------------------------------------------------------------ issues

export function createIssue(
  repo: RepoRec,
  input: { title: string; body?: string; labels?: readonly string[] },
): IssueRec {
  const labels = input.labels ?? [];
  for (const label of labels) {
    if (!repo.labels.has(label)) throw new ForgeError(422, `Label '${label}' does not exist in this repository`);
  }
  const now = tickIso();
  const issue: IssueRec = {
    number: repo.nextNumber++,
    id: nextIssueId++,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [...labels],
    comments: [],
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

export function addComment(repo: RepoRec, issue: IssueRec, body: string): CommentRec {
  const now = tickIso();
  const comment: CommentRec = { id: nextCommentId++, body, createdAt: now, updatedAt: now };
  issue.comments.push(comment);
  issue.updatedAt = now;
  void repo;
  return comment;
}

// ------------------------------------------------------------------ pull requests

export interface FileChange {
  readonly filename: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** A simple LCS-based line diff count (files in this forge are small). */
function diffCounts(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const a = oldData.toString('utf8').split('\n');
  const b = newData.toString('utf8').split('\n');
  const m = a.length;
  const n = b.length;
  if (m * n > 4_000_000) {
    return { additions: lineCount(newData), deletions: lineCount(oldData) };
  }
  const dp: number[] = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i += 1) {
    let prev = 0;
    for (let j = 1; j <= n; j += 1) {
      const tmp = dp[j] as number;
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j] as number, dp[j - 1] as number);
      prev = tmp;
    }
  }
  const common = dp[n] as number;
  return { additions: Math.max(0, n - common), deletions: Math.max(0, m - common) };
}

/** The file changes between two commits' trees (merge-base of the pair when one is given). */
export function diffFiles(fromCommit: string | null, toCommit: string | null): FileChange[] {
  const from = fromCommit ? flattenTree(commitTree(fromCommit)) : new Map<string, FileEntry>();
  const to = toCommit ? flattenTree(commitTree(toCommit)) : new Map<string, FileEntry>();
  const changes: FileChange[] = [];
  const paths = new Set([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = from.get(path);
    const newEntry = to.get(path);
    if (oldEntry && !newEntry) {
      const deletions = lineCount(objects.get(oldEntry.oid)?.data ?? Buffer.alloc(0));
      changes.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (!oldEntry && newEntry) {
      const additions = lineCount(objects.get(newEntry.oid)?.data ?? Buffer.alloc(0));
      changes.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (oldEntry && newEntry && oldEntry.oid !== newEntry.oid) {
      const counts = diffCounts(
        objects.get(oldEntry.oid)?.data ?? Buffer.alloc(0),
        objects.get(newEntry.oid)?.data ?? Buffer.alloc(0),
      );
      changes.push({
        filename: path,
        status: 'modified',
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
      });
    }
  }
  return changes;
}

/** The commits a pull request compares: merge-base and head tip. */
export function pullTips(repo: RepoRec, pull: PullRec): { baseTip: string | null; headTip: string | null; base: string | null } {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? null;
  const baseCommit = baseTip ? peelToCommit(baseTip) : null;
  const headCommit = headTip ? peelToCommit(headTip) : null;
  const base = baseCommit && headCommit ? mergeBase(baseCommit, headCommit) : null;
  return { baseTip: baseCommit, headTip: headCommit, base };
}

export function pullFiles(repo: RepoRec, pull: PullRec): FileChange[] {
  const { baseTip, headTip, base } = pullTips(repo, pull);
  return diffFiles(base ?? baseTip, headTip);
}

/** True when the pull request cannot be merged cleanly (both sides changed a file differently). */
export function pullConflicts(repo: RepoRec, pull: PullRec): boolean {
  const { baseTip, headTip, base } = pullTips(repo, pull);
  if (!baseTip || !headTip || !base) return false;
  if (base === headTip) return false;
  const baseFiles = flattenTree(commitTree(base));
  const ourFiles = flattenTree(commitTree(baseTip));
  const theirFiles = flattenTree(commitTree(headTip));
  const paths = new Set([...baseFiles.keys(), ...ourFiles.keys(), ...theirFiles.keys()]);
  for (const path of paths) {
    const atBase = baseFiles.get(path)?.oid;
    const atOurs = ourFiles.get(path)?.oid;
    const atTheirs = theirFiles.get(path)?.oid;
    const oursChanged = atOurs !== atBase;
    const theirsChanged = atTheirs !== atBase;
    if (oursChanged && theirsChanged && atOurs !== atTheirs) return true;
  }
  return false;
}

export function createPull(
  repo: RepoRec,
  input: { title: string; body?: string; head: string; base: string },
): PullRec {
  const headTip = repo.refs.get(`refs/heads/${input.head}`);
  const baseTip = repo.refs.get(`refs/heads/${input.base}`);
  if (!headTip) throw new ForgeError(422, `Head branch '${input.head}' does not exist`);
  if (!baseTip) throw new ForgeError(422, `Base branch '${input.base}' does not exist`);
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === input.head && existing.baseRef === input.base) {
      throw new ForgeError(422, `A pull request already exists for ${input.head} into ${input.base}`);
    }
  }
  const now = tickIso();
  const pull: PullRec = {
    number: repo.nextNumber++,
    id: nextIssueId++,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: input.head,
    baseRef: input.base,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** Squash-merge a pull request onto its base branch; returns the merge commit oid. */
export function mergePull(repo: RepoRec, pull: PullRec): string {
  if (pull.merged) throw new ForgeError(405, 'Pull request has already been merged');
  if (pull.state !== 'open') throw new ForgeError(405, 'Pull request is not open');
  const { baseTip, headTip, base } = pullTips(repo, pull);
  if (!baseTip || !headTip) throw new ForgeError(405, 'Pull request branches are missing');
  if (pullConflicts(repo, pull)) throw new ForgeError(405, 'Pull request has conflicts and cannot be merged');
  const baseFiles = base ? flattenTree(commitTree(base)) : new Map<string, FileEntry>();
  const mergedFiles = flattenTree(commitTree(baseTip));
  const headFiles = flattenTree(commitTree(headTip));
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const atBase = baseFiles.get(path);
    const atHead = headFiles.get(path);
    if (atHead && atHead.oid !== atBase?.oid) mergedFiles.set(path, atHead);
    else if (!atHead && atBase) mergedFiles.delete(path);
  }
  const tree = buildTreeFromMap(mergedFiles);
  const epoch = tickEpoch();
  const line = authorLine(VIEWER, epoch);
  const data = buildCommitData({
    tree,
    parents: [baseTip],
    authorLine: line,
    committerLine: line,
    message: `${pull.title} (#${pull.number})`,
  });
  const oid = storeObject('commit', data);
  repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
  const now = isoOf(epoch);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = now;
  pull.mergeCommitSha = oid;
  pull.closedAt = now;
  pull.updatedAt = now;
  repo.updatedAt = now;
  return oid;
}

// ------------------------------------------------------------------ global (Relay) ids

export function globalId(kind: string, parts: readonly (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function repoGlobalId(repo: RepoRec): string {
  return globalId('Repository', [repo.dbId]);
}

export function issueGlobalId(repo: RepoRec, issue: IssueRec): string {
  return globalId('Issue', [repo.dbId, issue.number]);
}

export function pullGlobalId(repo: RepoRec, pull: PullRec): string {
  return globalId('PullRequest', [repo.dbId, pull.number]);
}

export function commentGlobalId(repo: RepoRec, issue: IssueRec, comment: CommentRec): string {
  return globalId('IssueComment', [repo.dbId, issue.number, comment.id]);
}

export function userGlobalId(user: ScenarioUser): string {
  return globalId('User', [user.login]);
}

/** Decode a global id into its kind and parts, or null when it is not one of ours. */
export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), parts: text.slice(colon + 1).split(':') };
  } catch {
    return null;
  }
}
