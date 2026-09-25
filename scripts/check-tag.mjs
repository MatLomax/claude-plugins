#!/usr/bin/env node
// Verifies a release tag matches package.json: the tag must be exactly
// `v<version>`. Usage: node scripts/check-tag.mjs [tag]  (defaults to
// $GITHUB_REF_NAME). Exits non-zero on a mismatch or a missing tag.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkTag(tag, version) {
  if (!tag) return { ok: false, message: 'no tag given (pass one or set GITHUB_REF_NAME)' };
  if (!version) return { ok: false, message: 'package.json has no version' };
  const expected = `v${version}`;
  if (tag !== expected) return { ok: false, message: `tag ${tag} does not match package.json version (expected ${expected})` };
  return { ok: true, message: `tag ${tag} matches package.json version ${version}` };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const res = checkTag(process.argv[2] ?? process.env.GITHUB_REF_NAME, version);
  (res.ok ? console.log : console.error)(res.message);
  process.exit(res.ok ? 0 : 1);
}
