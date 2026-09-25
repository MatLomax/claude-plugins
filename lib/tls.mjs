// Certificate-chain error detection and the user-facing text for TLS trouble
// and for --insecure runs.

// Node error codes raised when the server's chain does not lead to a trusted
// root, which is what a TLS-intercepting proxy or antivirus produces.
export const CERT_CHAIN_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_UNTRUSTED',
]);

export const TLS_HINT = [
  'Your network is intercepting HTTPS (a corporate proxy or antivirus re-signing traffic with its own certificate). Either:',
  '  - export that root certificate as a PEM file, set NODE_EXTRA_CA_CERTS to its path, and re-run; or',
  '  - re-run the same npx command with --strict-ssl=false before the URL and --insecure after it, keeping any other flags,',
  '    e.g. `npx --strict-ssl=false https://matlomax.com/claude-plugins.tgz --insecure`, to skip certificate checks',
  '    (--strict-ssl=false for npm\'s download of the installer, --insecure for the installer\'s own downloads).',
].join('\n');

export const INSECURE_WARNING = [
  '[!] --insecure: TLS certificate checks are OFF for this installer\'s downloads.',
  '[!] Anyone on the network path can substitute what gets downloaded, and the',
  '[!] SHA-256 checksums arrive over the same unverified connection, so they prove nothing.',
].join('\n');

export function isCertChainError(err) {
  return Boolean(err && CERT_CHAIN_CODES.has(err.code));
}

// describeError renders an error for the user, appending the interception
// hint when it is a certificate-chain failure.
export function describeError(err) {
  const msg = err && err.message ? err.message : String(err);
  if (!isCertChainError(err)) return msg;
  return `${msg} (${err.code})\n${TLS_HINT}`;
}

// integrityLine is the summary line describing how far a downloaded release
// can be trusted.
export function integrityLine({ verified, insecure }) {
  if (insecure) {
    return verified
      ? '[!] certificate checks were off (--insecure): the download matched its SHA-256, but that checksum came over the same unverified connection, so it proves nothing.'
      : '[!] certificate checks were off (--insecure) and the release published no checksum; the download is unverified.';
  }
  return verified
    ? '[ok] downloaded release verified against its published SHA-256.'
    : '[!] the release published no checksum; the download was over HTTPS but not SHA-256-verified.';
}
