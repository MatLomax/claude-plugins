#!/usr/bin/env node
// Prints one version's section of a Keep a Changelog file, for use as GitHub
// release notes. Usage: node scripts/changelog-notes.mjs <version> [changelog]
// (changelog defaults to CHANGELOG.md at the repo root). The section is the
// body under `## [<version>] - YYYY-MM-DD`, up to the next `## ` heading or
// the trailing link-reference definitions. Exits non-zero if the heading is
// missing or its section is empty.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function extractNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const heading = new RegExp(`^## \\[${escapeRe(version)}\\] - \\d{4}-\\d{2}-\\d{2}\\s*$`);
  const start = lines.findIndex((l) => heading.test(l));
  if (start === -1) throw new Error(`no "## [${version}] - YYYY-MM-DD" heading in the changelog`);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line)) break;
    if (/^\[[^\]]+\]:\s*\S/.test(line)) break; // link reference definitions close the file
    body.push(line);
  }
  const notes = body.join('\n').trim();
  if (!notes) throw new Error(`the changelog section for ${version} is empty`);
  return notes + '\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [version, file] = process.argv.slice(2);
  if (!version) {
    console.error('usage: node scripts/changelog-notes.mjs <version> [changelog]');
    process.exit(2);
  }
  const path = file ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md');
  try {
    process.stdout.write(extractNotes(readFileSync(path, 'utf8'), version));
  } catch (err) {
    console.error(`${path}: ${err.message}`);
    process.exit(1);
  }
}
