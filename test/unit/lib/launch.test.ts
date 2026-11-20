import assert from 'assert';
import { launchCommand } from '../../../src/lib/launch.ts';
import { buildUrl, TAILS } from '../../lib/urls.ts';

const ENV = { SystemRoot: 'C:\\Windows' };
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

const TARGETS: [NodeJS.Platform, boolean][] = [
  ['darwin', false],
  ['win32', false],
  ['linux', true],
  ['linux', false],
  ['freebsd', false],
];

describe('launch', () => {
  TARGETS.forEach(([platform, wsl]) => {
    describe(`${platform}${wsl ? ' (WSL)' : ''}`, () => {
      TAILS.forEach(({ name, tail }) => {
        it(`keeps the URL whole: ${name}`, () => {
          const url = buildUrl('https', 'unit', tail);
          const { args, env } = launchCommand(url, platform, wsl, ENV);
          const inArgs = args.filter((arg) => arg === url).length;
          const inEnv = Object.values(env || {}).filter((value) => value === url).length;
          assert.equal(inArgs + inEnv, 1, 'the URL appears exactly once, whole');
          assert.equal(args.filter((arg) => arg !== url && arg.indexOf(url) >= 0).length, 0, 'no other argument contains the URL');
          assert.equal(Object.values(env || {}).filter((value) => value !== url && value.indexOf(url) >= 0).length, 0, 'no other env value contains the URL');
        });
      });
    });
  });

  it('passes the URL to PowerShell in MCP_Z_OPEN_URL', () => {
    const url = buildUrl('https', 'unit', '&marker');
    assert.equal(launchCommand(url, 'win32', false, ENV).env?.MCP_Z_OPEN_URL, url);
    assert.equal(launchCommand(url, 'linux', true, ENV).env?.MCP_Z_OPEN_URL, url);
    assert.ok(launchCommand(url, 'win32', false, ENV).args.join(' ').indexOf('$env:MCP_Z_OPEN_URL') >= 0);
  });

  it('win32 runs powershell.exe from SystemRoot, never the bare name', () => {
    assert.equal(launchCommand('https://a.example/', 'win32', false, ENV).file, POWERSHELL);
  });

  it('win32 without SystemRoot fails plainly instead of falling back to PATH', () => {
    assert.throws(
      () => launchCommand('https://a.example/', 'win32', false, {}),
      (err: Error) => err.message === 'openUrl: SystemRoot is not set'
    );
  });

  it('WSL keeps the PATH lookup', () => {
    assert.equal(launchCommand('https://a.example/', 'linux', true, ENV).file, 'powershell.exe');
  });
});
