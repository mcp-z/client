import fs from 'fs';
import { safeRmSync } from 'fs-remove-compat';
import path from 'path';
import url from 'url';

const __dirname = path.dirname(typeof __filename !== 'undefined' ? __filename : url.fileURLToPath(import.meta.url));
export const TMP_ROOT = path.join(__dirname, '..', '..', '.tmp');

// An empty scratch directory for one suite: anything a killed earlier run left is removed first.
export default function scratchDir(name: string): string {
  const dir = path.join(TMP_ROOT, name);
  safeRmSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
