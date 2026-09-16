import { existsSync } from "node:fs";
import path from "node:path";
import { spawn, type IPty } from "node-pty";
import { childEnv, projectPaths } from "./local-project";
import { APP_SESSION, LOCAL_HOST, PROD_SESSION } from "./vars";

/**
 * Named terminal sessions on this machine, one pty each, fanned out to
 * browser tabs over SSE with input posted back. A session outlives its tabs
 * and keeps its recent output, so a reconnecting tab gets it replayed; when a
 * session's process is replaced, its tabs stay subscribed and see the new one.
 */
type Session = {
  pty: IPty | null;
  exited: Promise<void>;
  subscribers: Set<(chunk: Uint8Array) => void>;
  history: Uint8Array[];
  historyBytes: number;
};

/**
 * How much output a reconnecting tab gets back. Enough for a dev server's
 * recent compile output, bounded so an app that logs in a loop cannot grow it
 * without limit.
 */
const REPLAY_LIMIT = 256 * 1024;

/** Kept on globalThis so a hot reload of this module does not orphan running processes. */
const registry: Map<string, Session> =
  ((globalThis as Record<string, unknown>)["__aiBuilderTerminals"] as Map<
    string,
    Session
  >) ??
  ((globalThis as Record<string, unknown>)["__aiBuilderTerminals"] = new Map());

const key = (projectId: string, slug: string) => `${projectId}:${slug}`;

const broadcast = (session: Session, chunk: Uint8Array) => {
  session.history.push(chunk);
  session.historyBytes += chunk.byteLength;
  while (session.historyBytes > REPLAY_LIMIT && session.history.length > 1) {
    session.historyBytes -= session.history.shift()!.byteLength;
  }
  for (const subscriber of session.subscribers) subscriber(chunk);
};

/**
 * Get a session, starting its process if none is running: `command` through
 * the user's login shell, or an interactive login shell when omitted.
 */
const openSession = (
  projectId: string,
  slug: string,
  command?: string,
  cwd = projectPaths(projectId).app,
) => {
  const id = key(projectId, slug);
  let session = registry.get(id);
  if (!session) {
    session = {
      pty: null,
      exited: Promise.resolve(),
      subscribers: new Set(),
      history: [],
      historyBytes: 0,
    };
    registry.set(id, session);
  }
  if (session.pty) return session;

  const current = session;
  const pty = spawn(
    process.env["SHELL"] || "/bin/zsh",
    command ? ["-lc", command] : ["-l"],
    { name: "xterm-256color", cols: 120, rows: 30, cwd, env: childEnv() },
  );

  current.pty = pty;
  current.exited = new Promise((resolve) => {
    pty.onExit(({ exitCode }) => {
      if (current.pty === pty) current.pty = null;
      broadcast(
        current,
        Buffer.from(`\r\n[process exited with code ${exitCode}]\r\n`),
      );
      resolve();
    });
  });
  pty.onData((data) => broadcast(current, Buffer.from(data)));

  return current;
};

/**
 * Stop a session's process and wait for it to exit. The whole process group
 * is signalled: a dev server's real work runs in grandchildren, which would
 * otherwise keep holding its port.
 */
const closeSession = async (projectId: string, slug: string) => {
  const session = registry.get(key(projectId, slug));
  const pty = session?.pty;
  if (!session || !pty) return;

  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pty.pid, signal);
    } catch {
      // Already gone.
    }
  };

  signalGroup("SIGTERM");
  const timedOut = await Promise.race([
    session.exited.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 5000)),
  ]);
  if (timedOut) {
    signalGroup("SIGKILL");
    await session.exited;
  }
};

/** Stream a session's output to one browser tab, recent history first. */
export const subscribeToTerminal = (
  projectId: string,
  slug: string,
  onChunk: (chunk: Uint8Array) => void,
) => {
  const session = openSession(projectId, slug);
  for (const chunk of session.history) onChunk(chunk);
  session.subscribers.add(onChunk);
  return () => session.subscribers.delete(onChunk);
};

const livePty = (projectId: string, slug: string) =>
  registry.get(key(projectId, slug))?.pty ?? null;

export const writeToTerminal = (
  projectId: string,
  slug: string,
  data: string,
) => livePty(projectId, slug)?.write(data);

export const resizeTerminal = (
  projectId: string,
  slug: string,
  cols: number,
  rows: number,
) => {
  try {
    livePty(projectId, slug)?.resize(cols, rows);
  } catch {
    // The process exited between the lookup and the resize.
  }
};

export const signalTerminal = (
  projectId: string,
  slug: string,
  signal: "sigint" | "sigkill",
) => livePty(projectId, slug)?.kill(signal === "sigint" ? "SIGINT" : "SIGKILL");

/** A session's retained output, as text. */
export const readTerminalOutput = (projectId: string, slug: string) =>
  Buffer.concat(registry.get(key(projectId, slug))?.history ?? []).toString(
    "utf8",
  );

/* ------------------------------------------------------------------ */
/*  A project's servers                                                */
/* ------------------------------------------------------------------ */

/** Start a project's dev server, unless it is already running. */
export const ensureDevServer = (projectId: string, port: number) => {
  openSession(
    projectId,
    APP_SESSION,
    `npm run dev -- --port ${port} --hostname ${LOCAL_HOST}`,
  );
};

/**
 * A project's dev server as this AI Builder process knows it: running (or still starting),
 * exited, or never started — which is every project right after AI Builder itself starts.
 */
export const devServerState = (
  projectId: string,
): "running" | "exited" | "never" => {
  const session = registry.get(key(projectId, APP_SESSION));
  if (!session) return "never";
  return session.pty ? "running" : "exited";
};

/** Replace the dev server, for config it only reads at startup. */
export const restartDevServer = async (projectId: string, port: number) => {
  await closeSession(projectId, APP_SESSION);
  ensureDevServer(projectId, port);
};

/** Serve a project's production build, if it has one and it is not already served. */
export const ensureProductionServer = (projectId: string, port: number) => {
  const { production } = projectPaths(projectId);
  if (!existsSync(path.join(production, ".next"))) return;
  openSession(
    projectId,
    PROD_SESSION,
    `npm run start -- --port ${port} --hostname ${LOCAL_HOST}`,
    production,
  );
};

export const stopProductionServer = (projectId: string) =>
  closeSession(projectId, PROD_SESSION);
