// The forge's HTTP server: health probe, REST v3 (/api/v3), GraphQL v4 (/api/graphql),
// MCP (/mcp) and git smart HTTP (/<owner>/<repo>.git/...), all over one in-memory store.
// main.ts owns the lifecycle; this file is only the surface.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest, sendJson } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './githttp.ts';
import { nextRequestId } from './store.ts';

const MAX_BODY_BYTES = 256 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('x-github-request-id', nextRequestId());
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
        const body = needsBody ? await readBody(req) : Buffer.alloc(0);

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          handleRest(req, res, url, body);
          return;
        }
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          handleGraphQL(req, res, body);
          return;
        }
        if (path === '/mcp') {
          handleMcp(req, res, body);
          return;
        }
        if (/^\/[^/]+\/[^/]+\.git(\/.*)?$/.test(path)) {
          handleGit(req, res, url, body);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
      } catch (error) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: error instanceof Error ? error.message : 'Internal error' });
        } else {
          res.end();
        }
      }
    })();
  });
}
