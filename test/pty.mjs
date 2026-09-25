// A pseudo-terminal for tests that drive the interactive installer as a real
// process. python3's `pty` module relays between the test and a pty whose
// window size is fixed (a pty's default 0x0 size makes clack wrap every
// character): the test writes keystrokes to the relay's stdin, and everything
// the program draws arrives on the relay's stdout.

import { spawn, spawnSync } from 'node:child_process';

// The relay: opens a pty sized 50 rows x 200 columns, starts argv on it as the
// session leader with the pty as its controlling terminal, copies stdin to the
// pty and the pty to stdout until the program closes it, then exits with the
// program's exit code (128 + signal number when it was killed).
const RELAY = `
import fcntl, os, select, struct, subprocess, sys, termios
master, slave = os.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 200, 0, 0))
def controlling():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)
proc = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, preexec_fn=controlling, close_fds=True)
os.close(slave)
inputs = [master, 0]
while True:
    ready, _, _ = select.select(inputs, [], [])
    if 0 in ready:
        data = os.read(0, 4096)
        if data:
            os.write(master, data)
        else:
            inputs.remove(0)
    if master in ready:
        try:
            data = os.read(master, 4096)
        except OSError:
            data = b''
        if not data:
            break
        os.write(1, data)
code = proc.wait()
sys.exit(code if code >= 0 else 128 - code)
`;

// python3Path returns the absolute path of a python3 whose `pty` module works,
// or null. The children run with a PATH of shims only, so the relay is started
// by absolute path.
export function python3Path() {
  const r = spawnSync('python3', ['-c', 'import pty, termios, fcntl, sys; print(sys.executable)'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return r.stdout.trim() || null;
}

// ANSI escape sequences (colours, cursor moves, erases) and the hide/show
// cursor codes clack draws with.
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b[()][A-Za-z0-9]|\u001b[=>78]/g;

// runInPty starts `argv` (argv[0] an absolute path) on a pseudo-terminal and
// returns a handle: `waitFor(pattern)` resolves once the screen output seen so
// far, with ANSI codes stripped, matches; `write(keys)` types keys; `exit`
// resolves to { code, output } when the program ends. Every wait rejects after
// `timeout` ms with the output seen so far.
export function runInPty(python, argv, { cwd, env, timeout = 30000 }) {
  const child = spawn(python, ['-c', RELAY, ...argv], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {}); // keys typed after the program ended
  let raw = '';
  let closed = null;
  const waiters = new Set();
  const text = () => raw.replace(ANSI, '');
  const check = () => {
    for (const w of waiters) {
      if (w.pattern.test(text())) {
        waiters.delete(w);
        clearTimeout(w.timer);
        w.resolve(text());
      }
    }
  };
  child.stdout.on('data', (d) => {
    raw += d;
    check();
  });
  child.stderr.on('data', (d) => {
    raw += d;
    check();
  });
  const exit = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the program did not exit within ${timeout} ms; output:\n${text()}`));
    }, timeout);
    child.on('close', (code) => {
      clearTimeout(timer);
      closed = code;
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.reject(new Error(`the program exited (${code}) before the output matched ${w.pattern}; output:\n${text()}`));
      }
      waiters.clear();
      child.stdin.destroy();
      resolve({ code, output: text() });
    });
  });
  return {
    exit,
    write: (keys) => child.stdin.write(keys),
    waitFor: (pattern) =>
      new Promise((resolve, reject) => {
        const w = { pattern, resolve, reject };
        w.timer = setTimeout(() => {
          waiters.delete(w);
          reject(new Error(`timed out after ${timeout} ms waiting for ${pattern}; output:\n${text()}`));
        }, timeout);
        waiters.add(w);
        check();
        if (closed !== null && waiters.has(w)) {
          waiters.delete(w);
          clearTimeout(w.timer);
          reject(new Error(`the program exited (${closed}) before the output matched ${pattern}; output:\n${text()}`));
        }
      }),
  };
}
