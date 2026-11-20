import assert from 'assert';
import { safeRmSync } from 'fs-remove-compat';
import util from 'util';
import { launch } from '../../src/lib/launch.ts';
import scratchDir from '../lib/scratch.ts';

describe('missing launcher', () => {
  let dir: string;
  let savedPath: string | undefined;

  before(() => {
    dir = scratchDir('missing-launcher');
    savedPath = process.env.PATH;
    process.env.PATH = dir;
  });
  after(() => {
    process.env.PATH = savedPath;
    safeRmSync(dir);
  });

  it('rejects with ENOENT, naming the command and carrying no URL', async () => {
    const url = 'https://example.com/?token=SECRET';
    await assert.rejects(launch(url, 'linux', false), (err: NodeJS.ErrnoException) => {
      assert.equal(err.code, 'ENOENT');
      assert.equal(err.syscall, 'spawn xdg-open');
      assert.equal(err.path, 'xdg-open');
      assert.ok(!('spawnargs' in err), 'no spawnargs');
      assert.ok(!('cause' in err), 'no cause where the original carries the URL');
      assert.equal(util.inspect(err).indexOf('SECRET'), -1);
      return true;
    });
  });

  it('win32 rejects plainly when powershell.exe is not under SystemRoot', async () => {
    const saved = process.env.SystemRoot;
    process.env.SystemRoot = dir;
    try {
      await assert.rejects(launch('https://example.com/', 'win32'), (err: Error) => err.message.indexOf('openUrl:') === 0 && err.message.indexOf('powershell.exe') > 0 && err.message.indexOf('not found') > 0);
    } finally {
      if (saved === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = saved;
    }
  });
});
