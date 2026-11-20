import fs from 'fs';
import path from 'path';

// POSIX stand-in launcher: records each argument on its own line to `log`, then exits with `exitCode`.
export default function writeStub(dir: string, name: string, log: string, exitCode = 0): void {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\nfor a in "$@"; do printf 'ARG:%s\\n' "$a"; done >> "${log}"\nexit ${exitCode}\n`);
  fs.chmodSync(file, 0o755);
}
