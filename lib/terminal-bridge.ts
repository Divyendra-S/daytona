import type { PtyHandle } from "@daytonaio/sdk";
import { openProject, sandboxGeneration } from "./sandbox";
import { APP_SESSION, SANDBOX_DEV_PORT } from "./vars";

/**
 * Named terminal sessions inside a project's sandbox, fanned out to browser
 * tabs over SSE with input posted back. A session outlives its tabs and keeps
 * its recent output, so a reconnecting tab gets it replayed.
 *
 * Two kinds of session share that machinery:
 *
 * - A user's shell tab is a **pty** in the sandbox. It is addressed by a
 *   stable id, so `connectPty` re-attaches to the shell that is already there
 *   — a shell now survives AI Builder itself restarting, which it never did
 *   when the pty was a local child process.
 * - A project's dev server is an **exec session**, not a pty, so that it keeps
 *   running with nothing attached and its output can be replayed from the
 *   sandbox rather than only from this process's memory.
 */
type Session = {
  /** A user's shell, when one is attached. */
  pty: PtyHandle | null;
  /** The running command of a server session. Null once it has exited. */
  cmdId: string | null;
  /** Resolves when whatever is running in this session ends. */
  exited: Promise<void>;
  subscribers: Set<(chunk: Uint8Array) => void>;
  history: Uint8Array[];
  historyBytes: number;
  /** Which run of the sandbox this session belongs to. */
  generation: number;
};

/**
 * How much output a reconnecting tab gets back. Enough for a dev server's
 * recent compile output, bounded so an app that logs in a loop cannot grow it
 * without limit.
 */
const REPLAY_LIMIT = 256 * 1024;

const globals = globalThis as Record<string, unknown>;

/** Kept on globalThis so a hot reload of this module does not orphan attachments. */
const registry: Map<string, Session> =
  (globals["__aiBuilderTerminals"] as Map<string, Session>) ??
  (globals["__aiBuilderTerminals"] = new Map());

/** In-flight opens, so concurrent callers share one attach rather than racing. */
const opening: Map<string, Promise<Session>> = (globals[
  "__aiBuilderTerminalOpens"
] as Map<string, Promise<Session>>) ??
(globals["__aiBuilderTerminalOpens"] = new Map());

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
 * The session's record, created empty if this is the first anyone has asked.
 *
 * A record left over from an earlier run of the sandbox is emptied rather than
 * returned: the sandbox kept its disk across the restart but not its processes,
 * so the pty and the server command it names are both gone. Its subscribers are
 * kept — those are browser tabs, which are still watching and should see the
 * new session rather than be dropped.
 */
const record = (projectId: string, slug: string): Session => {
  const generation = sandboxGeneration(projectId);
  const existing = registry.get(key(projectId, slug));

  if (existing) {
    if (existing.generation === generation) return existing;
    existing.generation = generation;
    existing.pty = null;
    existing.cmdId = null;
    existing.exited = Promise.resolve();
    existing.history = [];
    existing.historyBytes = 0;
    return existing;
  }

  const session: Session = {
    pty: null,
    cmdId: null,
    exited: Promise.resolve(),
    subscribers: new Set(),
    history: [],
    historyBytes: 0,
    generation,
  };
  registry.set(key(projectId, slug), session);
  return session;
};

/** Run one attach at a time per session, and never cache a failed one. */
const once = (
  projectId: string,
  slug: string,
  attach: (session: Session) => Promise<void>,
) => {
  const id = key(projectId, slug);
  const inflight = opening.get(id);
  if (inflight) return inflight;

  const session = record(projectId, slug);
  const started = attach(session).then(() => session);
  opening.set(id, started);
  void started
    .catch(() => {})
    .finally(() => {
      if (opening.get(id) === started) opening.delete(id);
    });
  return started;
};

/* ------------------------------------------------------------------ */
/*  A user's shell                                                     */
/* ------------------------------------------------------------------ */

/**
 * Attach to a project's shell, reconnecting to the one already in the sandbox
 * when there is one and starting a fresh shell otherwise.
 */
const openShell = (projectId: string, slug: string) => {
  const existing = record(projectId, slug);
  if (existing.pty?.isConnected()) return Promise.resolve(existing);

  return once(projectId, slug, async (session) => {
    const { sandbox, app } = await openProject(projectId);
    const ptyId = `${projectId}-${slug}`;
    const onData = (chunk: Uint8Array) => broadcast(session, chunk);

    // Reconnect only to a pty that is actually still there; connecting to a
    // missing one would leave us waiting on a session nothing will ever write.
    const live = await sandbox.process
      .listPtySessions()
      .then((list) => list.some((info) => info.id === ptyId))
      .catch(() => false);

    const handle = live
      ? await sandbox.process.connectPty(ptyId, { onData })
      : await sandbox.process.createPty({
          id: ptyId,
          cwd: app,
          cols: 120,
          rows: 30,
          envs: { TERM: "xterm-256color" },
          onData,
        });

    await handle.waitForConnection();
    session.pty = handle;
    session.exited = handle.wait().then(({ exitCode }) => {
      if (session.pty !== handle) return;
      session.pty = null;
      broadcast(
        session,
        Buffer.from(`\r\n[process exited with code ${exitCode ?? 0}]\r\n`),
      );
    });
  });
};

/* ------------------------------------------------------------------ */
/*  A project's servers                                                */
/* ------------------------------------------------------------------ */

/**
 * Start a server in a named exec session, or adopt the one already running.
 *
 * Its output is streamed into the same fan-out a shell uses. The stream
 * replays the command's output from the beginning before following it live, so
 * after AI Builder restarts a terminal tab still shows how the server started.
 */
const openServer = (projectId: string, slug: string, command: string) => {
  const existing = record(projectId, slug);
  if (existing.cmdId) return Promise.resolve(existing);

  return once(projectId, slug, async (session) => {
    const { sandbox } = await openProject(projectId);
    const remote = sandbox.process;

    const found = await remote
      .listSessions()
      .then((list) => list.find((entry) => entry.sessionId === slug) ?? null)
      .catch(() => null);

    if (!found) {
      await remote.createSession(slug).catch(() => {
        // Raced with another request; the session is there either way.
      });
    }

    // A command with no exit code yet is still running: adopt it rather than
    // starting a second server on a port the first one already holds.
    const running = found?.commands.findLast(
      (entry) => entry.exitCode === undefined || entry.exitCode === null,
    );
    const cmdId =
      running?.id ??
      (await remote.executeSessionCommand(slug, { command, runAsync: true }))
        .cmdId;

    session.cmdId = cmdId;
    session.history = [];
    session.historyBytes = 0;

    // Resolves when the command ends, which is how a stopped server is noticed.
    session.exited = remote
      .getSessionCommandLogs(
        slug,
        cmdId,
        (chunk) => broadcast(session, Buffer.from(chunk, "utf8")),
        (chunk) => broadcast(session, Buffer.from(chunk, "utf8")),
      )
      .catch(() => {})
      .then(() => {
        if (session.cmdId !== cmdId) return;
        session.cmdId = null;
      });
  });
};

/** Stop a session's process and forget it, so the next start is a fresh one. */
const closeSession = async (projectId: string, slug: string) => {
  const session = registry.get(key(projectId, slug));
  const { sandbox } = await openProject(projectId);

  if (session?.pty) {
    await session.pty.kill().catch(() => {});
    await sandbox.process
      .killPtySession(`${projectId}-${slug}`)
      .catch(() => {});
    session.pty = null;
    return;
  }

  // Deleting an exec session kills its whole process tree, which is what a
  // dev server needs: its real work runs in grandchildren.
  await sandbox.process.deleteSession(slug).catch(() => {});
  if (session) {
    session.cmdId = null;
    session.history = [];
    session.historyBytes = 0;
  }
};

/**
 * Start a project's dev server, unless it is already running.
 *
 * `--hostname 0.0.0.0` is not optional: bound to loopback, the dev server is
 * invisible to the sandbox's preview proxy and the preview renders blank.
 */
export const ensureDevServer = async (projectId: string) => {
  const { app } = await openProject(projectId);
  await openServer(
    projectId,
    APP_SESSION,
    `cd ${app} && npm run dev -- --port ${SANDBOX_DEV_PORT} --hostname 0.0.0.0`,
  );
};

/**
 * A project's dev server as this AI Builder process knows it: running (or
 * still starting), exited, or never started.
 */
export const devServerState = (
  projectId: string,
): "running" | "exited" | "never" => {
  const session = registry.get(key(projectId, APP_SESSION));
  // A record from an earlier run of the sandbox describes processes that no
  // longer exist, so it counts as never started rather than as stopped.
  if (!session || session.generation !== sandboxGeneration(projectId)) {
    return "never";
  }
  return session.cmdId ? "running" : "exited";
};

/** Replace the dev server, for config it only reads at startup. */
export const restartDevServer = async (projectId: string) => {
  await closeSession(projectId, APP_SESSION);
  await ensureDevServer(projectId);
};

/* ------------------------------------------------------------------ */
/*  What the browser and the agent talk to                             */
/* ------------------------------------------------------------------ */

/**
 * Attach to a session by name: the dev server, or a user's shell.
 */
const openSession = async (projectId: string, slug: string) => {
  if (slug === APP_SESSION) {
    await ensureDevServer(projectId);
    return record(projectId, slug);
  }
  return openShell(projectId, slug);
};

/** Stream a session's output to one browser tab, recent history first. */
export const subscribeToTerminal = async (
  projectId: string,
  slug: string,
  onChunk: (chunk: Uint8Array) => void,
) => {
  const session = await openSession(projectId, slug).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error.";
    onChunk(Buffer.from(`\r\n[could not open the sandbox: ${message}]\r\n`));
    return null;
  });
  if (!session) return () => {};

  for (const chunk of session.history) onChunk(chunk);
  session.subscribers.add(onChunk);
  return () => session.subscribers.delete(onChunk);
};

export const writeToTerminal = async (
  projectId: string,
  slug: string,
  data: string,
) => {
  const session = registry.get(key(projectId, slug));
  if (!session) return;

  if (session.pty) {
    await session.pty.sendInput(data).catch(() => {});
    return;
  }
  if (session.cmdId) {
    const { sandbox } = await openProject(projectId);
    await sandbox.process
      .sendSessionCommandInput(slug, session.cmdId, data)
      .catch(() => {});
  }
};

export const resizeTerminal = async (
  projectId: string,
  slug: string,
  cols: number,
  rows: number,
) => {
  // Only a pty has a window size; a server session has nothing to resize.
  await registry
    .get(key(projectId, slug))
    ?.pty?.resize(cols, rows)
    .catch(() => {
      // The shell exited between the lookup and the resize.
    });
};

export const signalTerminal = async (
  projectId: string,
  slug: string,
  signal: "sigint" | "sigkill",
) => {
  if (signal === "sigint") {
    // There is no signal API, so interrupt the way a keyboard would.
    await writeToTerminal(projectId, slug, "");
    return;
  }
  await closeSession(projectId, slug);
};

/** A session's retained output, as text. */
export const readTerminalOutput = (projectId: string, slug: string) =>
  Buffer.concat(registry.get(key(projectId, slug))?.history ?? []).toString(
    "utf8",
  );

/** The dev server's output, starting it if it is not already running. */
export const readDevServerLogs = async (projectId: string) => {
  await ensureDevServer(projectId);
  return readTerminalOutput(projectId, APP_SESSION);
};
