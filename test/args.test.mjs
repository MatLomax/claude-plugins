import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCli, parseErrorMessage, forwardArgs, USAGE } from '../lib/args.mjs';

test('parseCli: no flags gives all-false options', () => {
  assert.deepEqual(parseCli([]), { insecure: false, 'no-self-update': false, version: false, help: false });
});

test('parseCli: recognises --insecure, --no-self-update, --version, --help and -h', () => {
  assert.equal(parseCli(['--insecure']).insecure, true);
  assert.equal(parseCli(['--no-self-update'])['no-self-update'], true);
  assert.equal(parseCli(['--no-self-update']).insecure, false);
  assert.equal(parseCli(['--version']).version, true);
  assert.equal(parseCli(['--help']).help, true);
  assert.equal(parseCli(['-h']).help, true);
});

test('parseCli: rejects unknown flags, positionals and values on boolean flags', () => {
  assert.throws(() => parseCli(['--bogus']), (e) => parseErrorMessage(e) === "Unknown option '--bogus'");
  assert.throws(() => parseCli(['foo']), (e) => parseErrorMessage(e) === "Unexpected argument 'foo'");
  assert.throws(() => parseCli(['--insecure=yes']), (e) => parseErrorMessage(e) === "Option '--insecure' does not take an argument");
  assert.throws(() => parseCli(['--self-update']), (e) => parseErrorMessage(e) === "Unknown option '--self-update'");
});

test('forwardArgs: forwards --insecure only, never the print-and-exit flags or --no-self-update', () => {
  assert.deepEqual(forwardArgs(parseCli([])), []);
  assert.deepEqual(forwardArgs(parseCli(['--insecure'])), ['--insecure']);
  assert.deepEqual(forwardArgs(parseCli(['--insecure', '--no-self-update'])), ['--insecure']);
  assert.deepEqual(forwardArgs({ insecure: true, 'no-self-update': true, help: true, version: true }), ['--insecure']);
});

test('USAGE documents every flag', () => {
  for (const flag of ['--insecure', '--no-self-update', '--version', '--help']) assert.match(USAGE, new RegExp(flag));
  assert.match(USAGE, /npx --strict-ssl=false/);
});
