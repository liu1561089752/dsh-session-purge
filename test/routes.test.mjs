/**
 * Route-level tests for the plugin entry: the platform request fence, method
 * and body validation, and the refusal order. They call the REAL handlers that
 * `apply()` registers, so a change in wiring fails here.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { apply } from '../index.js';

/** Capture the routes `apply()` registers on a fake web server. */
function harness(options = {}) {
  const routes = new Map();
  const connection =
    options.connection === null
      ? undefined
      : {
          requestRejection: options.connection ?? (() => undefined),
        };
  const ctx = {
    get: (key) => {
      if (key === 'connection') return connection;
      if (key === 'workspaceRegistry') return options.registry;
      if (key === 'sessionPersistence') return options.persistence;
      if (key === 'sessions') return { list: () => [], get: () => undefined };
      return undefined;
    },
    logger: { info() {}, warn() {} },
    effect: (fn) => {
      const disposer = fn();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    webServer: {
      register: (route) => {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
  };
  apply(ctx, options.config ?? {});
  return { routes, ctx };
}

/** Minimal ServerResponse stand-in. */
function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    writableEnded: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk) {
      this.body = chunk;
      this.writableEnded = true;
    },
  };
  return res;
}

/** Minimal IncomingMessage stand-in; `body` is JSON text. */
function makeReq({ method = 'POST', url = '/', body = '', headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  const payload = Buffer.from(body, 'utf8');
  return {
    method,
    url,
    headers: { host: '127.0.0.1:3080', ...headers },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      if (payload.length > 0) yield payload;
    },
  };
}

test('all four routes are registered under /api-ext/session-purge', () => {
  const { routes } = harness();
  assert.deepEqual([...routes.keys()].sort(), [
    '/api-ext/session-purge/execute',
    '/api-ext/session-purge/list',
    '/api-ext/session-purge/preview',
    '/api-ext/session-purge/sweep-attachments',
  ]);
  for (const route of routes.values()) assert.equal(route.kind, 'exact');
});

test('the platform fence answers before any handler runs', async () => {
  const { routes } = harness({ connection: () => 401 });
  const route = routes.get('/api-ext/session-purge/execute');
  const res = makeRes();
  await route.handler(makeReq({ body: '{"workspaceId":"ws-1"}' }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body, undefined, 'no envelope leaks past the fence');
});

test('a cross-origin request is refused when the Connection service is absent', async () => {
  const { routes } = harness({ connection: null });
  const route = routes.get('/api-ext/session-purge/list');
  const res = makeRes();
  await route.handler(
    makeReq({ method: 'GET', headers: { origin: 'http://evil.example', host: '127.0.0.1:3080' } }),
    res,
  );
  assert.equal(res.statusCode, 403);
});

test('a non-loopback caller is refused when the Connection service is absent', async () => {
  const { routes } = harness({ connection: null });
  const route = routes.get('/api-ext/session-purge/list');
  const res = makeRes();
  await route.handler(makeReq({ method: 'GET', remoteAddress: '192.168.1.9' }), res);
  assert.equal(res.statusCode, 403);
});

test('wrong methods answer 405 with an Allow header', async () => {
  const { routes } = harness();
  const res = makeRes();
  await routes.get('/api-ext/session-purge/execute').handler(makeReq({ method: 'GET' }), res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, 'POST');
});

test('malformed JSON answers 400', async () => {
  const { routes } = harness();
  const res = makeRes();
  await routes
    .get('/api-ext/session-purge/preview')
    .handler(makeReq({ body: '{not json' }), res);
  assert.equal(res.statusCode, 400);
  assert.match(String(res.body), /invalid-body/);
});

test('a missing workspaceId answers 400', async () => {
  const { routes } = harness();
  const res = makeRes();
  await routes.get('/api-ext/session-purge/preview').handler(makeReq({ body: '{}' }), res);
  assert.equal(res.statusCode, 400);
  assert.match(String(res.body), /invalid-request/);
});

test('execute without confirm is refused before any plan is built', async () => {
  const { routes } = harness();
  const res = makeRes();
  await routes
    .get('/api-ext/session-purge/execute')
    .handler(makeReq({ body: '{"workspaceId":"ws-1"}' }), res);
  assert.equal(res.statusCode, 400);
  assert.match(String(res.body), /confirm-required/);
});

test('an unavailable workspace service degrades to a 409, not a crash', async () => {
  const { routes } = harness();
  const res = makeRes();
  await routes
    .get('/api-ext/session-purge/preview')
    .handler(makeReq({ body: '{"workspaceId":"ws-1"}' }), res);
  assert.equal(res.statusCode, 409);
  assert.match(String(res.body), /service-unavailable/);
});

test('an unknown workspace answers 409 workspace-not-found', async () => {
  const registry = {
    get: () => undefined,
    list: () => [],
    archivedSessionIds: [],
  };
  const { routes } = harness({ registry });
  const res = makeRes();
  await routes
    .get('/api-ext/session-purge/preview')
    .handler(makeReq({ body: '{"workspaceId":"ws-nope"}' }), res);
  assert.equal(res.statusCode, 409);
  assert.match(String(res.body), /workspace-not-found/);
});

test('the standalone sweep refuses to run without an explicit confirmation', async () => {
  const { routes } = harness();
  const res = makeRes();
  await routes.get('/api-ext/session-purge/sweep-attachments').handler(makeReq({ body: '{}' }), res);
  assert.equal(res.statusCode, 400);
  assert.match(String(res.body), /confirm-required/);
});

test('the standalone sweep reports a missing attachment store instead of guessing', async () => {
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sweep-route-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = emptyHome;
  try {
    const { routes } = harness();
    const res = makeRes();
    await routes
      .get('/api-ext/session-purge/sweep-attachments')
      .handler(makeReq({ body: '{"dryRun":true}' }), res);
    assert.equal(res.statusCode, 409);
    assert.match(String(res.body), /no-attachment-store/);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    fs.rmSync(emptyHome, { recursive: true, force: true });
  }
});
