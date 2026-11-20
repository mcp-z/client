import assert from 'assert';
import fs from 'fs';
import { safeRmSync } from 'fs-remove-compat';
import path from 'path';
import openUrl from '../../../src/lib/open-url.ts';
import scratchDir from '../../lib/scratch.ts';
import writeStub from '../../lib/stubs.ts';
import waitFor from '../../lib/wait-for.ts';

const REFUSED: [string, string][] = [
  ['file:///x', 'openUrl: refusing to open file: URL'],
  ['ms-msdt:x', 'openUrl: refusing to open ms-msdt: URL'],
  ['javascript:x', 'openUrl: refusing to open javascript: URL'],
  ['not a url', 'openUrl: not a valid URL'],
];

describe('open-url', () => {
  let dir: string;
  let marker: string;
  let savedPath: string | undefined;

  before(() => {
    dir = scratchDir('index');
    marker = path.join(dir, 'called.log');
    // Every launcher name resolves to a script that records the call. On Windows the launcher is
    // powershell.exe, which a script cannot stand in for: an empty PATH makes any spawn reject with ENOENT.
    if (process.platform !== 'win32') {
      ['open', 'xdg-open', 'powershell.exe'].forEach((name) => writeStub(dir, name, marker));
    }
    savedPath = process.env.PATH;
    process.env.PATH = dir;
  });
  after(() => {
    process.env.PATH = savedPath;
    safeRmSync(dir);
  });

  beforeEach(() => fs.rmSync(marker, { force: true }));

  REFUSED.forEach(([url, message]) => {
    it(`rejects ${url} before starting a process`, async () => {
      await assert.rejects(openUrl(url), (err: Error) => err.message === message);
      assert.ok(!fs.existsSync(marker), 'no launcher ran');
    });
  });

  // Stubs are POSIX scripts; Windows has no stand-in for powershell.exe.
  (process.platform === 'win32' ? it.skip : it)('launches the normalized URL, not the raw input', async () => {
    await openUrl(' https://a.example/x\t?y="z w"');
    const lines = await waitFor('the stub to record its arguments', () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean) : undefined));
    assert.deepEqual(lines, [`ARG:${new URL(' https://a.example/x\t?y="z w"').href}`]);
  });
});
