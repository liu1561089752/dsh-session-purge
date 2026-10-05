/**
 * Pure path helpers for the destructive guards. No `ctx`, no I/O except the
 * optional realpath probe — so every rule here is unit-testable.
 * @module @local/dsh-session-purge/lib/paths
 */
import fs from 'node:fs';
import path from 'node:path';

const WINDOWS = process.platform === 'win32';

/**
 * Case-folded, resolved comparison key for one path. Windows compares
 * case-insensitively; POSIX keeps the exact spelling.
 * @param value - any path string.
 * @returns the comparison key.
 */
export function normalizePath(value) {
  const resolved = path.resolve(value);
  return WINDOWS ? resolved.toLowerCase() : resolved;
}

/**
 * Whether two paths denote the same location.
 * @param a - first path.
 * @param b - second path.
 * @returns true when equal after normalization.
 */
export function samePath(a, b) {
  return normalizePath(a) === normalizePath(b);
}

/**
 * Whether `ancestor` contains `descendant` (or is the same path). Used for the
 * "is this folder somebody else's ancestor" family of guards.
 * @param ancestor - the candidate containing path.
 * @param descendant - the candidate contained path.
 * @returns true when descendant is inside ancestor or equal to it.
 */
export function containsPath(ancestor, descendant) {
  const a = normalizePath(ancestor);
  const d = normalizePath(descendant);
  if (a === d) return true;
  return d.startsWith(a.endsWith(path.sep) ? a : `${a}${path.sep}`);
}

/**
 * Whether `descendant` is strictly inside `ancestor` (NOT equal). This is the
 * nested-workspace / nested-session relation: deleting the ancestor destroys a
 * different project that merely lives under it.
 * @param ancestor - the candidate containing path.
 * @param descendant - the candidate contained path.
 * @returns true when strictly inside.
 */
export function strictlyContainsPath(ancestor, descendant) {
  return !samePath(ancestor, descendant) && containsPath(ancestor, descendant);
}

/**
 * Count path segments: `F:\` -> 1, `F:\ppt` -> 2, `/a/b/c` -> 3.
 * @param value - any path string.
 * @returns the segment count.
 */
export function pathDepth(value) {
  return normalizePath(value)
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0).length;
}

/**
 * `fs.realpath` that never throws. Native first (resolves junctions and
 * 8.3 short names on Windows), then the JS implementation.
 * @param value - path to resolve.
 * @returns the canonical path, or undefined when it cannot be resolved.
 */
export function tryRealpath(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    try {
      return fs.realpathSync(value);
    } catch {
      return undefined;
    }
  }
}

/**
 * Whether a path looks like a UNC share (`\\server\share\...`), where the
 * volume identity is remote and recursive deletion cannot be verified.
 * @param value - any path string.
 * @returns true for UNC paths.
 */
export function isUncPath(value) {
  return /^[\\/]{2}[^\\/]/.test(value);
}

/**
 * Recursive inventory of one directory: file count, total bytes, top-level
 * entry names (sorted, capped) and any walk error. Never throws.
 * @param root - directory to measure.
 * @param options - `topEntries` cap and `maxFiles` safety ceiling.
 * @returns the inventory, or `undefined` when root is not a readable directory.
 */
export function measureDirectory(root, options = {}) {
  const topEntries = options.topEntries ?? 12;
  const maxFiles = options.maxFiles ?? 500000;
  let rootStat;
  try {
    rootStat = fs.statSync(root);
  } catch {
    return undefined;
  }
  if (!rootStat.isDirectory()) return undefined;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  let fileCount = 0;
  let dirCount = 0;
  let bytes = 0;
  let truncated = false;
  const walk = (dir) => {
    let children;
    try {
      children = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (fileCount + dirCount >= maxFiles) {
        truncated = true;
        return;
      }
      const full = path.join(dir, child.name);
      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        dirCount += 1;
        walk(full);
      } else {
        fileCount += 1;
        bytes += stat.size;
      }
    }
  };
  walk(root);
  return {
    fileCount,
    dirCount,
    bytes,
    truncated,
    topEntries: entries
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, topEntries),
  };
}

/**
 * Whether the current process may plausibly delete inside `root`: probes by
 * creating and removing one temporary file. Detects read-only media and
 * missing permissions before a destructive walk starts.
 * @param root - directory to probe.
 * @returns `{ writable, reason }`.
 */
export function probeWritable(root) {
  const probe = path.join(root, `.dsh-session-purge-probe-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, '');
  } catch (error) {
    return { writable: false, reason: error?.code ?? String(error) };
  }
  try {
    fs.unlinkSync(probe);
  } catch {
    /* a leftover empty probe file is harmless */
  }
  return { writable: true };
}

/**
 * Windows long-path-safe existence check.
 * @param value - path to test.
 * @returns true when the path exists.
 */
export function existsSync(value) {
  try {
    fs.lstatSync(value);
    return true;
  } catch {
    return false;
  }
}
