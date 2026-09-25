import test from 'node:test';
import assert from 'node:assert/strict';
import { CERT_CHAIN_CODES, isCertChainError, describeError, integrityLine, TLS_HINT } from '../lib/tls.mjs';

function codedError(message, code) {
  return Object.assign(new Error(message), { code });
}

test('isCertChainError: true for each certificate-chain code', () => {
  for (const code of ['SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_UNTRUSTED']) {
    assert.ok(CERT_CHAIN_CODES.has(code));
    assert.equal(isCertChainError(codedError('x', code)), true, code);
  }
});

test('isCertChainError: false for other errors', () => {
  assert.equal(isCertChainError(codedError('refused', 'ECONNREFUSED')), false);
  assert.equal(isCertChainError(codedError('expired', 'CERT_HAS_EXPIRED')), false);
  assert.equal(isCertChainError(new Error('plain')), false);
  assert.equal(isCertChainError(null), false);
});

test('describeError: cert-chain errors carry the code and the interception hint', () => {
  const text = describeError(codedError('self-signed certificate in certificate chain', 'SELF_SIGNED_CERT_IN_CHAIN'));
  assert.match(text, /^self-signed certificate in certificate chain \(SELF_SIGNED_CERT_IN_CHAIN\)\n/);
  assert.ok(text.endsWith(TLS_HINT));
  assert.match(TLS_HINT, /intercepting HTTPS/);
  assert.match(TLS_HINT, /NODE_EXTRA_CA_CERTS/);
  assert.ok(TLS_HINT.includes('re-run the same npx command with --strict-ssl=false before the URL and --insecure after it, keeping any other flags'));
  assert.ok(TLS_HINT.includes('e.g. `npx --strict-ssl=false https://matlomax.com/claude-plugins.tgz --insecure`'));
});

test('describeError: other errors are passed through unchanged', () => {
  assert.equal(describeError(codedError('connect ECONNREFUSED', 'ECONNREFUSED')), 'connect ECONNREFUSED');
  assert.equal(describeError('a string'), 'a string');
});

test('integrityLine: verified claim only when certificate checks were on', () => {
  assert.match(integrityLine({ verified: true, insecure: false }), /^\[ok\] .*verified/);
  assert.match(integrityLine({ verified: false, insecure: false }), /^\[!\] .*no checksum/);
  for (const verified of [true, false]) {
    const line = integrityLine({ verified, insecure: true });
    assert.match(line, /^\[!\] certificate checks were off/);
    assert.doesNotMatch(line, /\[ok\]/);
  }
  assert.match(integrityLine({ verified: true, insecure: true }), /proves nothing/);
});
