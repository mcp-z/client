// POSIX only: stub launchers on PATH stand in for `open` and `xdg-open`; no browser starts.
import assert from 'assert';
import fs from 'fs';
import { safeRmSync } from 'fs-remove-compat';
import path from 'path';
import { launch } from '../../src/lib/launch.ts';
import scratchDir from '../lib/scratch.ts';
import writeStub from '../lib/stubs.ts';
import waitFor from '../lib/wait-for.ts';

(process.platform === 'win32' ? describe.skip : describe)('posix launch', () => {
  let dir: string;
  let log: string;
  let savedPath: string | undefined;

  before(() => {
    dir = scratchDir('posix-launch');
    log = path.join(dir, 'args.log');
    savedPath = process.env.PATH;
    process.env.PATH = dir;
  });
  beforeEach(() => fs.rmSync(log, { force: true }));
  after(() => {
    process.env.PATH = savedPath;
    safeRmSync(dir);
  });

  it('linux: resolves on spawn and the launcher gets the URL as one argument', async () => {
    const url = 'https://example.com/a?b=1&c=%7Cx$(y)';
    writeStub(dir, 'xdg-open', log);
    await launch(url, 'linux', false);
    const lines = await waitFor('xdg-open stub to record its arguments', () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : undefined));
    assert.deepEqual(lines, [`ARG:${url}`]);
  });

  it('darwin: resolves after the launcher exits 0, with the URL as one argument', async () => {
    const url = 'https://example.com/a?b=1&c=%7Cx$(y)';
    writeStub(dir, 'open', log);
    await launch(url, 'darwin', false);
    assert.deepEqual(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean), [`ARG:${url}`]);
  });

  it('darwin: rejects when the launcher exits non-zero', async () => {
    writeStub(dir, 'open', log, 1);
    await assert.rejects(launch('https://example.com/', 'darwin', false), (err: Error) => err.message === 'openUrl: open exited with code 1');
  });
});
