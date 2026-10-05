/**
 * The destructive-folder guard set. Every rule is pure: give it paths and it
 * returns a verdict, so the whole policy is unit-testable without a Harness.
 * @module @local/dsh-session-purge/lib/guards
 */
import {
  containsPath,
  normalizePath,
  pathDepth,
  strictlyContainsPath,
} from './paths.js';

/** Stable refusal codes; the client localizes them and the API returns them verbatim. */
export const GUARD_CODES = Object.freeze({
  invalidTarget: 'invalid-target',
  symlinkTarget: 'symlink-target',
  tooShallow: 'too-shallow',
  remoteVolume: 'remote-volume',
  protectedPath: 'protected-path',
  currentSession: 'current-session',
  nestedWorkspace: 'nested-workspace',
  nestedSession: 'nested-session',
});

/**
 * @typedef {object} GuardInput
 * @property {string} targetPath - `workspace.path` exactly as recorded.
 * @property {string|undefined} resolvedPath - `realpath(targetPath)`, undefined when absent.
 * @property {string|undefined} currentSessionCwd - cwd of the session making the request.
 * @property {string[]} otherWorkspacePaths - every OTHER registered workspace path.
 * @property {string[]} liveSessionCwds - cwds of live sessions.
 * @property {string[]} storedSessionCwds - cwds of stored sessions.
 * @property {{label: string, path: string}[]} protectedPaths - never-deletable locations.
 * @property {number} minDepth - minimum path segment count.
 * @property {boolean} allowRemoteVolume - whether UNC shares are allowed.
 */

/**
 * Evaluate every rule in fixed order and return the first refusal.
 * @param {GuardInput} input - the paths and policy knobs.
 * @returns {{ok: true, canonical: string, missing: boolean} | {ok: false, code: string, message: string, detail?: string[]}}
 */
export function evaluateFolderGuards(input) {
  const {
    targetPath,
    resolvedPath,
    currentSessionCwd,
    otherWorkspacePaths = [],
    liveSessionCwds = [],
    storedSessionCwds = [],
    protectedPaths = [],
    minDepth = 2,
    allowRemoteVolume = false,
  } = input;

  if (typeof targetPath !== 'string' || targetPath.trim() === '') {
    return { ok: false, code: GUARD_CODES.invalidTarget, message: '工作区没有记录路径' };
  }
  if (!/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(targetPath)) {
    return {
      ok: false,
      code: GUARD_CODES.invalidTarget,
      message: `工作区路径不是绝对路径：${targetPath}`,
    };
  }

  const missing = resolvedPath === undefined;
  const canonical = normalizePath(resolvedPath ?? targetPath);

  if (!missing && normalizePath(resolvedPath) !== normalizePath(targetPath)) {
    return {
      ok: false,
      code: GUARD_CODES.symlinkTarget,
      message: `该路径是符号链接/junction，真实位置是 ${resolvedPath}，拒绝删除以免误伤链接背后的目录`,
      detail: [resolvedPath],
    };
  }

  if (pathDepth(canonical) < minDepth) {
    return {
      ok: false,
      code: GUARD_CODES.tooShallow,
      message: `路径层级过浅（${canonical}），拒绝删除`,
      detail: [canonical],
    };
  }

  if (!allowRemoteVolume && /^[\\/]{2}[^\\/]/.test(targetPath)) {
    return {
      ok: false,
      code: GUARD_CODES.remoteVolume,
      message: '目标是网络共享路径，递归删除无法可靠完成，拒绝删除',
      detail: [targetPath],
    };
  }

  for (const entry of protectedPaths) {
    if (!entry || typeof entry.path !== 'string' || entry.path === '') continue;
    if (containsPath(canonical, entry.path)) {
      return {
        ok: false,
        code: GUARD_CODES.protectedPath,
        message: `该目录包含受保护位置（${entry.label}：${entry.path}），拒绝删除`,
        detail: [entry.path],
      };
    }
  }

  if (typeof currentSessionCwd === 'string' && currentSessionCwd !== '') {
    if (containsPath(canonical, currentSessionCwd)) {
      return {
        ok: false,
        code: GUARD_CODES.currentSession,
        message:
          '当前对话就工作在这个目录里（或是它的上级）。请先新建或切换到别的会话，再回来删除此工作区。',
        detail: [currentSessionCwd],
      };
    }
  }

  const nestedWorkspaces = otherWorkspacePaths.filter(
    (candidate) =>
      typeof candidate === 'string' && candidate !== '' && strictlyContainsPath(canonical, candidate),
  );
  if (nestedWorkspaces.length > 0) {
    return {
      ok: false,
      code: GUARD_CODES.nestedWorkspace,
      message: `该目录里还注册着另外 ${nestedWorkspaces.length} 个工作区，删除它会一并毁掉那些项目`,
      detail: nestedWorkspaces,
    };
  }

  const nestedSessions = [...liveSessionCwds, ...storedSessionCwds].filter(
    (candidate) =>
      typeof candidate === 'string' && candidate !== '' && strictlyContainsPath(canonical, candidate),
  );
  if (nestedSessions.length > 0) {
    const unique = [...new Set(nestedSessions)];
    return {
      ok: false,
      code: GUARD_CODES.nestedSession,
      message: `该目录里还有 ${unique.length} 个子目录被其它会话当作工作目录`,
      detail: unique.slice(0, 20),
    };
  }

  return { ok: true, canonical, missing };
}
