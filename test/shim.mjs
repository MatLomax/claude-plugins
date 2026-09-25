// Stand-in tool binaries, a network tripwire and a fake GitHub release server
// for tests that run the real installer flow. A shim is an executable Node script found through PATH like
// the real binary; it answers only the tool's real version probe
// (TOOLS[name].versionArgs) and, for worklog, `init`, and appends every call
// to <dir>/calls.log.

import { writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TOOLS } from '../lib/plugins.mjs';

// writeShim puts an executable `name` in `dir` (POSIX only: the shebang is the
// running node binary). `worklog init` creates ./.worklog/tasks.db in its cwd,
// or with `initFails` prints an error and exits 1. Any other arguments exit 64.
export function writeShim(dir, name, { initFails = false } = {}) {
  const log = join(dir, 'calls.log');
  const src = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)} + ' ' + args.join(' ') + '\\n');
if (args.join(' ') === ${JSON.stringify(TOOLS[name].versionArgs.join(' '))}) {
  console.log(${JSON.stringify(name)} + ' v9.9.9-shim');
} else if (${JSON.stringify(name)} === 'worklog' && args.join(' ') === 'init') {
  if (${JSON.stringify(initFails)}) {
    console.error('worklog: cannot create .worklog/tasks.db: read-only file system');
    process.exit(1);
  }
  fs.mkdirSync('.worklog', { recursive: true });
  fs.writeFileSync('.worklog/tasks.db', '');
  console.log('initialised');
} else {
  process.exit(64);
}
`;
  const file = join(dir, name);
  writeFileSync(file, src, 'utf8');
  chmodSync(file, 0o755);
  return file;
}

// shimCalls returns the calls recorded by the shims in `dir`, one per line.
export function shimCalls(dir) {
  const log = join(dir, 'calls.log');
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
}

// writeNetGuard writes a module for `node --import` that intercepts every
// outgoing socket connection (https, fetch, raw net) before DNS or connect.
//
// Default (hard-fail) mode: the process exits with code 99, printing
// NETWORK-ATTEMPT to stderr.
//
// Record mode (`record` is a file path): the attempt is appended to that file
// as `connect <host>:<port>` and the socket fails with ECONNREFUSED, so the
// code under test sees the network as offline. Every https.get is also
// appended as `get <url>`, which makes the requested path observable.
export function writeNetGuard(dir, { record = null } = {}) {
  const file = join(dir, record ? 'net-record.mjs' : 'net-guard.mjs');
  const src = record
    ? `import net from 'node:net';
import https from 'node:https';
import { appendFileSync } from 'node:fs';
const log = ${JSON.stringify(record)};
const get = https.get;
https.get = function (input, ...rest) {
  appendFileSync(log, 'get ' + String(input && input.href ? input.href : input) + '\\n');
  return get.call(this, input, ...rest);
};
net.Socket.prototype.connect = function (...args) {
  let o = args[0];
  if (Array.isArray(o)) o = o[0];
  const host = o && typeof o === 'object' ? o.host || o.path : args[1];
  const port = o && typeof o === 'object' ? o.port : o;
  appendFileSync(log, 'connect ' + host + ':' + port + '\\n');
  process.nextTick(() => {
    const err = new Error('connect ECONNREFUSED ' + host + ' (network disabled by the test)');
    err.code = 'ECONNREFUSED';
    this.destroy(err);
  });
  return this;
};
`
    : `import net from 'node:net';
net.Socket.prototype.connect = function () {
  process.stderr.write('NETWORK-ATTEMPT\\n');
  process.exit(99);
};
`;
  writeFileSync(file, src, 'utf8');
  return file;
}

// netRecord returns the lines a record-mode guard wrote to `file`.
export function netRecord(file) {
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
}

// writeFakeRelease writes a module for `node --import` that answers the
// installer's https.get calls from `routes`, a map of URL to { json } (served
// as the JSON body) or { file } (served as that file's bytes), each with
// status 200. A request for any other URL fails with ECONNREFUSED, and any
// real outgoing socket connection exits the process with code 99, printing
// NETWORK-ATTEMPT to stderr.
export function writeFakeRelease(dir, routes) {
  const file = join(dir, 'fake-release.mjs');
  const src = `import https from 'node:https';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
const routes = ${JSON.stringify(routes)};
https.get = function (input, options, cb) {
  if (typeof options === 'function') cb = options;
  const url = String(input && input.href ? input.href : input);
  const req = new EventEmitter();
  process.nextTick(() => {
    const route = routes[url];
    if (!route) {
      const err = new Error('connect ECONNREFUSED (no fake route for ' + url + ')');
      err.code = 'ECONNREFUSED';
      req.emit('error', err);
      return;
    }
    const body = 'json' in route ? Buffer.from(JSON.stringify(route.json)) : readFileSync(route.file);
    const res = Readable.from([body]);
    res.statusCode = 200;
    res.headers = {};
    cb(res);
  });
  return req;
};
net.Socket.prototype.connect = function () {
  process.stderr.write('NETWORK-ATTEMPT\\n');
  process.exit(99);
};
`;
  writeFileSync(file, src, 'utf8');
  return file;
}
