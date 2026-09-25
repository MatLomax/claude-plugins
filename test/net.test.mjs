// Real HTTPS round-trips against local servers whose certificates no system
// trust store accepts, the same failure a TLS-intercepting proxy causes.

import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { httpsGet, fetchJson, download } from '../lib/net.mjs';
import { describeError, isCertChainError, TLS_HINT } from '../lib/tls.mjs';
import { selfUpdate } from '../lib/selfupdate.mjs';
import { hasOpenssl, noOpensslReason, makeCerts } from './certs.mjs';

const skip = hasOpenssl ? false : noOpensslReason;

const dir = mkdtempSync(join(tmpdir(), 'claude-plugins-net-'));
const servers = [];

function listen(tls, handler) {
  return new Promise((resolve) => {
    const server = https.createServer(tls, handler);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve(`https://127.0.0.1:${server.address().port}`));
  });
}

let certs, selfUrl, chainUrl, hangUrl;

test.before(async () => {
  if (skip) return;
  certs = makeCerts(dir);
  // The chain server holds the payload; the self-signed server redirects to it,
  // so a redirect chain crosses two hosts with two untrusted certificates.
  chainUrl = await listen(certs.chain, (req, res) => {
    if (req.url === '/release.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tag_name: 'v9.9.9' }));
    } else if (req.url === '/asset.bin') {
      res.end('binary payload');
    } else {
      res.writeHead(404).end();
    }
  });
  selfUrl = await listen(certs.self, (req, res) => {
    if (req.url === '/hop/release.json') res.writeHead(302, { location: `${chainUrl}/release.json` }).end();
    else if (req.url === '/hop/asset.bin') res.writeHead(302, { location: `${chainUrl}/asset.bin` }).end();
    else if (req.url === '/relative') res.writeHead(301, { location: '/direct' }).end();
    else if (req.url === '/direct') res.end('direct');
    else res.writeHead(404).end();
  });
  hangUrl = await listen(certs.self, () => {}); // accepts, never answers
});

test.after(() => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

async function text(res) {
  let body = '';
  for await (const chunk of res) body += chunk;
  return body;
}

test('httpsGet: a self-signed server is rejected with its cert code and the hint', { skip }, async () => {
  const err = await httpsGet(`${selfUrl}/direct`).then(() => null, (e) => e);
  assert.ok(err, 'request must fail without --insecure');
  assert.equal(err.code, 'DEPTH_ZERO_SELF_SIGNED_CERT');
  assert.equal(isCertChainError(err), true);
  assert.ok(describeError(err).endsWith(TLS_HINT));
});

test('httpsGet: an intercepting-style chain is rejected with SELF_SIGNED_CERT_IN_CHAIN', { skip }, async () => {
  const err = await fetchJson(`${chainUrl}/release.json`).then(() => null, (e) => e);
  assert.equal(err && err.code, 'SELF_SIGNED_CERT_IN_CHAIN');
  assert.match(describeError(err), /intercepting HTTPS[\s\S]*NODE_EXTRA_CA_CERTS[\s\S]*--insecure/);
});

test('httpsGet: insecure succeeds, including a relative redirect', { skip }, async () => {
  const res = await httpsGet(`${selfUrl}/relative`, { insecure: true });
  assert.equal(res.statusCode, 200);
  assert.equal(await text(res), 'direct');
});

test('fetchJson + download: insecure carries across a redirect to a second untrusted host', { skip }, async () => {
  assert.deepEqual(await fetchJson(`${selfUrl}/hop/release.json`, { insecure: true }), { tag_name: 'v9.9.9' });
  const dest = join(dir, 'asset.bin');
  await download(`${selfUrl}/hop/asset.bin`, dest, { insecure: true });
  assert.equal(readFileSync(dest, 'utf8'), 'binary payload');
});

test('httpsGet: insecure is per-request, never process-wide', { skip }, async () => {
  await text(await httpsGet(`${selfUrl}/direct`, { insecure: true }));
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  const err = await httpsGet(`${selfUrl}/direct`).then(() => null, (e) => e);
  assert.equal(err && err.code, 'DEPTH_ZERO_SELF_SIGNED_CERT');
});

test('download: a cert failure surfaces with the hint', { skip }, async () => {
  const err = await download(`${selfUrl}/hop/asset.bin`, join(dir, 'never.bin')).then(() => null, (e) => e);
  assert.match(describeError(err), /DEPTH_ZERO_SELF_SIGNED_CERT[\s\S]*--insecure/);
});

function recordingSpawn() {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    setImmediate(() => child.emit('exit', 0, null));
    return child;
  };
  return { spawn, calls };
}

test('selfUpdate over real HTTPS: --insecure reads the release through a redirect and relaunches', { skip }, async () => {
  const { spawn, calls } = recordingSpawn();
  const r = await selfUpdate({
    ownVersion: '1.0.0',
    cli: { insecure: true },
    fetchJson,
    spawn,
    env: {},
    platform: 'linux',
    out: () => {},
    url: `${selfUrl}/hop/release.json`,
  });
  assert.deepEqual(r, { action: 'exit', code: 0 });
  assert.deepEqual(calls[0].args, ['-y', 'https://github.com/MatLomax/claude-plugins/releases/download/v9.9.9/claude-plugins-9.9.9.tgz', '--insecure']);
});

test('selfUpdate over real HTTPS: a cert failure fails open', { skip }, async () => {
  const { spawn, calls } = recordingSpawn();
  const r = await selfUpdate({ ownVersion: '1.0.0', cli: { insecure: false }, fetchJson, spawn, env: {}, out: () => {}, url: `${selfUrl}/hop/release.json` });
  assert.deepEqual(r, { action: 'continue' });
  assert.equal(calls.length, 0);
});

test('selfUpdate over real HTTPS: a 404 fails open', { skip }, async () => {
  const { spawn, calls } = recordingSpawn();
  const r = await selfUpdate({ ownVersion: '1.0.0', cli: { insecure: true }, fetchJson, spawn, env: {}, out: () => {}, url: `${chainUrl}/missing` });
  assert.deepEqual(r, { action: 'continue' });
  assert.equal(calls.length, 0);
});

test('selfUpdate over real HTTPS: a server that never answers times out and fails open', { skip }, async () => {
  const { spawn, calls } = recordingSpawn();
  const started = Date.now();
  const r = await selfUpdate({ ownVersion: '1.0.0', cli: { insecure: true }, fetchJson, spawn, env: {}, out: () => {}, url: `${hangUrl}/x`, timeoutMs: 300 });
  assert.deepEqual(r, { action: 'continue' });
  assert.equal(calls.length, 0);
  assert.ok(Date.now() - started < 3000, 'the timeout bounds the check');
});
