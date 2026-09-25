// Test certificates generated with openssl: a self-signed leaf, and a leaf
// signed by a private root CA, which is what a TLS-intercepting proxy presents.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const hasOpenssl = !spawnSync('openssl', ['version']).error;
export const noOpensslReason = 'openssl is not installed, so no test certificate can be generated';

function openssl(dir, args) {
  const r = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`openssl ${args[0]} failed: ${r.stderr}`);
}

// makeCerts writes into dir a self-signed leaf (DEPTH_ZERO_SELF_SIGNED_CERT)
// and a leaf signed by a private root CA whose chain the server sends in full
// (SELF_SIGNED_CERT_IN_CHAIN), both valid for localhost and 127.0.0.1.
export function makeCerts(dir) {
  const san = 'subjectAltName=DNS:localhost,IP:127.0.0.1';
  openssl(dir, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'self.key', '-out', 'self.crt', '-days', '1', '-subj', '/CN=localhost', '-addext', san]);
  openssl(dir, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1', '-subj', '/CN=Test Intercepting Root']);
  openssl(dir, ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=localhost']);
  writeFileSync(join(dir, 'leaf.ext'), san + '\n');
  openssl(dir, ['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.crt', '-days', '1', '-extfile', 'leaf.ext']);
  const read = (f) => readFileSync(join(dir, f), 'utf8');
  return {
    self: { key: read('self.key'), cert: read('self.crt') },
    chain: { key: read('leaf.key'), cert: read('leaf.crt') + read('ca.crt') },
  };
}
