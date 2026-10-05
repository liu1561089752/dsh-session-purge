/**
 * Integration tests for the destructive orchestration, run against a temporary
 * sandbox with a fake Harness. They assert the real filesystem effects: what
 * gets deleted, what survives, and what the guards refuse.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { zstdCompressSync } from 'node:zlib';

import { executePurge } from '../lib/execute.js';
import { buildPlan } from '../lib/harness.js';
import { GUARD_CODES } from '../lib/guards.js';
import { collectAttachmentUsage, sweepAttachments } from '../lib/attachments.js';

const HASH_KEPT = 'a'.repeat(64);
const HASH_DEAD = 'b'.repeat(64);

/** Build a sandbox that looks like a DSH home plus a separate project. */
function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-purge-test-'));
  const dshHome = path.join(root, '.dsh');
  const project = path.join(root, 'standalone-project');
  const sessionsRoot = path.join(dshHome, 'sessions');
  const projectKeyDir = path.join(sessionsRoot, '--standalone-project--');
  const sessionDir = path.join(projectKeyDir, 'session-aaa');
  const otherSessionDir = path.join(sessionsRoot, '--elsewhere--', 'session-bbb');
  const cacheDir = path.join(dshHome, 'storages', 'session_projcache', 'sessions');
  const attachments = path.join(dshHome, 'attachments', 'v1');

  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(otherSessionDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(path.join(attachments, 'objects', HASH_KEPT.slice(0, 2)), { recursive: true });
  fs.mkdirSync(path.join(attachments, 'objects', HASH_DEAD.slice(0, 2)), { recursive: true });
  fs.mkdirSync(path.join(attachments, 'files', HASH_KEPT.slice(0, 2), HASH_KEPT), { recursive: true });
  fs.mkdirSync(path.join(attachments, 'tmp'), { recursive: true });
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });

  const projectLog = path.join(sessionDir, 'session.v4.jsonl.zstd');
  const otherLog = path.join(otherSessionDir, 'session.v4.jsonl.zstd');
  // The raw artifacts carry the reference too: a real non-live session's events
  // are on disk, so both the API path and the byte-scan fallback must see it.
  fs.writeFileSync(projectLog, `{"text":"see ${HASH_KEPT}"}`);
  fs.writeFileSync(otherLog, `{"text":"see ${HASH_KEPT}"}`);
  fs.writeFileSync(path.join(cacheDir, 'session-aaa.json'), '{"k":1}');
  fs.writeFileSync(path.join(attachments, 'objects', HASH_KEPT.slice(0, 2), HASH_KEPT), 'kept');
  fs.writeFileSync(path.join(attachments, 'files', HASH_KEPT.slice(0, 2), HASH_KEPT, 'note.txt'), 'kept');
  fs.writeFileSync(path.join(attachments, 'objects', HASH_DEAD.slice(0, 2), HASH_DEAD), 'dead');
  fs.writeFileSync(path.join(attachments, 'tmp', 'scratch'), 'tmp');
  fs.writeFileSync(path.join(project, 'README.md'), '# project');
  fs.writeFileSync(path.join(project, 'src', 'index.js'), 'console.log(1)');

  return {
    root,
    dshHome,
    project,
    sessionsRoot,
    projectKeyDir,
    sessionDir,
    otherSessionDir,
    cacheDir,
    attachments,
    projectLog,
    otherLog,
  };
}

/** Fake Harness context: only the surface this plugin touches. */
function makeCtx(sandbox, overrides = {}) {
  const deleted = [];
  const archived = [];
  const detached = [];
  const workspace = {
    id: 'ws-1',
    title: 'standalone-project',
    path: sandbox.project,
    sessionIds: ['session-aaa'],
    detachSession: async (id) => {
      detached.push(id);
    },
    status: async () => 'ok',
  };
  const logs = new Map([
    [
      'session-aaa',
      {
        path: sandbox.projectLog,
        meta: { id: 'session-aaa', cwd: sandbox.project },
        events: [{ type: 'user/message', data: { text: 'hello' } }],
      },
    ],
    [
      'session-bbb',
      {
        path: sandbox.otherLog,
        meta: { id: 'session-bbb', cwd: path.join(sandbox.root, 'elsewhere') },
        events: [{ type: 'user/message', data: { text: `see ${HASH_KEPT}` } }],
      },
    ],
  ]);
  const registry = {
    get: (id) => (id === workspace.id ? workspace : undefined),
    list: () => [workspace],
    delete: async (id) => {
      deleted.push(id);
      return true;
    },
    archiveSession: async (id) => {
      archived.push(id);
      if (!logs.has(id)) throw new Error(`unknown session ${id}`);
    },
    unarchiveSession: async () => {},
    archivedSessionIds: [],
    pinnedSessionIds: [],
  };
  const persistence = {
    list: async () =>
      [...logs.entries()].map(([id, log]) => ({
        header: log.meta,
        sizeBytes: fs.existsSync(log.path) ? fs.statSync(log.path).size : 0,
        id,
      })),
    // `resolveCurrentLog` exists on the shipped JSONL backend but NOT on the
    // SessionPersistence service contract; `readStoredLog` exists on neither.
    // The plugin must therefore work with or without the former and never use
    // the latter.
    resolveCurrentLog: async (id) => (fs.existsSync(logs.get(id)?.path ?? '') ? logs.get(id).path : undefined),
    open: async (id, access) => {
      const log = logs.get(id);
      if (!log || !fs.existsSync(log.path)) throw new Error(`no such session ${id}`);
      const events = log.events;
      return {
        id,
        access,
        header: log.meta,
        read: async (offset = 0, length = events.length) => ({
          events: events.slice(offset, offset + length),
        }),
        close: async () => {},
      };
    },
  };
  const live = [
    { id: 'session-aaa', header: { cwd: sandbox.project } },
  ];
  const ctx = {
    get: (key) => {
      if (key === 'workspaceRegistry') return registry;
      if (key === 'sessionPersistence') return persistence;
      if (key === 'sessions') return { list: () => live, get: (id) => live.find((s) => s.id === id) };
      return undefined;
    },
    logger: { info() {}, warn() {} },
    effect: (fn) => {
      const disposer = fn();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    ...overrides,
  };
  return { ctx, registry, persistence, workspace, deleted, archived, detached, logs, live };
}

function planFor(harness, options = {}) {
  return buildPlan(harness.ctx, 'ws-1', {
    config: { deleteProjectFolder: true, requireFolderNameConfirm: false, ...options.config },
    currentSessionCwd: options.currentSessionCwd,
  });
}

test('plan finds the workspace sessions by cwd, the cache file and the folder', async () => {
  const sandbox = makeSandbox();
  const harness = makeCtx(sandbox);
  const built = await planFor(harness, { currentSessionCwd: path.join(sandbox.root, 'somewhere-else') });
  assert.equal(built.ok, true);
  assert.equal(built.plan.sessions.length, 1);
  assert.equal(built.plan.sessions[0].id, 'session-aaa');
  assert.equal(built.plan.cacheFiles.length, 1);
  assert.equal(built.plan.folderExists, true);
  assert.equal(built.plan.guards.ok, true);
  assert.equal(built.plan.sessionsBytes, fs.statSync(sandbox.projectLog).size);
  assert.equal(built.plan.dshHome, sandbox.dshHome);
});

test('execute deletes sessions, cache, registry row, folder and dead attachments', async () => {
  const sandbox = makeSandbox();
  const harness = makeCtx(sandbox);
  const built = await planFor(harness, { currentSessionCwd: path.join(sandbox.root, 'elsewhere') });
  const result = await executePurge(harness.ctx, built.plan, {
    config: { deleteProjectFolder: true, requireFolderNameConfirm: false },
    attachments: true,
    dryRun: false,
  });

  assert.deepEqual(result.deletedSessions, ['session-aaa']);
  assert.equal(result.registryDeleted, true);
  assert.deepEqual(harness.deleted, ['ws-1']);
  assert.deepEqual(harness.archived, ['session-aaa']);
  assert.deepEqual(harness.detached, ['session-aaa']);

  // Filesystem truth.
  assert.equal(fs.existsSync(sandbox.sessionDir), false, 'session dir removed');
  assert.equal(fs.existsSync(path.join(sandbox.cacheDir, 'session-aaa.json')), false, 'cache removed');
  assert.equal(fs.existsSync(sandbox.project), false, 'project folder removed');
  assert.equal(fs.existsSync(sandbox.projectKeyDir), false, 'empty project key dir pruned');
  assert.equal(fs.existsSync(sandbox.otherSessionDir), true, 'other session untouched');

  // Attachments: only the unreferenced object and tmp are gone.
  assert.equal(fs.existsSync(path.join(sandbox.attachments, 'objects', HASH_DEAD.slice(0, 2), HASH_DEAD)), false);
  assert.equal(fs.existsSync(path.join(sandbox.attachments, 'objects', HASH_KEPT.slice(0, 2), HASH_KEPT)), true);
  assert.equal(
    fs.existsSync(path.join(sandbox.attachments, 'files', HASH_KEPT.slice(0, 2), HASH_KEPT, 'note.txt')),
    true,
    'referenced file attachment kept',
  );
  assert.equal(fs.readdirSync(path.join(sandbox.attachments, 'tmp')).length, 0, 'tmp cleared');
  assert.equal(result.attachments.removedObjects, 1);
  assert.equal(result.failed.length, 0);
});

test('the current session working inside the folder is refused', async () => {
  const sandbox = makeSandbox();
  const harness = makeCtx(sandbox);
  const built = await planFor(harness, { currentSessionCwd: sandbox.project });
  assert.equal(built.ok, true);
  assert.equal(built.plan.guards.ok, false);
  assert.equal(built.plan.guards.code, GUARD_CODES.currentSession);

  const result = await executePurge(harness.ctx, built.plan, {
    config: { deleteProjectFolder: true, requireFolderNameConfirm: false },
    dryRun: false,
  });
  assert.equal(fs.existsSync(sandbox.project), true, 'nothing deleted when a guard refuses');
  assert.equal(result.folderDeleted, false);
  assert.equal(result.deletedSessions.length, 0);
});

test('a dry run changes nothing', async () => {
  const sandbox = makeSandbox();
  const harness = makeCtx(sandbox);
  const built = await planFor(harness, { currentSessionCwd: path.join(sandbox.root, 'elsewhere') });
  const result = await executePurge(harness.ctx, built.plan, {
    config: { deleteProjectFolder: true, requireFolderNameConfirm: false },
    attachments: true,
    dryRun: true,
  });
  assert.equal(result.dryRun, true);
  assert.equal(fs.existsSync(sandbox.sessionDir), true);
  assert.equal(fs.existsSync(sandbox.project), true);
  assert.equal(fs.existsSync(path.join(sandbox.attachments, 'objects', HASH_DEAD.slice(0, 2), HASH_DEAD)), true);
  assert.equal(harness.deleted.length, 0);
  assert.equal(result.attachments.dryRun, true);
  assert.equal(result.attachments.removedObjects, 1, 'dry run still reports what it would remove');
});

test('the typed folder name gates the folder deletion', async () => {
  const sandbox = makeSandbox();
  const harness = makeCtx(sandbox);
  const built = await planFor(harness, { currentSessionCwd: path.join(sandbox.root, 'elsewhere') });

  const wrong = await executePurge(harness.ctx, built.plan, {
    config: { deleteProjectFolder: true, requireFolderNameConfirm: true },
    folderName: 'not-the-name',
    dryRun: false,
  });
  assert.equal(wrong.folderDeleted, false);
  assert.equal(fs.existsSync(sandbox.project), true);

  const sandbox2 = makeSandbox();
  const harness2 = makeCtx(sandbox2);
  const built2 = await planFor(harness2, { currentSessionCwd: path.join(sandbox2.root, 'elsewhere') });
  const right = await executePurge(harness2.ctx, built2.plan, {
    config: { deleteProjectFolder: true, requireFolderNameConfirm: true },
    folderName: 'standalone-project',
    dryRun: false,
  });
  assert.equal(right.folderDeleted, true);
  assert.equal(fs.existsSync(sandbox2.project), false);
});

test('deleteProjectFolder:false keeps the folder but purges DSH state', async () => {
  const sandbox = makeSandbox();
  const harness = makeCtx(sandbox);
  const built = await planFor(harness, { currentSessionCwd: path.join(sandbox.root, 'elsewhere') });
  const result = await executePurge(harness.ctx, built.plan, {
    config: { deleteProjectFolder: false, requireFolderNameConfirm: false },
    dryRun: false,
  });
  assert.equal(result.folderDeleted, false);
  assert.equal(fs.existsSync(sandbox.project), true);
  assert.equal(fs.existsSync(sandbox.sessionDir), false);
  assert.equal(result.deletedSessions.length, 1);
});

test('an uppercase reference still protects the object', async () => {
  const sandbox = makeSandbox();
  const harness = makeCtx(sandbox);
  // Hash tokens recorded in uppercase must still count as references, or a live
  // attachment could be swept away by a case-sensitive match.
  const upper = HASH_KEPT.toUpperCase();
  harness.logs.get('session-bbb').events = [{ type: 'user/message', data: { text: `see ${upper}` } }];
  fs.writeFileSync(sandbox.otherLog, `{"text":"see ${upper}"}`);
  harness.logs.get('session-aaa').events = [];

  const built = await planFor(harness, { currentSessionCwd: path.join(sandbox.root, 'elsewhere') });
  const result = await executePurge(harness.ctx, built.plan, {
    config: { deleteProjectFolder: true, requireFolderNameConfirm: false },
    attachments: true,
    dryRun: false,
  });
  assert.equal(result.attachments.ok, true);
  assert.equal(
    fs.existsSync(path.join(sandbox.attachments, 'objects', HASH_KEPT.slice(0, 2), HASH_KEPT)),
    true,
    'a case-insensitive mark keeps the object',
  );
});

test('the standalone sweep really deletes only unreferenced attachments', async () => {
  const sandbox = makeSandbox();
  const harness = makeCtx(sandbox);
  const usage = await collectAttachmentUsage(harness.ctx, new Set());
  assert.equal(usage.ok, true, 'the mark step covers every stored session');
  assert.equal(usage.referenced.has(HASH_KEPT), true, 'the referenced hash is in the mark set');

  const outcome = await sweepAttachments(
    { attachmentsRoot: sandbox.attachments, cacheRoot: path.join(sandbox.dshHome, 'cache', 'attachments') },
    usage.referenced,
    { dryRun: false },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.removedObjects >= 1, true, 'the orphan object went');
  assert.equal(
    fs.existsSync(path.join(sandbox.attachments, 'objects', HASH_DEAD.slice(0, 2), HASH_DEAD)),
    false,
    'an object no session references is deleted',
  );
  assert.equal(
    fs.existsSync(path.join(sandbox.attachments, 'objects', HASH_KEPT.slice(0, 2), HASH_KEPT)),
    true,
    'a referenced object survives',
  );
  assert.equal(
    fs.existsSync(path.join(sandbox.attachments, 'files', HASH_KEPT.slice(0, 2), HASH_KEPT, 'note.txt')),
    true,
    'the named-file store survives alongside its object',
  );
  assert.equal(fs.existsSync(path.join(sandbox.attachments, 'tmp', 'scratch')), false, 'tmp is cleared');
});

test('a broken remaining session log blocks the attachment sweep', async () => {
  const sandbox = makeSandbox();
  const harness = makeCtx(sandbox);
  // Make the OTHER session unreadable: the mark step must abort rather than
  // risk deleting an attachment that session still references.
  const baseOpen = harness.persistence.open;
  harness.persistence.open = async (id, access) => ({
    ...(await baseOpen(id, access)),
    read: async () => {
      throw new Error('corrupt');
    },
  });
  const built = await planFor(harness, { currentSessionCwd: path.join(sandbox.root, 'elsewhere') });
  const result = await executePurge(harness.ctx, built.plan, {
    config: { deleteProjectFolder: true, requireFolderNameConfirm: false },
    attachments: true,
    dryRun: false,
  });
  assert.equal(result.attachments.ok, false);
  assert.equal(result.attachments.code, 'mark-incomplete');
  assert.equal(result.attachments.blocked.length >= 1, true, 'the blocking session is reported');
  assert.equal(
    Object.keys(result.attachments.reasons).some((key) => key.startsWith('read-failed')),
    true,
    'the reason is a read failure, not a silent skip',
  );
  assert.equal(
    fs.existsSync(path.join(sandbox.attachments, 'objects', HASH_DEAD.slice(0, 2), HASH_DEAD)),
    true,
    'nothing swept when the mark is incomplete',
  );
  assert.equal(result.folderDeleted, true, 'the rest of the purge still ran');
});

test('without the public open(), a readable raw artifact still marks conservatively', async () => {
  const sandbox = makeSandbox();
  const harness = makeCtx(sandbox);
  delete harness.persistence.open;
  const built = await planFor(harness, { currentSessionCwd: path.join(sandbox.root, 'elsewhere') });
  const result = await executePurge(harness.ctx, built.plan, {
    config: { deleteProjectFolder: true, requireFolderNameConfirm: false },
    attachments: true,
    dryRun: false,
  });
  assert.equal(result.attachments.ok, true, 'the byte scan stands in for the missing API');
  assert.equal(result.attachments.removedObjects >= 1, true, 'the dead object is reclaimed');
  assert.equal(
    fs.existsSync(path.join(sandbox.attachments, 'objects', HASH_KEPT.slice(0, 2), HASH_KEPT)),
    true,
    'a hash found only by the byte scan keeps the object',
  );
});

test('a zstd-compressed raw artifact is decoded by the fallback', async () => {
  const sandbox = makeSandbox();
  const harness = makeCtx(sandbox);
  delete harness.persistence.open;
  // The reference exists ONLY inside the compressed artifact.
  harness.logs.get('session-bbb').events = [];
  fs.writeFileSync(sandbox.otherLog, zstdCompressSync(Buffer.from(`{"text":"see ${HASH_KEPT}"}`)));

  const built = await planFor(harness, { currentSessionCwd: path.join(sandbox.root, 'elsewhere') });
  const result = await executePurge(harness.ctx, built.plan, {
    config: { deleteProjectFolder: true, requireFolderNameConfirm: false },
    attachments: true,
    dryRun: false,
  });
  assert.equal(result.attachments.ok, true);
  assert.equal(
    fs.existsSync(path.join(sandbox.attachments, 'objects', HASH_KEPT.slice(0, 2), HASH_KEPT)),
    true,
    'the zstd frame was inflated before scanning',
  );
});

test('an unidentified binary artifact blocks rather than under-marking', async () => {
  const sandbox = makeSandbox();
  const harness = makeCtx(sandbox);
  delete harness.persistence.open;
  harness.logs.get('session-bbb').events = [];
  // Compressed bytes read as text would mark nothing and silently endanger live
  // attachments, so an artifact this plugin cannot decode must abort the sweep.
  fs.writeFileSync(sandbox.otherLog, Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x07]));

  const built = await planFor(harness, { currentSessionCwd: path.join(sandbox.root, 'elsewhere') });
  const result = await executePurge(harness.ctx, built.plan, {
    config: { deleteProjectFolder: true, requireFolderNameConfirm: false },
    attachments: true,
    dryRun: false,
  });
  assert.equal(result.attachments.ok, false);
  assert.equal(
    Object.keys(result.attachments.reasons).some((key) => key.includes('undecodable')),
    true,
    'the reason names the artifact it refused to guess about',
  );
  assert.equal(
    fs.existsSync(path.join(sandbox.attachments, 'objects', HASH_DEAD.slice(0, 2), HASH_DEAD)),
    true,
    'nothing swept when the mark is incomplete',
  );
});

test('the fallback matches a bare-UUID directory to a session- prefixed id', async () => {
  const sandbox = makeSandbox();
  const harness = makeCtx(sandbox);
  delete harness.persistence.open;
  // Older stores name the directory with a bare UUID while the id carries the
  // `session-` prefix; the index must bridge both spellings.
  const bare = path.join(sandbox.sessionsRoot, '--elsewhere--', 'bbb');
  fs.mkdirSync(bare, { recursive: true });
  fs.writeFileSync(path.join(bare, 'session.jsonl.zstd'), `{"text":"see ${HASH_KEPT}"}`);
  harness.logs.set('bbb', { meta: { id: 'bbb', cwd: path.join(sandbox.root, 'elsewhere') }, path: path.join(bare, 'session.jsonl.zstd'), events: [] });
  harness.logs.delete('session-bbb');
  harness.persistence.list = async () =>
    [...harness.logs.entries()].map(([id, log]) => ({ header: log.meta, sizeBytes: 1, id }));

  const built = await planFor(harness, { currentSessionCwd: path.join(sandbox.root, 'elsewhere') });
  const result = await executePurge(harness.ctx, built.plan, {
    config: { deleteProjectFolder: true, requireFolderNameConfirm: false },
    attachments: true,
    dryRun: false,
  });
  assert.equal(result.attachments.ok, true, 'the bare directory was found');
  assert.equal(
    fs.existsSync(path.join(sandbox.attachments, 'objects', HASH_KEPT.slice(0, 2), HASH_KEPT)),
    true,
    'the reference in the bare directory kept the object',
  );
});

test('the raw fallback refuses to speak for a live session', async () => {
  const sandbox = makeSandbox();
  const harness = makeCtx(sandbox);
  delete harness.persistence.open;
  // A live session may hold buffered events that are not on disk yet, so a byte
  // scan could under-mark and endanger a live attachment.
  harness.live.push({ id: 'session-bbb', header: { cwd: path.join(sandbox.root, 'elsewhere') } });

  const built = await planFor(harness, { currentSessionCwd: path.join(sandbox.root, 'elsewhere') });
  const result = await executePurge(harness.ctx, built.plan, {
    config: { deleteProjectFolder: true, requireFolderNameConfirm: false },
    attachments: true,
    dryRun: false,
  });
  assert.equal(result.attachments.ok, false);
  assert.equal(result.attachments.code, 'mark-incomplete');
  assert.deepEqual(result.attachments.reasons, { 'persistence-unavailable:live-session': 1 });
  assert.equal(
    fs.existsSync(path.join(sandbox.attachments, 'objects', HASH_DEAD.slice(0, 2), HASH_DEAD)),
    true,
    'nothing swept when the mark is incomplete',
  );
});

test('without open() and without an artifact, the sweep is skipped rather than guessed', async () => {
  const sandbox = makeSandbox();
  const harness = makeCtx(sandbox);
  delete harness.persistence.open;
  fs.rmSync(sandbox.otherSessionDir, { recursive: true, force: true });

  const built = await planFor(harness, { currentSessionCwd: path.join(sandbox.root, 'elsewhere') });
  const result = await executePurge(harness.ctx, built.plan, {
    config: { deleteProjectFolder: true, requireFolderNameConfirm: false },
    attachments: true,
    dryRun: false,
  });
  assert.equal(result.attachments.ok, false);
  assert.deepEqual(result.attachments.reasons, { 'persistence-unavailable:dir-unknown': 1 });
  assert.equal(
    fs.existsSync(path.join(sandbox.attachments, 'objects', HASH_DEAD.slice(0, 2), HASH_DEAD)),
    true,
  );
});

test('a dry run reports a runnable sweep without changing anything', async () => {
  const sandbox = makeSandbox();
  const harness = makeCtx(sandbox);
  const built = await planFor(harness, { currentSessionCwd: path.join(sandbox.root, 'elsewhere') });
  const result = await executePurge(harness.ctx, built.plan, {
    config: { deleteProjectFolder: true, requireFolderNameConfirm: false },
    attachments: true,
    dryRun: true,
  });
  assert.equal(result.attachments.ok, true);
  assert.equal(result.attachments.dryRun, true);
  assert.equal(result.attachments.removedObjects >= 1, true, 'the dead object would be reclaimed');
  assert.equal(result.attachments.keptObjects >= 1, true, 'the referenced object would be kept');
  assert.equal(
    fs.existsSync(path.join(sandbox.attachments, 'objects', HASH_DEAD.slice(0, 2), HASH_DEAD)),
    true,
    'a dry run really removes nothing',
  );
});

test('a dry run reports why the attachment sweep would be skipped', async () => {
  const sandbox = makeSandbox();
  const harness = makeCtx(sandbox);
  delete harness.persistence.open;
  const built = await planFor(harness, { currentSessionCwd: path.join(sandbox.root, 'elsewhere') });
  const result = await executePurge(harness.ctx, built.plan, {
    config: { deleteProjectFolder: true, requireFolderNameConfirm: false },
    attachments: true,
    dryRun: true,
  });
  assert.equal(result.attachments.ok, false);
  // A dry run has no session list yet, so it marks against every stored session:
  // the live target cannot be byte-scanned, so it blocks and explains itself.
  assert.deepEqual(result.attachments.reasons, { 'persistence-unavailable:live-session': 1 });
  assert.equal(fs.existsSync(sandbox.project), true, 'a dry run still changes nothing');
});
