// The MCP endpoint (POST /mcp): JSON-RPC 2.0 over Streamable HTTP. Speaks the modern revision
// (server/discover, no handshake) and the legacy initialize handshake. The six tools act on the
// same store as the REST surface, with github-mcp-server's tool and argument names.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ForgeError,
  createIssue,
  createPull,
  createRepo,
  getRepo,
  mergePull,
  type RepoRec,
} from './store.ts';
import { issueView, pullView, repoView, sendJson } from './rest.ts';
import { VIEWER } from './scenario.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

function objectSchema(properties: Record<string, unknown>, required: readonly string[]): Record<string, unknown> {
  return { type: 'object', properties, required: [...required], additionalProperties: false };
}

const stringProp = (description: string): Record<string, unknown> => ({ type: 'string', description });

export const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: objectSchema(
      {
        name: stringProp('The name of the repository to create.'),
        description: stringProp('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      ['name'],
    ),
  },
  {
    name: 'get_repo',
    description: 'Get the details of a repository by owner and name.',
    inputSchema: objectSchema(
      {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
      },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: objectSchema(
      {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        title: stringProp('The title of the issue.'),
        body: stringProp('The body of the issue.'),
      },
      ['owner', 'repo', 'title'],
    ),
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: objectSchema(
      {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        state: stringProp('Filter by state: open, closed or all.'),
      },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: objectSchema(
      {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        title: stringProp('The title of the pull request.'),
        body: stringProp('The body of the pull request.'),
        head: stringProp('The head branch to merge from.'),
        base: stringProp('The base branch to merge into.'),
      },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash merge).',
    inputSchema: objectSchema(
      {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        pull_number: { type: 'integer', description: 'The number of the pull request to merge.' },
      },
      ['owner', 'repo', 'pull_number'],
    ),
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

function toolResult(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function requireArgs(tool: ToolDef, args: Record<string, unknown>): string | null {
  const required = (tool.inputSchema.required as string[] | undefined) ?? [];
  for (const name of required) {
    if (args[name] === undefined || args[name] === null || args[name] === '') return name;
  }
  return null;
}

function repoFor(args: Record<string, unknown>): RepoRec {
  const repo = getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
  if (!repo) throw new ForgeError(404, `repository ${String(args.owner)}/${String(args.repo)} not found`);
  return repo;
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) {
    throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 });
  }
  const missing = requireArgs(tool, args);
  if (missing) {
    throw Object.assign(new Error(`Missing required argument: ${missing}`), { rpcCode: -32602 });
  }
  try {
    switch (name) {
      case 'create_repo': {
        const repo = createRepo(
          VIEWER.login,
          String(args.name),
          args.private !== false,
          typeof args.description === 'string' ? args.description : '',
        );
        return toolResult(repoView(repo));
      }
      case 'get_repo': {
        return toolResult(repoView(repoFor(args)));
      }
      case 'create_issue': {
        const repo = repoFor(args);
        const issue = createIssue(repo, {
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
        });
        return toolResult(issueView(repo, issue));
      }
      case 'list_issues': {
        const repo = repoFor(args);
        const state = typeof args.state === 'string' ? args.state : 'open';
        let list = [...repo.issues.values()];
        if (state === 'open') list = list.filter((issue) => issue.state === 'open');
        else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
        list.sort((a, b) => a.number - b.number);
        return toolResult({ issues: list.map((issue) => issueView(repo, issue)) });
      }
      case 'create_pull_request': {
        const repo = repoFor(args);
        const pull = createPull(repo, {
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
          head: String(args.head),
          base: String(args.base),
        });
        return toolResult(pullView(repo, pull));
      }
      case 'merge_pull_request': {
        const repo = repoFor(args);
        const pull = repo.pulls.get(Number(args.pull_number));
        if (!pull) return toolError(`pull request #${String(args.pull_number)} not found`);
        mergePull(repo, pull);
        return toolResult(pullView(repo, pull));
      }
      default:
        return toolError(`unhandled tool ${name}`);
    }
  } catch (error) {
    if (error instanceof ForgeError) return toolError(error.message);
    throw error;
  }
}

// ------------------------------------------------------------------ JSON-RPC plumbing

interface RpcOutcome {
  readonly status: number;
  readonly body?: Record<string, unknown>;
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function handleRpc(message: Record<string, unknown>): RpcOutcome {
  const method = typeof message.method === 'string' ? message.method : '';
  const id = message.id;
  const isNotification = id === undefined;
  const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>;

  if (isNotification) return { status: 202 };

  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        body: rpcResult(id, {
          resultType: 'complete',
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: 'A GitHub-compatible forge: repositories, issues and pull requests over MCP, REST and git smart HTTP.',
        }),
      };
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        }),
      };
    }
    case 'ping':
      return { status: 200, body: rpcResult(id, {}) };
    case 'tools/list':
      return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      try {
        return { status: 200, body: rpcResult(id, callTool(name, args)) };
      } catch (error) {
        const code = (error as { rpcCode?: number }).rpcCode ?? -32602;
        return { status: 200, body: rpcError(id, code, error instanceof Error ? error.message : String(error)) };
      }
    }
    default:
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
  }
}

export function handleMcp(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  if (req.method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  const auth = req.headers.authorization;
  if (typeof auth !== 'string' || auth.trim() === '') {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(`${JSON.stringify(rpcError(null, -32700, 'Parse error'))}\n`);
    return;
  }
  if (Array.isArray(parsed)) {
    const responses = parsed
      .map((entry) => handleRpc((typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>))
      .filter((outcome) => outcome.body !== undefined)
      .map((outcome) => outcome.body);
    sendJson(res, 200, responses);
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(`${JSON.stringify(rpcError(null, -32600, 'Invalid Request'))}\n`);
    return;
  }
  const outcome = handleRpc(parsed as Record<string, unknown>);
  if (outcome.status === 202 || outcome.body === undefined) {
    res.writeHead(202);
    res.end();
    return;
  }
  sendJson(res, outcome.status, outcome.body);
}
