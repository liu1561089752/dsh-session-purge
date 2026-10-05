/**
 * Unit tests for the pure guard/path layer. Run: `node --test test/`.
 * These are the rules that stand between the plugin and a destroyed project,
 * so they are tested without any Harness in the loop.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { evaluateFolderGuards, GUARD_CODES } from '../lib/guards.js';
import {
  containsPath,
  normalizePath,
  pathDepth,
  samePath,
  strictlyContainsPath,
} from '../lib/paths.js';

const WINDOWS = process.platform === 'win32';
const root = WINDOWS ? 'F:\\' : '/';
const project = WINDOWS ? 'F:\\ppt' : '/ppt';
const nested = WINDOWS ? 'F:\\ppt\\sub' : '/ppt/sub';
const sibling = WINDOWS ? 'F:\\other' : '/other';

test('normalizePath folds case on Windows only', () => {
  const value = WINDOWS ? 'F:\\PPT' : '/PPT';
  const expected = WINDOWS ? 'f:\\ppt' : '/PPT';
  assert.equal(normalizePath(value), expected);
});

test('samePath compares resolved locations', () => {
  assert.equal(samePath(project, WINDOWS ? 'F:\\ppt\\' : '/ppt/'), true);
  assert.equal(samePath(project, sibling), false);
});

test('containsPath covers equality and ancestry', () => {
  assert.equal(containsPath(project, project), true);
  assert.equal(containsPath(project, nested), true);
  assert.equal(containsPath(root, project), true);
  assert.equal(containsPath(project, root), false);
  assert.equal(containsPath(project, sibling), false);
});

test('strictlyContainsPath excludes equality (prefix traps)', () => {
  assert.equal(strictlyContainsPath(project, project), false);
  assert.equal(strictlyContainsPath(project, nested), true);
  // F:\ppt must not be treated as containing F:\ppt-archive
  const lookalike = WINDOWS ? 'F:\\ppt-archive' : '/ppt-archive';
  assert.equal(strictlyContainsPath(project, lookalike), false);
});

test('pathDepth counts segments', () => {
  assert.equal(pathDepth(root), 1);
  assert.equal(pathDepth(project), 2);
  assert.equal(pathDepth(nested), 3);
});

function base(overrides = {}) {
  return {
    targetPath: project,
    resolvedPath: project,
    currentSessionCwd: WINDOWS ? 'F:\\work' : '/work',
    otherWorkspacePaths: [sibling],
    liveSessionCwds: [],
    storedSessionCwds: [],
    protectedPaths: [],
    minDepth: 2,
    allowRemoteVolume: false,
    ...overrides,
  };
}

test('a plain standalone project passes', () => {
  const verdict = evaluateFolderGuards(base());
  assert.equal(verdict.ok, true);
  assert.equal(verdict.missing, false);
});

test('a missing folder still passes and is flagged', () => {
  const verdict = evaluateFolderGuards(base({ resolvedPath: undefined }));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.missing, true);
});

test('relative and empty targets are refused', () => {
  assert.equal(evaluateFolderGuards(base({ targetPath: 'ppt' })).code, GUARD_CODES.invalidTarget);
  assert.equal(evaluateFolderGuards(base({ targetPath: '   ' })).code, GUARD_CODES.invalidTarget);
});

test('a symlinked target is refused', () => {
  const real = WINDOWS ? 'F:\\real-project' : '/real-project';
  const verdict = evaluateFolderGuards(base({ resolvedPath: real }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, GUARD_CODES.symlinkTarget);
});

test('drive roots and shallow paths are refused', () => {
  const verdict = evaluateFolderGuards(
    base({ targetPath: root, resolvedPath: root, otherWorkspacePaths: [] }),
  );
  assert.equal(verdict.code, GUARD_CODES.tooShallow);
});

test('a protected ancestor is refused (home, .dsh, install dir, cwd)', () => {
  const home = WINDOWS ? 'F:\\Users\\me' : '/Users/me';
  // Deleting F:\Users\me\projects would destroy the protected home? No: the rule
  // is "target contains a protected location", so the dangerous case is the
  // target being an ancestor of the protected path.
  const verdict = evaluateFolderGuards(
    base({
      targetPath: WINDOWS ? 'F:\\Users' : '/Users',
      resolvedPath: WINDOWS ? 'F:\\Users' : '/Users',
      protectedPaths: [{ label: '用户主目录', path: home }],
      otherWorkspacePaths: [],
    }),
  );
  assert.equal(verdict.code, GUARD_CODES.protectedPath);
});

test('a sibling of a protected path is allowed', () => {
  const home = WINDOWS ? 'F:\\Users\\me' : '/Users/me';
  const verdict = evaluateFolderGuards(
    base({ protectedPaths: [{ label: '用户主目录', path: home }] }),
  );
  assert.equal(verdict.ok, true);
});

test('the current session working directory is refused, equal or ancestor', () => {
  assert.equal(
    evaluateFolderGuards(base({ currentSessionCwd: project })).code,
    GUARD_CODES.currentSession,
  );
  assert.equal(
    evaluateFolderGuards(base({ currentSessionCwd: nested })).code,
    GUARD_CODES.currentSession,
  );
  // A different project is fine.
  assert.equal(
    evaluateFolderGuards(base({ currentSessionCwd: sibling })).ok,
    true,
  );
});

test('a nested foreign workspace is refused and reported', () => {
  const verdict = evaluateFolderGuards(base({ otherWorkspacePaths: [nested] }));
  assert.equal(verdict.code, GUARD_CODES.nestedWorkspace);
  assert.deepEqual(verdict.detail, [nested]);
});

test('nested foreign session cwds are refused', () => {
  const verdict = evaluateFolderGuards(base({ storedSessionCwds: [nested] }));
  assert.equal(verdict.code, GUARD_CODES.nestedSession);
  const live = evaluateFolderGuards(base({ liveSessionCwds: [nested] }));
  assert.equal(live.code, GUARD_CODES.nestedSession);
});

test('the workspace own sessions (cwd equal to target) do not trip nesting', () => {
  const verdict = evaluateFolderGuards(
    base({ liveSessionCwds: [project], storedSessionCwds: [project] }),
  );
  assert.equal(verdict.ok, true);
});

test('UNC shares are refused unless explicitly allowed', () => {
  const unc = '\\\\server\\share\\proj';
  assert.equal(
    evaluateFolderGuards(base({ targetPath: unc, resolvedPath: unc })).code,
    GUARD_CODES.remoteVolume,
  );
  assert.equal(
    evaluateFolderGuards(
      base({ targetPath: unc, resolvedPath: unc, allowRemoteVolume: true, otherWorkspacePaths: [] }),
    ).ok,
    true,
  );
});

test('lookalike prefixes are not mistaken for nesting', () => {
  const lookalike = WINDOWS ? 'F:\\ppt-archive' : '/ppt-archive';
  const verdict = evaluateFolderGuards(base({ otherWorkspacePaths: [lookalike] }));
  assert.equal(verdict.ok, true);
});

test('path separator differences across platforms are tolerated', () => {
  const mixed = WINDOWS ? 'F:/ppt/sub' : '/ppt/sub';
  assert.equal(strictlyContainsPath(project, mixed), true);
  assert.equal(path.normalize(mixed).length > 0, true);
});
