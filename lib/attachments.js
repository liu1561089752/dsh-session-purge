/**
 * Attachment reclamation by global mark-and-sweep.
 *
 * `attachments/v1/{objects,file-objects,files}` is sha256 content-addressed and
 * shared across sessions, with no reference count anywhere. Deleting "the
 * attachments of one session" is therefore impossible; the only safe deletion
 * is: read every REMAINING session log, collect the hashes they mention, then
 * remove only never-mentioned objects. The mark side deliberately
 * over-approximates (any 64-hex string counts as a reference), so the failure
 * mode is "kept too much", never "deleted a live attachment".
 * @module @local/dsh-session-purge/lib/attachments
 */
import fs from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

import { discoverSessionsRoot, liveSessionSummaries } from './harness.js';

const HEX = /\b[0-9a-f]{64}\b/gi;
const HASH_NAME = /^[0-9a-f]{64}$/i;
const SHARD_NAME = /^[0-9a-f]{2}$/i;
/** Zstandard frame magic `28 B5 2F FD` in file order. */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
/**
 * zstd inflation when this Node build offers it. Read off the namespace rather
 * than imported by name, so an older Node fails this one branch instead of
 * failing to load the whole plugin.
 */
const inflateZstd = typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : undefined;

/** Whether the buffer opens a zstd frame. Byte order matters: a little-endian read of the same magic is 0xFD2FB528. */
function isZstdFrame(bytes) {
  return bytes.length >= 4 && ZSTD_MAGIC.every((byte, index) => bytes[index] === byte);
}

/**
 * Whether a log artifact looks like undecoded binary. Compressed bytes scanned
 * as text would silently under-mark, so an artifact this plugin cannot identify
 * must block the sweep instead of pretending to be readable.
 */
function looksBinary(bytes) {
  const window = Math.min(bytes.length, 4096);
  for (let index = 0; index < window; index += 1) if (bytes[index] === 0x00) return true;
  return false;
}
/** Log artifacts of any generation, compressed or not. */
const LOG_FILE = /\.jsonl(\.zstd)?$/i;

/** Harvest every 64-hex token out of an arbitrary JSON value. */
function harvest(value, into) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    const matches = value.match(HEX);
    if (matches) for (const match of matches) into.add(match.toLowerCase());
    return;
  }
  if (typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) harvest(item, into);
    return;
  }
  for (const item of Object.values(value)) harvest(item, into);
}

/** Events harvested per read slice, keeping peak memory bounded. */
const PAGE_EVENTS = 1000;
/** Unreachable page ceiling; exceeding it counts as an incomplete read, never as an empty log. */
const MAX_PAGES = 10000;

/**
 * Sessions whose logs could not be read; a non-empty list blocks the sweep.
 *
 * The log is read through the PUBLIC persistence API — `open(id, 'read')` plus
 * paged `SessionHandle.read()`. `resolveCurrentLog`/`readStoredLog` are
 * JSONL-backend internals, not part of the `sessionPersistence` service, and a
 * `read` handle neither owns nor locks the session.
 *
 * When the backend refuses to open an artifact it cannot migrate (observed with
 * v0 logs: "unsupported descriptor version 2"), the session falls back to
 * {@link rawSessionHashes}. That fallback is deliberately restricted to
 * NON-live sessions: a live session's newest events may still be buffered
 * in memory, so a byte scan could under-mark and endanger a live attachment.
 */
async function readSessionHashes(ctx, session, into, sessionDirOf) {
  const persistence = ctx.get?.('sessionPersistence') ?? ctx.sessionPersistence;
  if (typeof persistence?.open !== 'function') {
    const raw = await rawSessionHashes(ctx, session, into, sessionDirOf);
    return raw.ok ? undefined : `persistence-unavailable:${raw.reason}`;
  }
  let handle;
  try {
    handle = await persistence.open(session.id, 'read');
  } catch (error) {
    const reason = `open-failed:${error?.code ?? error?.message ?? 'unknown'}`;
    const raw = await rawSessionHashes(ctx, session, into, sessionDirOf);
    return raw.ok ? undefined : `${reason}; raw:${raw.reason}`;
  }
  try {
    harvest(handle?.header, into);
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const slice = await handle.read(offset, PAGE_EVENTS);
      const events = slice?.events ?? [];
      if (events.length === 0) return undefined;
      harvest(events, into);
      const last = events[events.length - 1];
      const lastSeq = last && typeof last.seq === 'number' ? last.seq : undefined;
      offset = lastSeq === undefined ? offset + events.length : lastSeq + 1;
    }
    return 'page-cap';
  } catch (error) {
    return `read-failed:${error?.code ?? error?.message ?? 'unknown'}`;
  } finally {
    try {
      await handle.close();
    } catch {
      /* teardown is best effort: a failed close must not mask the read verdict */
    }
  }
}

/**
 * Bytes to text, transparently inflating a zstd frame.
 * @throws when the artifact is binary in a way this plugin cannot decode.
 */
function decodeLogBytes(bytes, name) {
  if (isZstdFrame(bytes)) {
    if (!inflateZstd) throw new Error(`zstd-unavailable:${name}`);
    return inflateZstd(bytes).toString('utf8');
  }
  if (looksBinary(bytes)) throw new Error(`unrecognized-compression:${name}`);
  return bytes.toString('utf8');
}

/**
 * Mark a session by scanning the raw artifacts in its directory.
 *
 * This is format-agnostic and deliberately over-approximating: every 64-hex
 * token in every log generation counts as a reference, so the only possible
 * error is keeping an object that nothing uses. It exists for logs the
 * persistence backend will not open at all, and it refuses to speak for a live
 * session (see {@link readSessionHashes}).
 * @returns `{ok: true, files: number}` or `{ok: false, reason: string}`.
 */
async function rawSessionHashes(ctx, session, into, sessionDirOf) {
  if (liveSessionSummaries(ctx).some((live) => live.id === session.id)) {
    return { ok: false, reason: 'live-session' };
  }
  const dir = await sessionDirOf(session.id);
  if (!dir) return { ok: false, reason: 'dir-unknown' };
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return { ok: false, reason: 'dir-unreadable' };
  }
  const files = entries.filter((entry) => entry.isFile() && LOG_FILE.test(entry.name)).map((entry) => entry.name);
  if (files.length === 0) return { ok: false, reason: 'no-artifact' };
  let scanned = 0;
  for (const name of files) {
    let bytes;
    try {
      bytes = await fs.promises.readFile(path.join(dir, name));
    } catch {
      return { ok: false, reason: `unreadable:${name}` };
    }
    try {
      harvest(decodeLogBytes(bytes, name), into);
    } catch {
      return { ok: false, reason: `undecodable:${name}` };
    }
    scanned += 1;
  }
  return { ok: true, files: scanned };
}

/**
 * Lazily index `session id -> session directory` by one scan of the sessions
 * root, so the raw fallback can find artifacts without any backend-private API.
 * Older stores name the directory with a bare UUID while newer ones use the
 * `session-` prefixed id, so both spellings are indexed and looked up.
 */
function createSessionDirIndex(ctx) {
  let built;
  const variants = (id) => {
    const bare = String(id).replace(/^session-/u, '');
    return [String(id), bare, `session-${bare}`];
  };
  return async (id) => {
    built ??= (async () => {
      const index = new Map();
      const root = await discoverSessionsRoot(ctx);
      if (!root) return index;
      let projectDirs;
      try {
        projectDirs = await fs.promises.readdir(root, { withFileTypes: true });
      } catch {
        return index;
      }
      for (const projectDir of projectDirs) {
        if (!projectDir.isDirectory()) continue;
        const full = path.join(root, projectDir.name);
        let entries;
        try {
          entries = await fs.promises.readdir(full, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const dir = path.join(full, entry.name);
          for (const key of variants(entry.name)) if (!index.has(key)) index.set(key, dir);
        }
      }
      return index;
    })();
    const index = await built;
    for (const key of variants(id)) {
      const dir = index.get(key);
      if (dir) return dir;
    }
    return undefined;
  };
}

/** Drop the volatile tail (raw paths) so identical failures group together. */
function reasonKey(reason) {
  const short = String(reason)
    .split(';')[0]
    .replace(/\(raw log:.*$/u, '')
    .trim();
  return short.length > 80 ? `${short.slice(0, 79)}…` : short;
}

/** Count blocked sessions per reason, so a dry run can explain itself. */
function reasonHistogram(blocked) {
  const reasons = {};
  for (const entry of blocked) {
    const key = reasonKey(entry.reason);
    reasons[key] = (reasons[key] ?? 0) + 1;
  }
  return reasons;
}

/**
 * Build the referenced-hash set from every session that is NOT being deleted.
 * @param ctx - host context.
 * @param idsBeingDeleted - session ids that are (or will be) gone.
 * @returns {Promise<{ok: boolean, referenced: Set<string>, scanned: number, blocked: Array<{id: string, reason: string}>, code?: string, message?: string}>}
 */
export async function collectAttachmentUsage(ctx, idsBeingDeleted) {
  const persistence = ctx.get?.('sessionPersistence') ?? ctx.sessionPersistence;
  if (!persistence || typeof persistence.list !== 'function') {
    return {
      ok: false,
      referenced: new Set(),
      scanned: 0,
      blocked: [],
      reasons: {},
      code: 'persistence-unavailable',
      message: '会话存储服务不可用，跳过附件回收',
    };
  }
  let snapshots;
  try {
    snapshots = await persistence.list();
  } catch (error) {
    return {
      ok: false,
      referenced: new Set(),
      scanned: 0,
      blocked: [],
      reasons: {},
      code: 'list-failed',
      message: String(error?.message ?? error),
    };
  }
  const referenced = new Set();
  const blocked = [];
  const targets = (snapshots ?? [])
    .map((snapshot) => ({ id: snapshot?.header?.id }))
    .filter((session) => session.id && !idsBeingDeleted.has(session.id));

  const concurrency = 4;
  const sessionDirOf = createSessionDirIndex(ctx);
  let cursor = 0;
  let scanned = 0;
  const workers = Array.from({ length: Math.min(concurrency, targets.length || 1) }, async () => {
    while (cursor < targets.length) {
      const index = cursor;
      cursor += 1;
      const session = targets[index];
      const reason = await readSessionHashes(ctx, session, referenced, sessionDirOf);
      if (reason) blocked.push({ id: session.id, reason: reason.slice(0, 300) });
      else scanned += 1;
    }
  });
  await Promise.all(workers);

  if (blocked.length > 0) {
    return {
      ok: false,
      referenced,
      scanned,
      blocked,
      reasons: reasonHistogram(blocked),
      code: 'mark-incomplete',
      message: `${blocked.length} 个会话无法读取，为安全起见放弃本次附件回收`,
    };
  }
  return { ok: true, referenced, scanned, blocked: [], reasons: {} };
}

/** One shard entry: the entry name IS the sha256 of the content. */
async function sweepShardDir(dir, referenced, outcome, dryRun) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    outcome.errors.push(`${dir}: ${error?.code ?? error?.message}`);
    return;
  }
  for (const entry of entries) {
    const hash = entry.name.toLowerCase();
    if (!HASH_NAME.test(hash)) {
      outcome.unknownLayout += 1;
      continue;
    }
    if (referenced.has(hash)) {
      outcome.keptObjects += 1;
      continue;
    }
    const target = path.join(dir, entry.name);
    let bytes = 0;
    try {
      bytes = (await fs.promises.stat(target)).size;
    } catch {
      bytes = 0;
    }
    if (!dryRun) {
      const removed = await rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).then(
        () => true,
        (error) => {
          if (error?.code === 'ENOENT') return true;
          outcome.errors.push(`${target}: ${error?.code ?? error?.message}`);
          return false;
        },
      );
      if (!removed) continue;
    }
    outcome.removedObjects += 1;
    outcome.removedBytes += bytes;
  }
}

/** Sweep one store root (`objects`, `file-objects`, `files`, `request-images`). */
async function sweepStore(root, referenced, outcome, dryRun) {
  let shards;
  try {
    shards = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    outcome.errors.push(`${root}: ${error?.code ?? error?.message}`);
    return;
  }
  for (const shard of shards) {
    if (!shard.isDirectory() || !SHARD_NAME.test(shard.name)) {
      if (shard.name !== 'tmp') outcome.unknownLayout += 1;
      continue;
    }
    await sweepShardDir(path.join(root, shard.name), referenced, outcome, dryRun);
  }
}

/**
 * Remove unreferenced objects and clear the temporary directory.
 * @param roots - `{ attachmentsRoot, cacheRoot }`.
 * @param referenced - the mark set from {@link collectAttachmentUsage}.
 * @param options - `{ dryRun }`.
 * @returns {Promise<object>} the sweep outcome.
 */
export async function sweepAttachments(roots, referenced, options = {}) {
  const dryRun = options.dryRun === true;
  const outcome = {
    ok: true,
    dryRun,
    removedObjects: 0,
    removedBytes: 0,
    keptObjects: 0,
    tmpCleared: 0,
    unknownLayout: 0,
    errors: [],
  };
  const attachmentsRoot = roots.attachmentsRoot;
  if (!attachmentsRoot) {
    return { ...outcome, ok: false, errors: ['attachments root unknown'] };
  }
  for (const kind of ['objects', 'file-objects', 'files', 'request-images']) {
    await sweepStore(path.join(attachmentsRoot, kind), referenced, outcome, dryRun);
  }
  const tmpDir = path.join(attachmentsRoot, 'tmp');
  let tmpEntries = [];
  try {
    tmpEntries = await fs.promises.readdir(tmpDir, { withFileTypes: true });
  } catch {
    tmpEntries = [];
  }
  for (const entry of tmpEntries) {
    if (!dryRun) {
      await rm(path.join(tmpDir, entry.name), { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(
        () => {},
      );
    }
    outcome.tmpCleared += 1;
  }
  if (roots.cacheRoot) {
    await sweepStore(roots.cacheRoot, referenced, outcome, dryRun);
  }
  outcome.ok = outcome.errors.length === 0;
  return outcome;
}
