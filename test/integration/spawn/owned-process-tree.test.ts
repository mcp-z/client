import assert from 'assert';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { OwnedProcessTree } from '../../../src/spawn/owned-process-tree.ts';
import { forceStopProcess, isProcessAlive, waitForChildClose, waitForProcessExit } from '../../lib/process-helpers.ts';
import { waitForOutput } from '../../lib/wait-for-output.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../..');
const fixture = path.join(projectRoot, 'test/lib/servers/hanging-stop-command.mjs');

const posixIt = process.platform === 'win32' ? it.skip : it;

describe('OwnedProcessTree', () => {
  posixIt('should terminate a process group including a descendant that ignores signals', async () => {
    const pidFile = path.resolve(projectRoot, '.tmp', `owned-process-tree-${process.pid}-${Date.now()}.pid`);
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    const child = spawn(process.execPath, [fixture, pidFile], { stdio: 'ignore', detached: true });
    assert.ok(child.pid, 'fixture should have a process ID');
    const childPid = child.pid;
    const childClose = waitForChildClose(child);
    let descendantPid: number | undefined;

    try {
      const readPidFile = () => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : '');
      await waitForOutput(readPidFile, /^\d+$/);
      descendantPid = Number(readPidFile());

      const tree = new OwnedProcessTree(childPid);
      assert.strictEqual(tree.isEmpty(), false);
      assert.ok(isProcessAlive(descendantPid), 'descendant should be running before terminate');
      assert.deepStrictEqual(tree.terminate(), { killed: true });
      await childClose;
      await waitForProcessExit(descendantPid, 2000);
      assert.strictEqual(tree.isEmpty(), true);
    } finally {
      forceStopProcess(-childPid);
      if (descendantPid && isProcessAlive(descendantPid)) {
        forceStopProcess(descendantPid);
        await waitForProcessExit(descendantPid, 2000);
      }
      fs.rmSync(pidFile, { force: true });
    }
  });
});
