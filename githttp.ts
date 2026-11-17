// Git smart HTTP: info/refs advertisements (protocol v0 and v2), v2 ls-refs, fetch (v2 and v0,
// with shallow/deepen support) and v0 receive-pack with report-status over side-band-64k.
// Repositories must already exist (created through the REST surface); a push cannot invent one.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  parseCommit,
  parseTagTarget,
  pktLine,
  readPack,
  writePack,
  type GitObject,
} from './gitobj.ts';
import {
  ForgeError,
  getObject,
  getRepo,
  isAncestor,
  objects,
  peelToCommit,
  tickIso,
  type RepoRec,
} from './store.ts';

const AGENT = 'github-core-clone/1.0';

function hasAuth(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.trim() !== '';
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  sendBuffer(res, status, 'text/plain; charset=utf-8', Buffer.from(text, 'utf8'));
}

// ------------------------------------------------------------------ advertisements

interface RefLine {
  readonly oid: string;
  readonly name: string;
  readonly peeled?: string;
}

/** All refs of a repo in advertisement order: HEAD first (handled by callers), then sorted refs. */
function sortedRefs(repo: RepoRec): RefLine[] {
  const lines: RefLine[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    lines.push({ oid, name });
    const object = getObject(oid);
    if (object?.type === 'tag') {
      const target = parseTagTarget(object.data);
      if (target) lines.push({ oid: target, name: `${name}^{}` });
    }
  }
  return lines;
}

function headTarget(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function advertiseV0(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const target = headTarget(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get(target) ?? (refs[0] as RefLine).oid;
    parts.push(pktLine(`${headOid} HEAD\0symref=HEAD:${target} ${caps}\n`));
    for (const ref of refs) parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function advertiseV2(): Buffer {
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ];
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ pkt-line request parsing

interface RequestLine {
  readonly text: string;
}

/** Split a v2 request body into command/capability lines and argument lines (delim-separated). */
function parseV2Request(body: Buffer): { head: string[]; args: string[]; rest: Buffer } {
  const head: string[] = [];
  const args: string[] = [];
  let offset = 0;
  let inArgs = false;
  for (;;) {
    if (offset + 4 > body.length) throw new ForgeError(400, 'truncated pkt-line request');
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new ForgeError(400, 'bad pkt-line header');
    const length = parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length === 1) {
      inArgs = true;
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) throw new ForgeError(400, 'pkt-line out of range');
    const text = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
    (inArgs ? args : head).push(text);
    offset += length;
  }
  return { head, args, rest: body.subarray(offset) };
}

/** Parse a v0 fetch request: wants (flush) then haves/done (flush). */
function parseV0FetchRequest(body: Buffer): { wants: string[]; haves: string[]; shallow: string[]; depth: number | null; done: boolean } {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let done = false;
  let offset = 0;
  let section = 0;
  for (;;) {
    if (offset + 4 > body.length) break;
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new ForgeError(400, 'bad pkt-line header');
    const length = parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      section += 1;
      if (section >= 2) break;
      continue;
    }
    if (length < 4 || offset + length > body.length) throw new ForgeError(400, 'pkt-line out of range');
    const text = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
    offset += length;
    if (section === 0) {
      if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0] as string);
      else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) depth = Number(text.slice(7));
    } else {
      if (text.startsWith('have ')) haves.push(text.slice(5).trim());
      else if (text === 'done') done = true;
    }
  }
  return { wants, haves, shallow, depth, done };
}

// ------------------------------------------------------------------ fetch computation

interface FetchPlan {
  readonly send: Map<string, GitObject>;
  readonly shallow: string[];
  readonly unshallow: string[];
}

/** Every object reachable from `oid` (commits walk their parents; tags peel). */
function closureInto(start: string, into: Set<string>, includeParents: boolean): void {
  const stack: string[] = [start];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (into.has(oid)) continue;
    const object = getObject(oid);
    if (!object) continue;
    into.add(oid);
    if (object.type === 'commit') {
      const info = parseCommit(object.data);
      stack.push(info.tree);
      if (includeParents) for (const parent of info.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      // Trees are walked through their entries by flattening lazily: reuse a mini parser here.
      let offset = 0;
      const data = object.data;
      while (offset < data.length) {
        const space = data.indexOf(0x20, offset);
        if (space < 0) break;
        const nul = data.indexOf(0x00, space + 1);
        if (nul < 0) break;
        stack.push(data.subarray(nul + 1, nul + 21).toString('hex'));
        offset = nul + 21;
      }
    } else if (object.type === 'tag') {
      const target = parseTagTarget(object.data);
      if (target) stack.push(target);
    }
  }
}

function computeFetch(input: {
  wants: readonly string[];
  haves: readonly string[];
  shallowBoundary: readonly string[];
  depth: number | null;
}): FetchPlan {
  const haveObjects = new Set<string>();
  const boundary = new Set<string>(input.shallowBoundary);
  for (const shallow of boundary) closureInto(shallow, haveObjects, false);
  for (const have of input.haves) {
    // A commit the client declares shallow is held without its history: its ancestors are
    // not the client's, so they must not be excluded (a deepen fetch exists to deliver them).
    if (!boundary.has(have)) closureInto(have, haveObjects, true);
  }

  // Breadth-first levels from the wants (peeling tags to their commits).
  const levels = new Map<string, number>();
  const tagWants: string[] = [];
  const queue: string[] = [];
  for (const want of input.wants) {
    const object = getObject(want);
    if (!object) continue;
    if (object.type === 'tag') {
      tagWants.push(want);
      const commit = peelToCommit(want);
      if (commit && !levels.has(commit)) {
        levels.set(commit, 0);
        queue.push(commit);
      }
    } else if (object.type === 'commit') {
      if (!levels.has(want)) {
        levels.set(want, 0);
        queue.push(want);
      }
    } else {
      tagWants.push(want);
    }
  }
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const level = levels.get(oid) as number;
    const object = getObject(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!levels.has(parent)) {
        levels.set(parent, level + 1);
        queue.push(parent);
      }
    }
  }

  const depth = input.depth;
  const sendCommits = new Set<string>();
  for (const [oid, level] of levels) {
    if (depth !== null && level >= depth) continue;
    if (haveObjects.has(oid)) continue;
    sendCommits.add(oid);
  }

  const send = new Map<string, GitObject>();
  const addWithTree = (oid: string): void => {
    const closure = new Set<string>();
    closureInto(oid, closure, false);
    for (const member of closure) {
      if (haveObjects.has(member)) continue;
      const object = getObject(member);
      if (object) send.set(member, object);
    }
  };
  for (const oid of tagWants) {
    const object = getObject(oid);
    if (object && !haveObjects.has(oid)) send.set(oid, object);
  }
  for (const oid of sendCommits) addWithTree(oid);

  // The new shallow boundary: sent (or candidate) commits whose parent is neither sent nor held.
  const newShallow: string[] = [];
  const candidate = new Set<string>();
  for (const [oid, level] of levels) {
    if (depth === null || level < depth) candidate.add(oid);
  }
  for (const oid of candidate) {
    const object = getObject(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.some((parent) => !sendCommits.has(parent) && !haveObjects.has(parent))) {
      newShallow.push(oid);
    }
  }
  const unshallow: string[] = [];
  for (const oid of boundary) {
    const object = getObject(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length > 0 && parents.every((parent) => sendCommits.has(parent) || haveObjects.has(parent))) {
      unshallow.push(oid);
    }
  }
  return { send, shallow: [...new Set(newShallow)], unshallow };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65_515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, offset + CHUNK);
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    packets.push(pktLine(payload));
  }
  if (packets.length === 0) packets.push(pktLine(Buffer.concat([Buffer.from([1]), pack])));
  return packets;
}

// ------------------------------------------------------------------ handlers

function handleLsRefs(repo: RepoRec, body: Buffer, res: ServerResponse): void {
  const { args } = parseV2Request(body);
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  if (matches('HEAD')) {
    if (headOid) {
      parts.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    } else {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (ref.name.endsWith('^{}')) continue;
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    const object = getObject(ref.oid);
    if (peel && object?.type === 'tag') {
      const target2 = parseTagTarget(object.data);
      if (target2) line += ` peeled:${target2}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function handleFetchV2(repo: RepoRec, body: Buffer, res: ServerResponse): void {
  void repo;
  const { head, args } = parseV2Request(body);
  if (!head.some((line) => line === 'command=ls-refs')) {
    // command=fetch
    const wants: string[] = [];
    const haves: string[] = [];
    const shallowBoundary: string[] = [];
    let depth: number | null = null;
    let done = false;
    for (const arg of args) {
      if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
      else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
      else if (arg.startsWith('shallow ')) shallowBoundary.push(arg.slice(8).trim());
      else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7));
      else if (arg === 'done') done = true;
    }
    if (!done) {
      const parts: Buffer[] = [pktLine('acknowledgments\n')];
      const common = haves.filter((have) => getObject(have)?.type === 'commit');
      if (common.length === 0) parts.push(pktLine('NAK\n'));
      else for (const have of common) parts.push(pktLine(`ACK ${have} common\n`));
      parts.push(PKT_FLUSH);
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
      return;
    }
    const plan = computeFetch({ wants, haves, shallowBoundary, depth });
    const pack = writePack([...plan.send.entries()].map(([oid, object]) => ({ oid, object })));
    const parts: Buffer[] = [];
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pktLine('packfile\n'));
    for (const packet of sidebandPackets(pack)) parts.push(packet);
    parts.push(PKT_FLUSH);
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
    return;
  }
  handleLsRefs(repo, body, res);
}

function handleFetchV0(repo: RepoRec, body: Buffer, res: ServerResponse): void {
  void repo;
  const request = parseV0FetchRequest(body);
  const plan = computeFetch({
    wants: request.wants,
    haves: request.haves,
    shallowBoundary: request.shallow,
    depth: request.depth,
  });
  const pack = writePack([...plan.send.entries()].map(([oid, object]) => ({ oid, object })));
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

interface PushCommandLine {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function handleReceivePack(repo: RepoRec, body: Buffer, res: ServerResponse): void {
  // Command list: pkt-lines until flush; the remainder is the packfile (possibly empty).
  const commands: PushCommandLine[] = [];
  let capabilities = '';
  let offset = 0;
  for (;;) {
    if (offset + 4 > body.length) throw new ForgeError(400, 'truncated receive-pack request');
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new ForgeError(400, 'bad pkt-line header in receive-pack request');
    const length = parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) throw new ForgeError(400, 'pkt-line out of range');
    let text = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
    offset += length;
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      capabilities = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    const fields = text.split(' ');
    if (fields.length !== 3) throw new ForgeError(400, 'bad receive-pack command');
    commands.push({ oldOid: fields[0] as string, newOid: fields[1] as string, ref: fields[2] as string });
  }
  const packBytes = body.subarray(offset);
  let unpackOk = true;
  if (packBytes.length > 0) {
    try {
      const incoming = readPack(packBytes, (oid) => getObject(oid));
      for (const [oid, object] of incoming) {
        if (!objects.has(oid)) objects.set(oid, object);
      }
    } catch {
      unpackOk = false;
    }
  }

  const caps = new Set(capabilities.split(' ').filter(Boolean));
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    const succeed = (): void => {
      results.push({ ref: command.ref, ok: true, reason: '' });
    };
    if (!unpackOk) {
      fail('unpack failed');
      continue;
    }
    if (!command.ref.startsWith('refs/')) {
      fail('invalid ref');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      // Delete: always allowed for an existing ref.
      if (repo.refs.has(command.ref)) {
        repo.refs.delete(command.ref);
        succeed();
      } else {
        fail('reference does not exist');
      }
      continue;
    }
    const newObject = getObject(command.newOid);
    if (!newObject) {
      fail('object not found');
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      repo.refs.set(command.ref, command.newOid);
      succeed();
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (current !== command.oldOid) {
      fail('non-fast-forward');
      continue;
    }
    if (command.newOid === command.oldOid) {
      succeed();
      continue;
    }
    const newCommit = peelToCommit(command.newOid);
    const oldCommit = peelToCommit(command.oldOid);
    if (newCommit && oldCommit && !isAncestor(oldCommit, newCommit)) {
      fail('non-fast-forward');
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    succeed();
  }
  repo.updatedAt = tickIso();

  if (!caps.has('report-status') && !caps.has('report-status-v2')) {
    sendBuffer(res, 200, 'application/x-git-receive-pack-result', Buffer.alloc(0));
    return;
  }
  const reportParts: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : 'unpack error\n')];
  for (const result of results) {
    reportParts.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  if (caps.has('side-band-64k')) {
    const packets: Buffer[] = [];
    const CHUNK = 65_515;
    for (let at = 0; at < report.length; at += CHUNK) {
      const chunk = report.subarray(at, at + CHUNK);
      packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    packets.push(PKT_FLUSH);
    sendBuffer(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(packets));
    return;
  }
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', report);
}

// ------------------------------------------------------------------ entry point

export function handleGit(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer): void {
  try {
    const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)$/.exec(url.pathname);
    if (!match) {
      sendText(res, 404, 'Not Found');
      return;
    }
    const owner = decodeURIComponent(match[1] as string);
    const name = decodeURIComponent(match[2] as string);
    const tail = match[3] as string;
    const repo = getRepo(owner, name);
    if (!repo) {
      sendText(res, 404, 'Repository not found');
      return;
    }
    if (!hasAuth(req)) {
      sendText(res, 401, 'Requires authentication');
      return;
    }
    const method = req.method ?? 'GET';
    if (method === 'GET' && tail === '/info/refs') {
      const service = url.searchParams.get('service');
      if (service === 'git-upload-pack') {
        const protocol = req.headers['git-protocol'];
        if (typeof protocol === 'string' && protocol.includes('version=2')) {
          sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', advertiseV2());
        } else {
          sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', advertiseV0(repo, 'git-upload-pack'));
        }
        return;
      }
      if (service === 'git-receive-pack') {
        sendBuffer(res, 200, 'application/x-git-receive-pack-advertisement', advertiseV0(repo, 'git-receive-pack'));
        return;
      }
      sendText(res, 400, 'Unknown service');
      return;
    }
    if (method === 'POST' && tail === '/git-upload-pack') {
      const protocol = req.headers['git-protocol'];
      if (typeof protocol === 'string' && protocol.includes('version=2')) handleFetchV2(repo, body, res);
      else handleFetchV0(repo, body, res);
      return;
    }
    if (method === 'POST' && tail === '/git-receive-pack') {
      handleReceivePack(repo, body, res);
      return;
    }
    sendText(res, 404, 'Not Found');
  } catch (error) {
    if (error instanceof ForgeError) {
      sendText(res, error.status, error.message);
      return;
    }
    sendText(res, 500, error instanceof Error ? error.message : 'Internal error');
  }
}
