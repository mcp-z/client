// Windows only: the windows-latest job owns this suite and runs it strictly. It registers a stand-in
// browser under HKCU and needs cmd, PowerShell and the registry; there is nothing to skip to elsewhere.
import assert from 'assert';
import spawn from 'cross-spawn-cb';
import fs from 'fs';
import { safeRmSync } from 'fs-remove-compat';
import path from 'path';
import url from 'url';
import { launch } from '../../src/lib/launch.ts';
import scratchDir from '../lib/scratch.ts';
import { buildUrl, TAILS } from '../lib/urls.ts';
import waitFor from '../lib/wait-for.ts';

const __dirname = path.dirname(typeof __filename !== 'undefined' ? __filename : url.fileURLToPath(import.meta.url));
const SCHEME = 'mcp-z-client-open-url-test';
const KEY = `HKCU\\Software\\Classes\\${SCHEME}`;
const RECORDER = path.join(__dirname, '..', 'lib', 'recorder.mjs');

function reg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    spawn('reg', args, { encoding: 'utf8' }, (err, res) => (err ? reject(err) : resolve(void res)));
  });
}

// reg exits 1 when the key is absent; any other failure is real.
async function deleteKey(): Promise<void> {
  try {
    await reg(['delete', KEY, '/f']);
  } catch (err) {
    if ((err as { status?: number }).status !== 1) throw err;
  }
}

const FORMS: [string, NodeJS.Platform, boolean][] = [
  ['cmd form target (win32)', 'win32', false],
  ['WSL form target (linux + WSL)', 'linux', true],
];

(process.platform === 'win32' ? describe : describe.skip)('windows launch', () => {
  let dir: string;
  let received: string;
  let markerLog: string;
  const savedPath = process.env.PATH;
  const savedVar = process.env.MARKER_VAR;

  before(async () => {
    await deleteKey(); // a key left by a killed run
    dir = scratchDir('windows-launch');
    received = path.join(dir, 'received.log');
    markerLog = path.join(dir, 'marker.log');
    fs.writeFileSync(path.join(dir, 'marker.cmd'), `@echo ran: [%*]>> "${markerLog}"\r\n`);
    await reg(['add', KEY, '/ve', '/d', `URL:${SCHEME}`, '/f']);
    await reg(['add', KEY, '/v', 'URL Protocol', '/d', '', '/f']);
    await reg(['add', `${KEY}\\shell\\open\\command`, '/ve', '/d', `"${process.execPath}" "${RECORDER}" "${dir}" "%1"`, '/f']);
    process.env.PATH = `${dir};${savedPath}`;
    process.env.MARKER_VAR = 'MARKER_VALUE';
  });
  after(async () => {
    process.env.PATH = savedPath;
    if (savedVar === undefined) delete process.env.MARKER_VAR;
    else process.env.MARKER_VAR = savedVar;
    await deleteKey();
    if (dir) safeRmSync(dir);
  });

  FORMS.forEach(([label, platform, wsl]) => {
    describe(label, () => {
      TAILS.forEach(({ name, tail }, index) => {
        it(`delivers the URL unchanged: ${name}`, async () => {
          const tag = `${platform}-${wsl}-${index}`;
          const expected = buildUrl(SCHEME, tag, tail);
          await launch(expected, platform, wsl);
          const line = await waitFor(`a line for ${tag} in received.log`, () => {
            if (!fs.existsSync(received)) return undefined;
            return fs
              .readFileSync(received, 'utf8')
              .split(/\r?\n/)
              .find((l) => l.indexOf(`/${tag}?`) >= 0);
          });
          assert.equal(line, expected);
          assert.ok(!fs.existsSync(markerLog), 'no second command ran');
        });
      });
    });
  });
});
