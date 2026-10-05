/**
 * Session Purge — Host half.
 *
 * Adds its own JSON routes under `/api-ext/session-purge` and performs the only
 * destructive filesystem work in this plugin. It never touches the stock
 * "Delete workspace" action, and it refuses to act when the folder guards fail.
 *
 * Every capability here comes from public services (`workspaceRegistry`,
 * `sessionPersistence`, `sessions`, `webServer`) plus `node:fs`; the package
 * imports no other Harness module, so a patch release cannot break loading.
 * @module @local/dsh-session-purge
 */
import { buildPlan, liveSessionSummaries, storageRoots, workspaceSummaries } from './lib/harness.js';
import { executePurge, summarize } from './lib/execute.js';
import { collectAttachmentUsage, sweepAttachments } from './lib/attachments.js';
import {
  checkTrust,
  looksLikeSessionId,
  readJsonBody,
  sendError,
  sendMethodNotAllowed,
  sendOk,
} from './lib/http.js';
import { containsPath, samePath } from './lib/paths.js';
import { sweepOrphans } from './lib/sweep.js';

/** Route prefix. `/api` is owned by the client-connection RPC. */
const BASE = '/api-ext/session-purge';

/** Config defaults; override per profile in the `session-purge` patch row. */
export const DEFAULTS = Object.freeze({
  /** Delete the project folder itself (the whole point of this plugin). */
  deleteProjectFolder: true,
  /** Require the folder name to be typed before the folder is deleted. */
  requireFolderNameConfirm: true,
  /** Reclaim attachments no remaining session references. */
  deleteAttachments: true,
  /** Clear orphan tombstones, projection caches and empty project dirs at boot. */
  startupSweep: true,
  /** Allow targets on UNC shares (recursive delete cannot be verified there). */
  allowRemoteVolume: false,
  /** Allow requests from non-loopback addresses. Leave off. */
  allowNonLoopback: false,
  /** Minimum path segment count of a deletable folder. */
  minFolderDepth: 2,
  /** Prune `--<projectKey>--` directories left empty by a purge. */
  pruneEmptyProjectDirs: true,
});

/** Required Host services: without them the plugin stays inactive. */
export const inject = ['workspaceRegistry', 'sessionPersistence', 'webServer'];

/** Verify a caller-supplied session id against the live store. */
function resolveRequester(ctx, sessionId) {
  if (!looksLikeSessionId(sessionId)) return { verified: false, cwd: undefined };
  let store;
  try {
    store = ctx.get?.('sessions') ?? ctx.sessions;
  } catch {
    store = undefined;
  }
  const session = store?.get?.(sessionId);
  if (!session) return { verified: false, cwd: undefined };
  return { verified: true, cwd: session.header?.cwd, sessionId };
}

/** Live sessions whose working directory is the target or sits inside it. */
function liveSessionsInside(ctx, targetPath) {
  return liveSessionSummaries(ctx).filter(
    (session) => typeof session.cwd === 'string' && containsPath(targetPath, session.cwd),
  );
}

/** Live sessions whose cwd is exactly the target (i.e. sessions of this workspace). */
function liveSessionsOf(ctx, targetPath) {
  return liveSessionSummaries(ctx).filter(
    (session) => typeof session.cwd === 'string' && samePath(session.cwd, targetPath),
  );
}

/**
 * Apply the same request fence DSH's own API routes use, then fall back to this
 * plugin's own checks when the Connection service is absent (headless
 * compositions).
 *
 * `connection.requestRejection` answers 403 for an untrusted Host/Origin and
 * 401 for a request without the operator's browser-session cookie, so a local
 * process cannot drive these destructive routes.
 * @returns true when the request was answered and the handler must stop.
 */
function rejectUntrusted(ctx, req, res, config) {
  let connection;
  try {
    connection = typeof ctx.get === 'function' ? ctx.get('connection') : ctx.connection;
  } catch {
    connection = undefined;
  }
  if (connection && typeof connection.requestRejection === 'function') {
    const rejection = connection.requestRejection(req);
    if (rejection !== undefined) {
      res.statusCode = rejection;
      res.end();
      return true;
    }
    return false;
  }
  const trust = checkTrust(req, config);
  if (!trust.ok) {
    sendError(res, trust.status, trust.code, trust.message);
    return true;
  }
  return false;
}

/** Register one exact-path route with trust checks and error containment. */
function route(ctx, name, method, config, handler) {
  const path = `${BASE}/${name}`;
  return ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          if (rejectUntrusted(ctx, req, res, config)) return;
          if (req.method !== method) {
            sendMethodNotAllowed(res, method);
            return;
          }
          try {
            await handler(req, res);
          } catch (error) {
            const message = String(error?.message ?? error);
            try {
              ctx.logger?.warn?.(`session-purge: ${name} failed: ${message}`);
            } catch {
              /* logging is best-effort */
            }
            if (!res.writableEnded) sendError(res, 500, 'internal', message);
          }
        },
      }),
    `session-purge: ${method} ${path}`,
  );
}

/**
 * Host plugin entry.
 * @param ctx - host context.
 * @param config - partial config from the bundle patch row.
 */
export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) };
  const logger = ctx.logger;

  // GET /list — workspace rows for the picker (cheap: no session-log reads).
  route(ctx, 'list', 'GET', settings, async (req, res) => {
    const summaries = await workspaceSummaries(ctx);
    const live = liveSessionSummaries(ctx);
    sendOk(res, {
      workspaces: summaries.map((summary) => ({
        ...summary,
        liveCount: live.filter((session) => session.cwd && samePath(session.cwd, summary.path)).length,
      })),
      config: {
        deleteProjectFolder: settings.deleteProjectFolder !== false,
        requireFolderNameConfirm: settings.requireFolderNameConfirm !== false,
        deleteAttachments: settings.deleteAttachments !== false,
      },
    });
  });

  // POST /preview — read-only plan plus guard verdicts.
  route(ctx, 'preview', 'POST', settings, async (req, res) => {
    const body = await readJsonBody(req);
    if (!body.ok) {
      sendError(res, body.status, body.code, body.message);
      return;
    }
    const workspaceId = body.value.workspaceId;
    if (typeof workspaceId !== 'string' || workspaceId === '') {
      sendError(res, 400, 'invalid-request', '缺少 workspaceId');
      return;
    }
    const requester = resolveRequester(ctx, body.value.sessionId);
    const built = await buildPlan(ctx, workspaceId, {
      config: settings,
      currentSessionCwd: requester.verified ? requester.cwd : undefined,
    });
    if (!built.ok) {
      sendError(res, 409, built.code, built.message);
      return;
    }
    const plan = built.plan;
    const liveInside = liveSessionsInside(ctx, plan.path);
    sendOk(res, {
      plan,
      requester: { verified: requester.verified, cwd: requester.cwd },
      liveInside: liveInside.map((session) => session.id),
      liveOfWorkspace: liveSessionsOf(ctx, plan.path).map((session) => session.id),
      folderName: plan.path.split(/[\\/]/).filter(Boolean).pop() ?? '',
      summary: {
        sessions: plan.sessions.length,
        sessionsBytes: plan.sessionsBytes,
        cacheFiles: plan.cacheFiles.length,
        folderBytes: plan.folderStats?.bytes ?? 0,
        folderFiles: plan.folderStats?.fileCount ?? 0,
      },
    });
  });

  // POST /execute — run the purge (or the full attachment dry-run).
  route(ctx, 'execute', 'POST', settings, async (req, res) => {
    const body = await readJsonBody(req);
    if (!body.ok) {
      sendError(res, body.status, body.code, body.message);
      return;
    }
    const { value } = body;
    const workspaceId = value.workspaceId;
    const dryRun = value.dryRun === true;
    if (typeof workspaceId !== 'string' || workspaceId === '') {
      sendError(res, 400, 'invalid-request', '缺少 workspaceId');
      return;
    }
    if (!dryRun && value.confirm !== true) {
      sendError(res, 400, 'confirm-required', '执行前必须先预检并显式确认（confirm: true）');
      return;
    }

    const requester = resolveRequester(ctx, value.sessionId);
    const built = await buildPlan(ctx, workspaceId, {
      config: settings,
      currentSessionCwd: requester.verified ? requester.cwd : undefined,
    });
    if (!built.ok) {
      sendError(res, 409, built.code, built.message);
      return;
    }
    const plan = built.plan;

    // Hard refusal: the caller itself works inside the folder being deleted.
    if (requester.verified && typeof requester.cwd === 'string' && requester.cwd !== '') {
      if (containsPath(plan.path, requester.cwd)) {
        sendError(
          res,
          409,
          'current-session',
          '当前对话就工作在这个目录里。请先新建或切换到别的会话，再回来删除此工作区。',
          [requester.cwd],
        );
        return;
      }
    }
    // Unverified caller: require an explicit acknowledgement for live sessions.
    const liveInside = liveSessionsInside(ctx, plan.path);
    if (
      !requester.verified &&
      liveInside.length > 0 &&
      value.acknowledgeLive !== true
    ) {
      sendError(
        res,
        409,
        'live-sessions-unacknowledged',
        `有 ${liveInside.length} 个会话正在这个目录里，需要先确认会被停止`,
        liveInside.map((session) => session.id),
      );
      return;
    }
    if (!dryRun && plan.guards?.ok !== true) {
      sendError(res, 409, plan.guards?.code ?? 'guard', plan.guards?.message ?? '护栏未通过', plan.guards?.detail);
      return;
    }

    const wantsAttachments =
      value.attachments === undefined ? settings.deleteAttachments !== false : value.attachments === true;

    const result = await executePurge(ctx, plan, {
      config: settings,
      attachments: wantsAttachments,
      folderName: value.folderName,
      dryRun,
    });
    try {
      logger?.info?.(`session-purge: ${summarize(result)}`);
    } catch {
      /* logging is best-effort */
    }
    sendOk(res, { result, summary: summarize(result), path: plan.path, title: plan.title });
  });

  // Standalone attachment reclamation: the same global mark-and-sweep the purge
  // runs, but without deleting any session or workspace. This is the only way to
  // reclaim from a user who never purges a workspace.
  route(ctx, 'sweep-attachments', 'POST', settings, async (req, res) => {
    const body = await readJsonBody(req);
    if (!body.ok) {
      sendError(res, body.status, body.code, body.message);
      return;
    }
    const value = body.value;
    const dryRun = value.dryRun === true;
    if (!dryRun && value.confirm !== true) {
      sendError(res, 400, 'confirm-required', '执行前必须显式确认（confirm: true），或先用 dryRun 预检');
      return;
    }
    const roots = await storageRoots(ctx);
    if (!roots.attachmentsRoot) {
      sendError(res, 409, 'no-attachment-store', '找不到附件存储目录，无法回收');
      return;
    }
    const usage = await collectAttachmentUsage(ctx, new Set());
    if (!usage.ok) {
      sendOk(res, {
        dryRun,
        skipped: true,
        code: usage.code,
        message: usage.message,
        blocked: usage.blocked,
        reasons: usage.reasons,
        scanned: usage.scanned,
      });
      return;
    }
    const outcome = await sweepAttachments(roots, usage.referenced, { dryRun });
    sendOk(res, {
      dryRun,
      skipped: false,
      scanned: usage.scanned,
      referenced: usage.referenced.size,
      ...outcome,
    });
  });

  // Boot-time orphan sweep (never blocks activation).
  ctx.effect(() => {
    let stopped = false;
    const run = async () => {
      if (settings.startupSweep === false) return;
      await new Promise((resolve) => setTimeout(resolve, 2500));
      if (stopped) return;
      try {
        const outcome = await sweepOrphans(ctx, {
          pruneEmptyProjectDirs: settings.pruneEmptyProjectDirs !== false,
        });
        if (
          outcome.unarchived > 0 ||
          outcome.orphanCacheFiles > 0 ||
          outcome.emptyProjectDirs > 0
        ) {
          logger?.info?.(
            `session-purge: sweep cleared ${outcome.unarchived} tombstones, ` +
              `${outcome.orphanCacheFiles} cache files, ${outcome.emptyProjectDirs} empty dirs`,
          );
        }
      } catch (error) {
        logger?.warn?.(`session-purge: sweep failed: ${String(error?.message ?? error)}`);
      }
    };
    void run();
    return () => {
      stopped = true;
    };
  }, 'session-purge: startup sweep');
}
