/**
 * The destructive orchestration. Order is load-bearing:
 * archive-then-delete (archiving requires the session to exist), registry row
 * last among DSH state (it is the only place the session ids are recorded), and
 * the project folder after all of it (so a failure stays retryable and never
 * leaves "folder gone, sessions alive").
 * @module @local/dsh-session-purge/lib/execute
 */
import fs from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { collectAttachmentUsage, sweepAttachments } from './attachments.js';
import { workspaceRegistry } from './harness.js';
import { existsSync, measureDirectory, samePath } from './paths.js';

/** One inventory line for the result table. */
function step(name, status, detail) {
  return detail === undefined ? { step: name, status } : { step: name, status, detail };
}

/** Recursive delete that treats "already gone" as success and keeps retrying. */
async function removeTree(target) {
  try {
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
    return { ok: true };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true };
    return { ok: false, code: error?.code ?? 'unknown', message: String(error?.message ?? error) };
  }
}

/** Remove one file, tolerating absence. */
async function removeFile(target) {
  try {
    await fs.promises.unlink(target);
    return { ok: true };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true };
    return { ok: false, code: error?.code ?? 'unknown', message: String(error?.message ?? error) };
  }
}

/** Delete a directory only when it is empty (never prunes trees). */
async function removeIfEmpty(target) {
  try {
    const entries = await fs.promises.readdir(target);
    if (entries.length > 0) return { ok: true, skipped: true };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, skipped: true };
    return { ok: false, code: error?.code ?? 'unknown', message: String(error?.message ?? error) };
  }
  return removeTree(target);
}

/** Basename(s) of the target folder, for the typed confirmation check. */
export function folderBasenames(target) {
  const base = path.basename(target);
  const parent = path.basename(path.dirname(target));
  return parent && parent !== base ? [base, `${parent}\\${base}`, `${parent}/${base}`] : [base];
}

/** Whether the typed confirmation unlocks the folder deletion. */
export function typedNameAccepted(target, typed) {
  if (typeof typed !== 'string') return false;
  const wanted = folderBasenames(target).map((value) => value.toLowerCase());
  return wanted.includes(typed.trim().toLowerCase());
}

/**
 * Execute (or dry-run) one workspace purge.
 * @param ctx - host context.
 * @param plan - the preview plan from `buildPlan`.
 * @param options - `{ config, attachments, folderName, dryRun }`.
 * @returns {Promise<object>} the result document.
 */
export async function executePurge(ctx, plan, options = {}) {
  const config = options.config ?? {};
  const dryRun = options.dryRun === true;
  const registry = workspaceRegistry(ctx);
  const steps = [];
  const deletedSessions = [];
  const failed = [];
  const skipped = [];
  const result = {
    workspaceId: plan.workspaceId,
    title: plan.title,
    path: plan.path,
    dryRun,
    steps,
    deletedSessions,
    failed,
    skipped,
    cacheFilesDeleted: 0,
    emptyDirsRemoved: 0,
    registryDeleted: false,
    folderDeleted: false,
    folderError: undefined,
    residuals: undefined,
    attachments: undefined,
    tombstonesKept: [],
  };

  if (!plan.guards?.ok && !dryRun) {
    failed.push({ id: plan.workspaceId, code: plan.guards?.code ?? 'guard', message: plan.guards?.message ?? '护栏未通过' });
    steps.push(step('guards', 'failed', plan.guards?.code));
    return result;
  }
  steps.push(step('guards', plan.guards?.ok ? 'ok' : 'skipped', plan.guards?.code));

  if (dryRun) {
    result.cacheFilesDeleted = plan.cacheFiles?.length ?? 0;
    for (const session of plan.sessions) deletedSessions.push(session.id);
    steps.push(step('dry-run', 'ok', `${plan.sessions.length} sessions`));
    if (options.attachments === true && plan.attachmentsRoot) {
      const usage = await collectAttachmentUsage(ctx, new Set());
      result.attachments = usage.ok
        ? await sweepAttachments(
            { attachmentsRoot: plan.attachmentsRoot, cacheRoot: plan.cacheRoot },
            usage.referenced,
            { dryRun: true },
          )
        : { ok: false, code: usage.code, message: usage.message, blocked: usage.blocked, reasons: usage.reasons };
      steps.push(step('attachments', result.attachments.ok ? 'ok' : 'failed', 'dry-run'));
    }
    return result;
  }

  // 1. Sessions: archive (hide + stop work + gate agent/pre-step), then remove
  //    the artifacts, then drop the accounting slot.
  const archived = [];
  for (const session of plan.sessions) {
    if (registry && typeof registry.archiveSession === 'function') {
      try {
        await registry.archiveSession(session.id, { stopActivity: true });
        archived.push(session.id);
      } catch (error) {
        failed.push({
          id: session.id,
          code: 'archive-failed',
          message: String(error?.message ?? error),
        });
        continue;
      }
    }
    if (session.dir) {
      const removed = await removeTree(session.dir);
      if (!removed.ok) {
        failed.push({ id: session.id, code: `dir-${removed.code}`, message: removed.message });
        continue;
      }
    }
    const cachePath = plan.dshHome
      ? path.join(plan.dshHome, 'storages', 'session_projcache', 'sessions', `${session.id}.json`)
      : undefined;
    if (cachePath && existsSync(cachePath)) {
      const cacheRemoved = await removeFile(cachePath);
      if (cacheRemoved.ok) result.cacheFilesDeleted += 1;
      else failed.push({ id: session.id, code: `cache-${cacheRemoved.code}`, message: cacheRemoved.message });
    }
    try {
      const workspace = typeof registry?.get === 'function' ? registry.get(plan.workspaceId) : undefined;
      if (workspace && typeof workspace.detachSession === 'function') {
        await workspace.detachSession(session.id);
      }
    } catch {
      /* accounting disappears with the registry row below */
    }
    deletedSessions.push(session.id);
  }
  for (const item of plan.unresolved ?? []) skipped.push(item);
  steps.push(
    step(
      'sessions',
      failed.length === 0 ? 'ok' : 'partial',
      `${deletedSessions.length} deleted, ${failed.length} failed`,
    ),
  );

  // 2. Registry row (the session ids now live only in `plan`).
  if (registry && typeof registry.delete === 'function') {
    try {
      result.registryDeleted = (await registry.delete(plan.workspaceId)) !== false;
      steps.push(step('registry', result.registryDeleted ? 'ok' : 'skipped'));
    } catch (error) {
      failed.push({ id: plan.workspaceId, code: 'registry-delete-failed', message: String(error?.message ?? error) });
      steps.push(step('registry', 'failed', String(error?.message ?? error)));
    }
  } else {
    steps.push(step('registry', 'skipped', 'service-unavailable'));
  }

  // 3. Prune the now-empty per-project session directory.
  if (plan.projectKeyDir) {
    const pruned = await removeIfEmpty(plan.projectKeyDir);
    if (pruned.ok && !pruned.skipped) result.emptyDirsRemoved += 1;
    steps.push(step('empty-project-dir', pruned.ok ? 'ok' : 'failed', pruned.skipped ? 'not-empty' : undefined));
  }

  // 4. The project folder itself (last, and only when the guards allowed it).
  const wantsFolder = config.deleteProjectFolder !== false;
  const folderAllowed =
    wantsFolder &&
    plan.folderExists &&
    plan.guards?.ok === true &&
    (config.requireFolderNameConfirm === false ||
      typedNameAccepted(plan.path, options.folderName));
  if (!wantsFolder) {
    steps.push(step('project-folder', 'skipped', 'disabled-by-config'));
  } else if (!plan.folderExists) {
    steps.push(step('project-folder', 'skipped', 'missing'));
  } else if (plan.guards?.ok !== true) {
    steps.push(step('project-folder', 'skipped', 'guard-refused'));
  } else if (!folderAllowed) {
    steps.push(step('project-folder', 'skipped', 'confirmation-mismatch'));
  } else {
    const removed = await removeTree(plan.path);
    if (removed.ok) {
      result.folderDeleted = true;
      steps.push(step('project-folder', 'ok'));
    } else {
      result.folderError = `${removed.code}: ${removed.message}`;
      failed.push({ id: plan.path, code: `folder-${removed.code}`, message: removed.message });
      result.residuals = measureDirectory(plan.path) ?? null;
      steps.push(step('project-folder', 'failed', result.folderError));
    }
  }

  // 5. Optional attachment reclamation (global mark-and-sweep, conservative).
  if (options.attachments === true && plan.attachmentsRoot) {
    const stillStored = new Set(deletedSessions);
    const usage = await collectAttachmentUsage(ctx, stillStored);
    if (!usage.ok) {
      result.attachments = { ok: false, code: usage.code, message: usage.message, blocked: usage.blocked, reasons: usage.reasons };
      steps.push(step('attachments', 'skipped', usage.code));
    } else {
      result.attachments = await sweepAttachments(
        { attachmentsRoot: plan.attachmentsRoot, cacheRoot: plan.cacheRoot },
        usage.referenced,
        { dryRun: false },
      );
      steps.push(
        step('attachments', result.attachments.ok ? 'ok' : 'failed', `${result.attachments.removedObjects} objects`),
      );
    }
  } else {
    steps.push(step('attachments', 'skipped', options.attachments === true ? 'no-store' : 'not-requested'));
  }

  result.tombstonesKept = archived.filter((id) => !existsSync(id));
  return result;
}

/** One-line summary used by the agent tool and the HTTP response. */
export function summarize(result) {
  const parts = [
    `${result.deletedSessions.length} 个会话`,
    `${result.cacheFilesDeleted} 个投影缓存`,
    result.registryDeleted ? '工作区注册' : null,
    result.folderDeleted ? `项目文件夹 ${result.path}` : null,
    result.attachments?.ok ? `${result.attachments.removedObjects} 个附件对象` : null,
  ].filter(Boolean);
  const head = result.dryRun ? '预检：将删除' : '已永久删除';
  const tail = result.failed.length > 0 ? `；${result.failed.length} 项失败` : '';
  return `${head} ${parts.join('、')}${tail}`;
}

/** Whether a path is the workspace's own session directory (defensive). */
export function isOwnSessionDir(plan, candidate) {
  return plan.sessions.some((session) => session.dir && samePath(session.dir, candidate));
}
