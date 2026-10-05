/**
 * Adapters over Harness services: read-only enumeration and the preview plan.
 * Everything here degrades to an explicit status instead of throwing, because
 * the plugin must stay usable across 0.2.x patch releases.
 * @module @local/dsh-session-purge/lib/harness
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { evaluateFolderGuards } from './guards.js';
import { existsSync, measureDirectory, normalizePath, probeWritable, samePath, tryRealpath } from './paths.js';

/** Resolve one service by key without throwing when it is absent. */
function service(ctx, key) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(key) : ctx[key];
  } catch {
    return undefined;
  }
}

/** `ctx.workspaceRegistry` (service key owned by dsh-workspace). */
export function workspaceRegistry(ctx) {
  return service(ctx, 'workspaceRegistry');
}

/** `ctx.sessionPersistence` (JSONL backend in every shipped profile). */
export function sessionPersistence(ctx) {
  return service(ctx, 'sessionPersistence');
}

/** `ctx.sessions` (live SessionStore); optional. */
export function sessionStore(ctx) {
  return service(ctx, 'sessions');
}

/** Live sessions as plain `{ id, cwd }` records (for guards and the picker). */
export function liveSessionSummaries(ctx) {
  return liveSessions(ctx)
    .map((session) => ({ id: session?.id, cwd: session?.header?.cwd }))
    .filter((session) => typeof session.id === 'string' && session.id !== '');
}

/** Live sessions, or an empty list when the store is unavailable. */
function liveSessions(ctx) {
  const store = sessionStore(ctx);
  if (!store || typeof store.list !== 'function') return [];
  try {
    return store.list() ?? [];
  } catch {
    return [];
  }
}

/** cwd of one live session, when known. */
function liveSessionCwd(ctx, id) {
  for (const session of liveSessions(ctx)) {
    if (session?.id === id) return session?.header?.cwd;
  }
  return undefined;
}

/**
 * Every stored session snapshot, or an empty list when persistence is absent.
 * @returns {Promise<Array<{id: string, cwd: string|undefined, bytes: number}>>}
 */
async function storedSessions(ctx) {
  const persistence = sessionPersistence(ctx);
  if (!persistence || typeof persistence.list !== 'function') return [];
  try {
    const snapshots = await persistence.list();
    return (snapshots ?? []).map((snapshot) => ({
      id: snapshot?.header?.id,
      cwd: snapshot?.header?.cwd,
      bytes: typeof snapshot?.sizeBytes === 'number' ? snapshot.sizeBytes : 0,
      header: snapshot?.header,
    }));
  } catch {
    return [];
  }
}

/**
 * Resolve one session's current-generation log path. This is an OPTIONAL
 * accelerator: `resolveCurrentLog` is a JSONL-backend method rather than part
 * of the `SessionPersistence` service contract, so every caller must cope with
 * `undefined` (see {@link locateProjectKeyDir} and the env fallback below).
 */
async function resolveLog(ctx, id) {
  const persistence = sessionPersistence(ctx);
  if (!persistence || typeof persistence.resolveCurrentLog !== 'function') return undefined;
  try {
    return await persistence.resolveCurrentLog(id);
  } catch {
    return undefined;
  }
}

/** `<DSH_HOME>/sessions`, the layout every shipped profile uses (when present). */
function sessionsRootFromEnv() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const root = path.join(home, 'sessions');
  return existsSync(root) ? root : undefined;
}

/**
 * Locate the `--<projectKey>--` directory holding any candidate session, by one
 * bounded scan. Used only when `resolveCurrentLog` is unavailable, so the purge
 * still knows which directory to remove without any backend-private API.
 * @returns the directory, or undefined when no candidate lives there.
 */
async function locateProjectKeyDir(sessionsRoot, candidateIds) {
  if (!sessionsRoot || candidateIds.size === 0) return undefined;
  let projectDirs;
  try {
    projectDirs = await fs.promises.readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue;
    const full = path.join(sessionsRoot, projectDir.name);
    let entries;
    try {
      entries = await fs.promises.readdir(full);
    } catch {
      continue;
    }
    if (entries.some((entry) => candidateIds.has(entry))) return full;
  }
  return undefined;
}

/**
 * Read one session header through the PUBLIC persistence API — `open(id,
 * 'read').header`. A read handle never takes ownership, so this works while the
 * session is live elsewhere. This is the authoritative cwd fallback.
 */
async function storedHeaderCwd(ctx, id) {
  const persistence = sessionPersistence(ctx);
  if (!persistence || typeof persistence.open !== 'function') return undefined;
  let handle;
  try {
    handle = await persistence.open(id, 'read');
  } catch {
    return undefined;
  }
  try {
    const cwd = handle?.header?.cwd;
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined;
  } finally {
    try {
      await handle.close();
    } catch {
      /* teardown is best effort */
    }
  }
}

/** The DSH home directory implied by the resolved sessions root. */
function homeFromSessionsRoot(sessionsRoot) {
  if (!sessionsRoot) return undefined;
  return path.dirname(sessionsRoot);
}

/**
 * Find the sessions root: from any materialized session when the backend can
 * name its log, otherwise from the environment layout.
 */
export async function discoverSessionsRoot(ctx) {
  const sessions = await storedSessions(ctx);
  for (const session of sessions.slice(0, 25)) {
    if (!session.id) continue;
    const log = await resolveLog(ctx, session.id);
    if (log) return path.dirname(path.dirname(path.dirname(log)));
  }
  const fromEnv = sessionsRootFromEnv();
  return fromEnv;
}

/**
 * Storage roots derivable from one sessions root: the attachment store the
 * sweep reclaims from, and the cached-attachment root it also sweeps.
 */
export function storageRootsFrom(sessionsRoot) {
  const dshHome = homeFromSessionsRoot(sessionsRoot);
  return {
    sessionsRoot,
    dshHome,
    attachmentsRoot: dshHome ? path.join(dshHome, 'attachments', 'v1') : undefined,
    cacheRoot: dshHome ? path.join(dshHome, 'cache', 'attachments') : undefined,
  };
}

/**
 * Storage roots without a workspace in hand — used by the standalone attachment
 * sweep, which reclaims globally and deletes no session or workspace.
 * @param ctx - host context.
 * @returns `{ sessionsRoot, dshHome, attachmentsRoot, cacheRoot }`.
 */
export async function storageRoots(ctx) {
  const sessionsRoot = (await discoverSessionsRoot(ctx)) ?? sessionsRootFromEnv();
  return storageRootsFrom(sessionsRoot);
}

/**
 * Locations that must never be deleted, expressed as "target must not contain
 * this path". Every entry is either a DSH-internal root or an OS location.
 */
export function protectedPaths(ctx, sessionsRoot) {
  const entries = [];
  const push = (label, value) => {
    if (typeof value === 'string' && value !== '') entries.push({ label, path: value });
  };
  push('用户主目录', os.homedir());
  push('DSH home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  push('profile 目录', process.env.DSH_PROFILE_DIR);
  push('进程工作目录', process.cwd());
  push('会话存储根', sessionsRoot);
  const home = homeFromSessionsRoot(sessionsRoot);
  push('会话存储根', home);
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    push('系统目录', systemRoot);
    push('Program Files', process.env['ProgramFiles']);
    push('Program Files (x86)', process.env['ProgramFiles(x86)']);
    push('ProgramData', process.env.ProgramData);
    push('临时目录', os.tmpdir());
    // Machine-specific runtime install, opted into through the environment so
    // the plugin carries no local absolute paths.
    push('DSH 运行时', process.env.DSH_RUNTIME);
  }
  return entries;
}

/**
 * Enumerate the sessions that belong to one workspace path: the union of the
 * registry's accounting and every stored/live session whose cwd matches. The
 * registry getter filters out sessions whose cwd no longer resolves, so the
 * cwd index is the authoritative side of that union.
 * @returns {Promise<{owned: Array<object>, unresolved: Array<object>, projectKeyDir: string|undefined, sessionsRoot: string|undefined}>}
 */
export async function collectWorkspaceSessions(ctx, workspace) {
  const target = workspace.path;
  const stored = await storedSessions(ctx);
  const byId = new Map();
  for (const session of stored) {
    if (session.id) byId.set(session.id, session);
  }
  const registryIds = Array.isArray(workspace.sessionIds) ? [...workspace.sessionIds] : [];
  const candidateIds = new Set(registryIds);
  for (const session of stored) {
    if (session.id && typeof session.cwd === 'string' && samePath(session.cwd, target)) {
      candidateIds.add(session.id);
    }
  }

  const owned = [];
  const unresolved = [];
  const logPaths = new Map();
  let projectKeyDir;
  let sessionsRoot;

  // 1. Resolve what the backend is willing to name, then fall back to one
  //    bounded scan so the plan never depends on a backend-private method.
  for (const id of candidateIds) {
    const logPath = await resolveLog(ctx, id);
    if (!logPath) continue;
    logPaths.set(id, logPath);
    const sessionDir = path.dirname(logPath);
    projectKeyDir ??= path.dirname(sessionDir);
    sessionsRoot ??= path.dirname(projectKeyDir);
  }
  sessionsRoot ??= sessionsRootFromEnv();
  if (!projectKeyDir) projectKeyDir = await locateProjectKeyDir(sessionsRoot, candidateIds);

  // 2. Classify each candidate by its cwd.
  for (const id of candidateIds) {
    const known = byId.get(id);
    const logPath = logPaths.get(id);
    let cwd = known?.cwd ?? liveSessionCwd(ctx, id);
    if (cwd === undefined) cwd = await storedHeaderCwd(ctx, id);
    if (typeof cwd !== 'string' || cwd === '') {
      unresolved.push({ id, reason: 'cwd-unknown' });
      continue;
    }
    if (!samePath(cwd, target)) continue;
    const sessionDir = logPath
      ? path.dirname(logPath)
      : projectKeyDir
        ? path.join(projectKeyDir, id)
        : undefined;
    owned.push({
      id,
      cwd,
      dir: sessionDir,
      bytes: known?.bytes ?? 0,
      live: liveSessions(ctx).some((session) => session?.id === id),
    });
  }

  return { owned, unresolved, projectKeyDir, sessionsRoot };
}

/** Projection-cache file for one session id. */
function projectionCachePath(dshHome, id) {
  return path.join(dshHome, 'storages', 'session_projcache', 'sessions', `${id}.json`);
}

/**
 * Build the preview plan for one workspace: what would be deleted, what the
 * guards say, and what cannot be determined. Read-only.
 * @param ctx - host context.
 * @param workspaceId - the workspace to plan for.
 * @param options - `config` (plugin config) and `currentSessionCwd`.
 * @returns {Promise<{ok: true, plan: object} | {ok: false, code: string, message: string}>}
 */
export async function buildPlan(ctx, workspaceId, options = {}) {
  const config = options.config ?? {};
  const registry = workspaceRegistry(ctx);
  if (!registry || typeof registry.get !== 'function') {
    return { ok: false, code: 'service-unavailable', message: '工作区服务不可用' };
  }
  let workspace;
  try {
    workspace = registry.get(workspaceId);
  } catch (error) {
    return { ok: false, code: 'workspace-lookup-failed', message: String(error?.message ?? error) };
  }
  if (!workspace) {
    return { ok: false, code: 'workspace-not-found', message: `找不到工作区：${workspaceId}` };
  }

  const sessionsRootDiscovered = await discoverSessionsRoot(ctx);
  const collection = await collectWorkspaceSessions(ctx, workspace);
  const sessionsRoot = collection.sessionsRoot ?? sessionsRootDiscovered;
  const dshHome = homeFromSessionsRoot(sessionsRoot);

  const resolvedPath = tryRealpath(workspace.path);
  const folderStats = measureDirectory(workspace.path);
  const folderExists = folderStats !== undefined || existsSync(workspace.path);

  const all = typeof registry.list === 'function' ? registry.list() : [];
  const otherWorkspacePaths = all
    .filter((entry) => entry && entry.id !== workspace.id)
    .map((entry) => entry.path)
    .filter((value) => typeof value === 'string' && value !== '');

  const stored = await storedSessions(ctx);
  const storedSessionCwds = stored.map((session) => session.cwd).filter(Boolean);
  const liveCwds = liveSessions(ctx)
    .map((session) => session?.header?.cwd)
    .filter(Boolean);

  const guards = evaluateFolderGuards({
    targetPath: workspace.path,
    resolvedPath,
    currentSessionCwd: options.currentSessionCwd,
    otherWorkspacePaths,
    liveSessionCwds: liveCwds,
    storedSessionCwds,
    protectedPaths: protectedPaths(ctx, sessionsRoot),
    minDepth: config.minFolderDepth ?? 2,
    allowRemoteVolume: config.allowRemoteVolume === true,
  });

  const cacheFiles = dshHome
    ? collection.owned
        .map((session) => projectionCachePath(dshHome, session.id))
        .filter((file) => existsSync(file))
    : [];

  return {
    ok: true,
    plan: {
      workspaceId: workspace.id,
      title: workspace.title,
      path: workspace.path,
      folderExists,
      folderStats,
      folderWritable: folderStats ? probeWritable(workspace.path) : undefined,
      guards,
      guardsEvaluated: true,
      sessions: collection.owned,
      unresolved: collection.unresolved,
      sessionsBytes: collection.owned.reduce((sum, session) => sum + (session.bytes || 0), 0),
      projectKeyDir: collection.projectKeyDir,
      ...storageRootsFrom(sessionsRoot),
      cacheFiles,
      otherWorkspaceCount: otherWorkspacePaths.length,
      archivesKnown: Array.isArray(registry.archivedSessionIds),
      normalizedTarget: normalizePath(workspace.path),
    },
  };
}

/** Compact workspace row for the picker list (cheap: no log reads). */
export async function workspaceSummaries(ctx) {
  const registry = workspaceRegistry(ctx);
  if (!registry || typeof registry.list !== 'function') return [];
  const stored = await storedSessions(ctx);
  let archived = [];
  try {
    archived = [...(registry.archivedSessionIds ?? [])];
  } catch {
    archived = [];
  }
  const archivedSet = new Set(archived);
  return registry.list().map((workspace) => {
    const own = stored.filter(
      (session) => typeof session.cwd === 'string' && samePath(session.cwd, workspace.path),
    );
    let folderExists = false;
    try {
      folderExists = fs.statSync(workspace.path).isDirectory();
    } catch {
      folderExists = false;
    }
    return {
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
      folderExists,
      sessionCount: own.length,
      sessionsBytes: own.reduce((sum, session) => sum + (session.bytes || 0), 0),
      archivedCount: own.filter((session) => archivedSet.has(session.id)).length,
    };
  });
}
