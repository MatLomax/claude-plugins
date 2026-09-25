// The installer's own HTTPS client. Options apply to every hop of a redirect
// chain; `insecure` disables certificate checks on these requests only, never
// process-wide.

import https from 'node:https';
import { createWriteStream } from 'node:fs';

const USER_AGENT = 'claude-plugins-install';
const REDIRECTS = [301, 302, 303, 307, 308];
const MAX_REDIRECTS = 5;

// httpsGet resolves to the response stream, following redirects (GitHub asset
// downloads 302 to a storage host). `signal` aborts the whole chain, including
// a response body still being read.
export function httpsGet(url, { headers = {}, insecure = false, signal } = {}, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > MAX_REDIRECTS) return reject(new Error('too many redirects'));
    const options = { headers: { 'User-Agent': USER_AGENT, ...headers } };
    if (insecure) options.rejectUnauthorized = false;
    if (signal) options.signal = signal;
    https
      .get(url, options, (res) => {
        if (REDIRECTS.includes(res.statusCode) && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          resolve(httpsGet(next, { headers, insecure, signal }, depth + 1));
        } else {
          resolve(res);
        }
      })
      .on('error', reject);
  });
}

export async function fetchJson(url, { insecure = false, signal } = {}) {
  const res = await httpsGet(url, { headers: { Accept: 'application/vnd.github+json' }, insecure, signal });
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`GitHub API returned ${res.statusCode}`);
  }
  let body = '';
  for await (const chunk of res) body += chunk;
  return JSON.parse(body);
}

export async function download(url, dest, { insecure = false } = {}) {
  const res = await httpsGet(url, { insecure });
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`download failed (HTTP ${res.statusCode})`);
  }
  await new Promise((resolve, reject) => {
    const f = createWriteStream(dest);
    res.on('error', reject);
    f.on('error', reject);
    f.on('finish', resolve);
    res.pipe(f);
  });
}
