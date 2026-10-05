/**
 * Startup / on-demand orphan sweep. DSH itself never deletes these, so leaving
 * them behind is exactly the "hard delete" gap this plugin exists to close.
 * Every step is best-effort and never blocks or fails the Host boot.
 * @module @local/dsh-session-purge/lib/sweep
 */
import fs from 'node:fs';
import path from 'node:path';

import { discoverSessionsRoot, sessionPersistence, workspaceRegistry } from './harness.js';
import { existsSync } from './paths.js';

/** Live session ids, or an empty set when the store is unavailable. */
function liveIds(ctx) {
  try {
    const store = ctx.get?.('sessions') ?? ctx.sessions;
    const sessions = store?.list?.() ?? [];
    return new Set(sessions.map((session) => session?.id).filter(Boolean));
  } catch {
    return new Set();
  }
}

/**
 * Clear archive tombstones that point at sessions which no longer exist, delete
 * projection caches for sessions that are gone, and prune empty project
 * directories. Tombstones whose session is still live are kept on purpose: the
 * live store entry would otherwise reappear as an unopenable row.
 * @param ctx - host context.
 * @param options - `{ pruneEmptyProjectDirs }`.
 * @returns {Promise<object>} counts of everything cleaned.
 */
export async function sweepOrphans(ctx, options = {}) {
  const outcome = {
    unarchived: 0,
    orphanCacheFiles: 0,
    emptyProjectDirs: 0,
    errors: [],
  };
  const registry = workspaceRegistry(ctx);
  const persistence = sessionPersistence(ctx);
  if (!registry || !persistence) return outcome;

  const live = liveIds(ctx);
  let snapshots = [];
  try {
    snapshots = (await persistence.list()) ?? [];
  } catch (error) {
    outcome.errors.push(`list: ${error?.message ?? error}`);
    return outcome;
  }
  const storedIds = new Set(snapshots.map((snapshot) => snapshot?.header?.id).filter(Boolean));

  // 1. Archive tombstones for vanished sessions.
  let archived = [];
  try {
    archived = [...(registry.archivedSessionIds ?? [])];
  } catch {
    archived = [];
  }
  for (const id of archived) {
    if (storedIds.has(id) || live.has(id)) continue;
    try {
      await registry.unarchiveSession(id);
      outcome.unarchived += 1;
    } catch (error) {
      outcome.errors.push(`unarchive ${id}: ${error?.message ?? error}`);
    }
  }

  const sessionsRoot = await discoverSessionsRoot(ctx);
  const dshHome = sessionsRoot ? path.dirname(sessionsRoot) : undefined;
  if (!dshHome) return outcome;

  // 2. Projection caches for sessions that no longer exist anywhere.
  const cacheDir = path.join(dshHome, 'storages', 'session_projcache', 'sessions');
  try {
    const entries = await fs.promises.readdir(cacheDir);
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const id = entry.slice(0, -'.json'.length);
      if (storedIds.has(id) || live.has(id)) continue;
      try {
        await fs.promises.unlink(path.join(cacheDir, entry));
        outcome.orphanCacheFiles += 1;
      } catch (error) {
        outcome.errors.push(`cache ${entry}: ${error?.message ?? error}`);
      }
    }
  } catch {
    /* no cache directory in this profile */
  }

  // 3. Empty per-project session directories.
  if (options.pruneEmptyProjectDirs !== false) {
    try {
      const projects = await fs.promises.readdir(sessionsRoot, { withFileTypes: true });
      for (const project of projects) {
        if (!project.isDirectory() || !project.name.startsWith('--')) continue;
        const full = path.join(sessionsRoot, project.name);
        if (existsSync(full) && (await fs.promises.readdir(full)).length === 0) {
          try {
            await fs.promises.rmdir(full);
            outcome.emptyProjectDirs += 1;
          } catch (error) {
            outcome.errors.push(`rmdir ${full}: ${error?.message ?? error}`);
          }
        }
      }
    } catch (error) {
      outcome.errors.push(`sessions root: ${error?.message ?? error}`);
    }
  }

  return outcome;
}
