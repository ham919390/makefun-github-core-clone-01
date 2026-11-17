// The GraphQL v4 surface: a small parser (operations, variables, inline enum lists and input
// objects, aliases, inline fragments, batched operation arrays) and an executor over the fixed
// schema the suite exercises — viewer, repository, node, __type, issues/pulls connections and
// the create/close/merge/comment mutations, all reading the same store as REST.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ForgeError,
  addComment,
  commentGlobalId,
  createIssue,
  createPull,
  issueGlobalId,
  mergePull,
  parseGlobalId,
  pullConflicts,
  pullFiles,
  pullGlobalId,
  repoByDbId,
  repoGlobalId,
  getRepo,
  tickIso,
  userGlobalId,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { sendJson } from './rest.ts';
import { USERS, VIEWER, type ScenarioUser } from './scenario.ts';

// ------------------------------------------------------------------ tokenizer / parser

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'ellipsis' }
  | { kind: 'eof' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push({ kind: 'ellipsis' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: input.slice(i + 3, end < 0 ? input.length : end) });
        i = end < 0 ? input.length : end + 3;
        continue;
      }
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\') {
          const esc = input[i + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
        } else {
          value += input[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+/.exec(input.slice(i));
      tokens.push({ kind: 'int', value: Number(match?.[0] ?? '0') });
      i += (match?.[0] ?? '0').length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(input.slice(i));
      tokens.push({ kind: 'name', value: match?.[0] ?? '' });
      i += (match?.[0] ?? '').length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  readonly name: string;
  readonly alias: string | null;
  readonly args: Map<string, Value>;
  readonly selections: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface Operation {
  readonly type: 'query' | 'mutation';
  readonly name: string | null;
  readonly varDefaults: Map<string, Value>;
  readonly selections: SelectionNode[];
}

class Parser {
  readonly #tokens: Token[];
  #pos = 0;
  readonly fragments = new Map<string, SelectionNode[]>();

  constructor(input: string) {
    this.#tokens = tokenize(input);
  }

  #peek(): Token {
    return this.#tokens[this.#pos] as Token;
  }

  #next(): Token {
    return this.#tokens[this.#pos++] as Token;
  }

  #expectPunct(value: string): void {
    const token = this.#next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected '${value}' in GraphQL document`);
  }

  #skipPunct(value: string): boolean {
    const token = this.#peek();
    if (token.kind === 'punct' && token.value === value) {
      this.#pos += 1;
      return true;
    }
    return false;
  }

  #expectName(): string {
    const token = this.#next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.#peek().kind !== 'eof') {
      const token = this.#peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, varDefaults: new Map(), selections: this.#parseSelectionSet() });
        continue;
      }
      const keyword = this.#expectName();
      if (keyword === 'query' || keyword === 'mutation') {
        let name: string | null = null;
        if (this.#peek().kind === 'name') name = this.#expectName();
        const varDefaults = new Map<string, Value>();
        if (this.#skipPunct('(')) {
          while (!this.#skipPunct(')')) {
            this.#expectPunct('$');
            const varName = this.#expectName();
            this.#expectPunct(':');
            this.#skipType();
            if (this.#skipPunct('=')) varDefaults.set(varName, this.#parseValue());
            this.#skipDirectives();
          }
        }
        this.#skipDirectives();
        operations.push({ type: keyword, name, varDefaults, selections: this.#parseSelectionSet() });
      } else if (keyword === 'fragment') {
        const fragName = this.#expectName();
        const onKeyword = this.#expectName();
        if (onKeyword !== 'on') throw new Error('expected `on` in fragment definition');
        this.#expectName();
        this.#skipDirectives();
        this.fragments.set(fragName, this.#parseSelectionSet());
      } else {
        throw new Error(`unexpected keyword ${keyword} in GraphQL document`);
      }
    }
    return operations;
  }

  #skipType(): void {
    const token = this.#peek();
    if (token.kind === 'punct' && token.value === '[') {
      this.#pos += 1;
      this.#skipType();
      this.#expectPunct(']');
    } else {
      this.#expectName();
    }
    this.#skipPunct('!');
  }

  #skipDirectives(): void {
    while (this.#skipPunct('@')) {
      this.#expectName();
      if (this.#skipPunct('(')) {
        let depth = 1;
        while (depth > 0) {
          const token = this.#next();
          if (token.kind === 'eof') throw new Error('unterminated directive');
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          if (token.kind === 'punct' && token.value === ')') depth -= 1;
        }
      }
    }
  }

  #parseSelectionSet(): SelectionNode[] {
    this.#expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.#skipPunct('}')) {
      if (this.#peek().kind === 'ellipsis') {
        this.#pos += 1;
        const next = this.#peek();
        if (next.kind === 'name' && next.value === 'on') {
          this.#pos += 1;
          const typeCondition = this.#expectName();
          this.#skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selections: this.#parseSelectionSet() });
        } else if (next.kind === 'name') {
          selections.push({ kind: 'fragmentSpread', name: this.#expectName() });
          this.#skipDirectives();
        } else {
          selections.push({ kind: 'inlineFragment', typeCondition: null, selections: this.#parseSelectionSet() });
        }
        continue;
      }
      selections.push({ kind: 'field', field: this.#parseField() });
    }
    return selections;
  }

  #parseField(): FieldNode {
    let name = this.#expectName();
    let alias: string | null = null;
    if (this.#skipPunct(':')) {
      alias = name;
      name = this.#expectName();
    }
    const args = new Map<string, Value>();
    if (this.#skipPunct('(')) {
      while (!this.#skipPunct(')')) {
        const argName = this.#expectName();
        this.#expectPunct(':');
        args.set(argName, this.#parseValue());
      }
    }
    this.#skipDirectives();
    let selections: SelectionNode[] = [];
    const token = this.#peek();
    if (token.kind === 'punct' && token.value === '{') selections = this.#parseSelectionSet();
    return { name, alias, args, selections };
  }

  #parseValue(): Value {
    const token = this.#next();
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '$') return { kind: 'var', name: this.#expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!this.#skipPunct(']')) items.push(this.#parseValue());
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, Value>();
      while (!this.#skipPunct('}')) {
        const key = this.#expectName();
        this.#expectPunct(':');
        fields.set(key, this.#parseValue());
      }
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'int':
    case 'string':
    case 'bool':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of value.fields) out[key] = resolveValue(inner, variables);
      return out;
    }
  }
}

// ------------------------------------------------------------------ schema surface

const TYPE_DEFS: Record<string, { kind: string; fields?: readonly string[]; enumValues?: readonly string[] }> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'author', 'comments', 'labels', 'repository', 'createdAt', 'updatedAt', 'closedAt', 'url'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files',
      'author', 'repository', 'createdAt', 'updatedAt', 'closedAt', 'mergeCommit', 'additions', 'deletions', 'changedFiles', 'url',
    ],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'description', 'isPrivate', 'owner', 'defaultBranchRef',
      'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'url',
    ],
  },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email', 'url'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
};

// ------------------------------------------------------------------ execution

interface GqlObject {
  readonly __type: string;
  readonly [key: string]: unknown;
}

interface ExecContext {
  readonly variables: Record<string, unknown>;
  readonly fragments: Map<string, SelectionNode[]>;
  readonly errors: { message: string }[];
}

function userObject(user: ScenarioUser): GqlObject {
  return { __type: 'User', user };
}

function repoObject(repo: RepoRec): GqlObject {
  return { __type: 'Repository', repo };
}

function issueObject(repo: RepoRec, issue: IssueRec): GqlObject {
  return { __type: 'Issue', repo, issue };
}

function pullObject(repo: RepoRec, pull: PullRec): GqlObject {
  return { __type: 'PullRequest', repo, pull };
}

function connectionObject(type: string, nodes: GqlObject[], hasNextPage: boolean, endCursor: string | null): GqlObject {
  return {
    __type: type,
    nodes,
    pageInfo: { __type: 'PageInfo', hasNextPage, endCursor } as GqlObject,
  };
}

function encodeCursor(offset: number): string {
  return Buffer.from(`cursor:${offset}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return 0;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

function nodeById(id: string): GqlObject | null {
  const parsed = parseGlobalId(id);
  if (!parsed) return null;
  if (parsed.kind === 'Repository') {
    const repo = repoByDbId(Number(parsed.parts[0]));
    return repo ? repoObject(repo) : null;
  }
  if (parsed.kind === 'Issue' || parsed.kind === 'PullRequest') {
    const repo = repoByDbId(Number(parsed.parts[0]));
    if (!repo) return null;
    const number = Number(parsed.parts[1]);
    if (parsed.kind === 'Issue') {
      const issue = repo.issues.get(number);
      return issue ? issueObject(repo, issue) : null;
    }
    const pull = repo.pulls.get(number);
    return pull ? pullObject(repo, pull) : null;
  }
  if (parsed.kind === 'User') {
    const user = USERS.find((candidate) => candidate.login === parsed.parts[0]);
    return user ? userObject(user) : null;
  }
  if (parsed.kind === 'IssueComment') {
    const repo = repoByDbId(Number(parsed.parts[0]));
    const issue = repo?.issues.get(Number(parsed.parts[1]));
    const comment = issue?.comments.find((candidate) => candidate.id === Number(parsed.parts[2]));
    if (!repo || !issue || !comment) return null;
    return { __type: 'IssueComment', repo, issue, comment };
  }
  return null;
}

type Resolver = (object: GqlObject, args: Record<string, unknown>, ctx: ExecContext) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userObject(VIEWER),
    repository: (_object, args) => {
      const repo = getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? repoObject(repo) : null;
    },
    node: (_object, args) => nodeById(String(args.id ?? '')),
    __type: (_object, args) => {
      const name = String(args.name ?? '');
      return TYPE_DEFS[name] ? ({ __type: '__Type', name } as GqlObject) : null;
    },
    __typename: () => 'Query',
  },
  Mutation: {
    createIssue: (_object, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed && parsed.kind === 'Repository' ? repoByDbId(Number(parsed.parts[0])) : undefined;
      if (!repo) throw new Error('repository not found for createIssue');
      const issue = createIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
      return { __type: 'CreateIssuePayload', issue: issueObject(repo, issue) } as GqlObject;
    },
    closeIssue: (_object, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.issueId ?? ''));
      const repo = parsed ? repoByDbId(Number(parsed.parts[0])) : undefined;
      const issue = repo?.issues.get(Number(parsed?.parts[1]));
      if (!repo || !issue) throw new Error('issue not found for closeIssue');
      issue.state = 'closed';
      issue.closedAt = tickIso();
      issue.updatedAt = issue.closedAt;
      return { __type: 'CloseIssuePayload', issue: issueObject(repo, issue) } as GqlObject;
    },
    createPullRequest: (_object, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed && parsed.kind === 'Repository' ? repoByDbId(Number(parsed.parts[0])) : undefined;
      if (!repo) throw new Error('repository not found for createPullRequest');
      const pull = createPull(repo, {
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      return { __type: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull) } as GqlObject;
    },
    mergePullRequest: (_object, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
      const repo = parsed ? repoByDbId(Number(parsed.parts[0])) : undefined;
      const pull = repo?.pulls.get(Number(parsed?.parts[1]));
      if (!repo || !pull) throw new Error('pull request not found for mergePullRequest');
      mergePull(repo, pull);
      return { __type: 'MergePullRequestPayload', pullRequest: pullObject(repo, pull) } as GqlObject;
    },
    addComment: (_object, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.subjectId ?? ''));
      const repo = parsed ? repoByDbId(Number(parsed.parts[0])) : undefined;
      const issue = repo?.issues.get(Number(parsed?.parts[1]));
      if (!repo || !issue || parsed?.kind !== 'Issue') throw new Error('subject not found for addComment');
      const comment = addComment(repo, issue, String(input.body ?? ''));
      const node: GqlObject = { __type: 'IssueComment', repo, issue, comment };
      return { __type: 'AddCommentPayload', commentEdge: { __type: 'CommentEdge', node } as GqlObject } as GqlObject;
    },
  },
  User: {
    login: (object) => (object.user as ScenarioUser).login,
    id: (object) => userGlobalId(object.user as ScenarioUser),
    name: (object) => (object.user as ScenarioUser).name,
    email: (object) => (object.user as ScenarioUser).email,
  },
  Repository: {
    id: (object) => repoGlobalId(object.repo as RepoRec),
    databaseId: (object) => (object.repo as RepoRec).dbId,
    name: (object) => (object.repo as RepoRec).name,
    nameWithOwner: (object) => {
      const repo = object.repo as RepoRec;
      return `${repo.owner}/${repo.name}`;
    },
    description: (object) => (object.repo as RepoRec).description,
    isPrivate: (object) => (object.repo as RepoRec).isPrivate,
    owner: (object) => {
      const repo = object.repo as RepoRec;
      const user = USERS.find((candidate) => candidate.login === repo.owner) ?? VIEWER;
      return userObject(user);
    },
    defaultBranchRef: (object) => {
      const repo = object.repo as RepoRec;
      if (!repo.refs.has(`refs/heads/${repo.defaultBranch}`)) return null;
      return { __type: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/' } as GqlObject;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    createdAt: (object) => (object.repo as RepoRec).createdAt,
    updatedAt: (object) => (object.repo as RepoRec).updatedAt,
    issue: (object, args) => {
      const repo = object.repo as RepoRec;
      const issue = repo.issues.get(Number(args.number));
      return issue ? issueObject(repo, issue) : null;
    },
    issues: (object, args) => {
      const repo = object.repo as RepoRec;
      let list = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states) {
        const wanted = new Set(states.map((state) => state.toLowerCase()));
        list = list.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
      const descending = orderBy?.direction === 'DESC';
      list.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
      const total = list.length;
      const start = decodeCursor(args.after);
      const first = typeof args.first === 'number' ? args.first : total;
      const page = list.slice(start, start + first);
      const hasNextPage = start + page.length < total;
      return connectionObject(
        'IssueConnection',
        page.map((issue) => issueObject(repo, issue)),
        hasNextPage,
        encodeCursor(start + page.length),
      );
    },
    pullRequest: (object, args) => {
      const repo = object.repo as RepoRec;
      const pull = repo.pulls.get(Number(args.number));
      return pull ? pullObject(repo, pull) : null;
    },
    pullRequests: (object, args) => {
      const repo = object.repo as RepoRec;
      const list = [...repo.pulls.values()].filter((pull) => pull.state === 'open');
      list.sort((a, b) => a.number - b.number);
      const first = typeof args.first === 'number' ? args.first : list.length;
      const page = list.slice(0, first);
      return connectionObject(
        'PullRequestConnection',
        page.map((pull) => pullObject(repo, pull)),
        page.length < list.length,
        encodeCursor(page.length),
      );
    },
  },
  Ref: {
    name: (object) => object.name,
    prefix: (object) => object.prefix,
  },
  Issue: {
    id: (object) => issueGlobalId(object.repo as RepoRec, object.issue as IssueRec),
    number: (object) => (object.issue as IssueRec).number,
    title: (object) => (object.issue as IssueRec).title,
    state: (object) => (object.issue as IssueRec).state.toUpperCase(),
    body: (object) => (object.issue as IssueRec).body,
  },
  PullRequest: {
    id: (object) => pullGlobalId(object.repo as RepoRec, object.pull as PullRec),
    number: (object) => (object.pull as PullRec).number,
    title: (object) => (object.pull as PullRec).title,
    body: (object) => (object.pull as PullRec).body,
    state: (object) => {
      const pull = object.pull as PullRec;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (object) => (object.pull as PullRec).merged,
    mergeable: (object) => {
      const repo = object.repo as RepoRec;
      const pull = object.pull as PullRec;
      if (pull.state !== 'open') return 'UNKNOWN';
      return pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    },
    headRefName: (object) => (object.pull as PullRec).headRef,
    baseRefName: (object) => (object.pull as PullRec).baseRef,
    files: (object, args) => {
      const repo = object.repo as RepoRec;
      const pull = object.pull as PullRec;
      const changes = pullFiles(repo, pull);
      const first = typeof args.first === 'number' ? args.first : changes.length;
      const page = changes.slice(0, first);
      return connectionObject(
        'PullRequestChangedFileConnection',
        page.map((change) => ({ __type: 'PullRequestChangedFile', path: change.filename }) as GqlObject),
        page.length < changes.length,
        encodeCursor(page.length),
      );
    },
  },
  PullRequestChangedFile: {
    path: (object) => object.path,
  },
  IssueConnection: {
    nodes: (object) => object.nodes,
    pageInfo: (object) => object.pageInfo,
  },
  PullRequestConnection: {
    nodes: (object) => object.nodes,
    pageInfo: (object) => object.pageInfo,
  },
  PullRequestChangedFileConnection: {
    nodes: (object) => object.nodes,
    pageInfo: (object) => object.pageInfo,
  },
  PageInfo: {
    hasNextPage: (object) => object.hasNextPage,
    endCursor: (object) => object.endCursor,
  },
  CreateIssuePayload: {
    issue: (object) => object.issue,
  },
  CloseIssuePayload: {
    issue: (object) => object.issue,
  },
  CreatePullRequestPayload: {
    pullRequest: (object) => object.pullRequest,
  },
  MergePullRequestPayload: {
    pullRequest: (object) => object.pullRequest,
  },
  AddCommentPayload: {
    commentEdge: (object) => object.commentEdge,
  },
  CommentEdge: {
    node: (object) => object.node,
  },
  IssueComment: {
    id: (object) => commentGlobalId(object.repo as RepoRec, object.issue as IssueRec, object.comment as { id: number }),
    body: (object) => (object.comment as { body: string }).body,
  },
  __Type: {
    name: (object) => object.name,
    kind: (object) => TYPE_DEFS[object.name as string]?.kind ?? 'OBJECT',
    fields: (object) => {
      const def = TYPE_DEFS[object.name as string];
      return (def?.fields ?? []).map((name) => ({ __type: '__Field', name }) as GqlObject);
    },
    enumValues: (object) => {
      const def = TYPE_DEFS[object.name as string];
      return (def?.enumValues ?? []).map((name) => ({ __type: '__EnumValue', name }) as GqlObject);
    },
  },
  __Field: {
    name: (object) => object.name,
  },
  __EnumValue: {
    name: (object) => object.name,
  },
};

const NODE_TYPES = new Set(['Repository', 'Issue', 'PullRequest', 'User', 'IssueComment']);

function executeSelectionSet(
  type: string,
  object: GqlObject | null,
  selections: readonly SelectionNode[],
  ctx: ExecContext,
): Record<string, unknown> | null {
  if (object === null) return null;
  const out: Record<string, unknown> = {};
  const applySelections = (currentType: string, current: GqlObject, sels: readonly SelectionNode[]): void => {
    for (const selection of sels) {
      if (selection.kind === 'inlineFragment') {
        const condition = selection.typeCondition;
        if (condition === null || condition === currentType || (condition === 'Node' && NODE_TYPES.has(currentType))) {
          applySelections(currentType, current, selection.selections);
        }
        continue;
      }
      if (selection.kind === 'fragmentSpread') {
        const fragment = ctx.fragments.get(selection.name);
        if (fragment) applySelections(currentType, current, fragment);
        continue;
      }
      const field = selection.field;
      const key = field.alias ?? field.name;
      if (field.name === '__typename') {
        out[key] = currentType;
        continue;
      }
      const resolver = RESOLVERS[currentType]?.[field.name];
      if (!resolver) {
        ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${currentType}'` });
        out[key] = null;
        continue;
      }
      const args: Record<string, unknown> = {};
      for (const [argName, argValue] of field.args) args[argName] = resolveValue(argValue, ctx.variables);
      let value: unknown;
      try {
        value = resolver(current, args, ctx);
      } catch (error) {
        ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
        out[key] = null;
        continue;
      }
      out[key] = completeValue(value, field.selections, ctx);
    }
  };
  applySelections(type, object, selections);
  return out;
}

function completeValue(value: unknown, selections: readonly SelectionNode[], ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, selections, ctx));
  if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
    const object = value as GqlObject;
    if (selections.length === 0) return object;
    return executeSelectionSet(object.__type, object, selections, ctx);
  }
  return value;
}

function executeOperation(operation: Operation, fragments: Map<string, SelectionNode[]>, variables: Record<string, unknown>): Record<string, unknown> {
  const mergedVariables: Record<string, unknown> = {};
  const ctx: ExecContext = { variables: mergedVariables, fragments, errors: [] };
  for (const [name, value] of operation.varDefaults) mergedVariables[name] = resolveValue(value, {});
  Object.assign(mergedVariables, variables);
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlObject = { __type: rootType };
  const data = executeSelectionSet(rootType, root, operation.selections, ctx);
  const response: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) response.errors = ctx.errors;
  return response;
}

// ------------------------------------------------------------------ HTTP entry

export function handleGraphQL(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string' || auth.trim() === '') {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (typeof entry !== 'object' || entry === null) return { errors: [{ message: 'Invalid GraphQL request' }] };
    const { query, variables, operationName } = entry as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (typeof query !== 'string') return { errors: [{ message: 'Missing query' }] };
    try {
      const parser = new Parser(query);
      const operations = parser.parseDocument();
      const chosen =
        typeof operationName === 'string'
          ? (operations.find((operation) => operation.name === operationName) ?? operations[0])
          : operations[0];
      if (!chosen) return { errors: [{ message: 'No operation in document' }] };
      const vars = typeof variables === 'object' && variables !== null ? (variables as Record<string, unknown>) : {};
      return executeOperation(chosen, parser.fragments, vars);
    } catch (error) {
      return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
    }
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed));
}
