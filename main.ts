// Entry point for the forge.
//
// The harness that grades this program runs a companion service, the env, and
// expects the entry to follow a small handshake with it:
//
//   * the env's origin arrives in MAKEFUN_ENV_URL; with no origin there is no
//     trial to take part in, so the process refuses to start;
//   * the forge server (built by app.ts) is bound to port 0, letting the
//     kernel choose a free port, and that port is announced to the env with a
//     POST to /register — the env then reaches the server at that port;
//   * the process then polls the env's /done endpoint and stays alive until
//     the env reports the trial is finished, at which point it closes the
//     server and exits successfully.
//
// Both env calls are retried with a growing delay, because the env may still
// be starting when the entry first tries to reach it. The only import is the
// server factory from app.ts: everything else is language and runtime basics.

import { createApp } from './app.ts';

/** Tuning for talking to the env: how long a single call may hang, and how the pause between retries grows. */
const CALL_TIMEOUT_MS = 30_000;
const FIRST_PAUSE_MS = 250;
const LONGEST_PAUSE_MS = 2_000;

/** Raised when the env rejects the register call itself (as opposed to not answering yet). */
class RegisterRefused extends Error {}

/** The env's origin with any trailing slashes removed, or '' when the variable is unset or blank. */
function envOrigin(): string {
  const raw = process.env.MAKEFUN_ENV_URL;
  return raw === undefined ? '' : raw.replace(/\/+$/, '');
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * How long to wait before the next try, given how many tries have failed so
 * far: the pause doubles each time from FIRST_PAUSE_MS and is capped at
 * LONGEST_PAUSE_MS, so a slow-starting env is polled patiently but not wildly.
 */
function pauseAfter(failures: number): number {
  const grown = FIRST_PAUSE_MS * 2 ** Math.min(failures, 8);
  return Math.min(LONGEST_PAUSE_MS, grown);
}

/**
 * Announce the port the server bound. A 200 means the env took note; a 409
 * means an earlier announcement already won and this one changes nothing, so
 * both end the loop. A 400 or 405 says the request itself broke the contract,
 * which retrying cannot fix, so it is raised as fatal. Anything else — the
 * env not being up yet, a reset connection, an unexpected status — is worth
 * waiting on and trying again.
 */
async function announcePort(origin: string, port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    let refused: RegisterRefused | undefined;
    try {
      const reply = await fetch(`${origin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (reply.status === 200 || reply.status === 409) {
        return;
      }
      if (reply.status === 400 || reply.status === 405) {
        refused = new RegisterRefused(`register answered HTTP ${reply.status}: ${await reply.text()}`);
      }
    } catch {
      // The call never landed or timed out: the env is not ready, so fall
      // through to the wait and try again.
    }
    if (refused !== undefined) {
      throw refused;
    }
    await pause(pauseAfter(failures));
    failures += 1;
  }
}

/**
 * Ask the env, again and again, whether the trial is over, and return only
 * once it answers {"done": true}. A reply that is not ok, a body that does
 * not parse, or a call that fails outright all mean "not yet": wait and ask
 * again. This never gives up on its own.
 */
async function untilTrialOver(origin: string): Promise<void> {
  let failures = 0;
  for (;;) {
    let over = false;
    try {
      const reply = await fetch(`${origin}/done`, {
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (reply.ok) {
        const body: unknown = await reply.json();
        over = typeof body === 'object' && body !== null && (body as { done?: unknown }).done === true;
      }
    } catch {
      // Not answering yet is just another form of "not done".
    }
    if (over) {
      return;
    }
    await pause(pauseAfter(failures));
    failures += 1;
  }
}

/**
 * Bring the server up on a kernel-chosen port, hand that port to the env,
 * and hold the process open until the env ends the trial.
 */
async function serve(origin: string): Promise<void> {
  const server = createApp();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      resolve();
    });
  });

  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await announcePort(origin, bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await untilTrialOver(origin);

  server.close();
  process.stdout.write('[entry] done\n');
}

const origin = envOrigin();
if (origin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

try {
  await serve(origin);
  process.exit(0);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[entry] ${message}\n`);
  process.exit(1);
}
