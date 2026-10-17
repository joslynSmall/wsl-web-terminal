import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';

const execFileAsync = promisify(execFile);

export class ShellScanner {
  async scanSystemShells() {
    try {
      const { stdout } = await execFileAsync('ps', [
        '-eo',
        'pid,ppid,tty,stat,comm,args',
        '--no-headers'
      ]);

      const lines = stdout.trim().split('\n').filter(Boolean);
      const allProcs = [];
      const shells = [];

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5) {
          allProcs.push({
            pid: parts[0],
            ppid: parts[1],
            tty: parts[2],
            stat: parts[3],
            comm: parts[4],
            args: parts.slice(5).join(' ')
          });
        }
      }

      for (const proc of allProcs) {
        if (proc.tty !== '?' && !proc.tty.startsWith('tty') && /^(bash|zsh|fish|sh)$/.test(proc.comm)) {
          let cwd = '';
          try {
            cwd = fs.readlinkSync(`/proc/${proc.pid}/cwd`);
          } catch {
            cwd = 'unknown';
          }

          let isTmuxChild = false;
          try {
            const statusContent = fs.readFileSync(`/proc/${proc.pid}/status`, 'utf8');
            const ppidMatch = statusContent.match(/PPid:\s+(\d+)/);
            if (ppidMatch) {
              const ppid = ppidMatch[1];
              const parentComm = fs.readFileSync(`/proc/${ppid}/comm`, 'utf8').trim();
              if (parentComm.startsWith('tmux')) {
                isTmuxChild = true;
              }
            }
          } catch {}

          const children = allProcs.filter(p => p.ppid === proc.pid);
          let runningCommand = '空闲 (待命中)';
          if (children.length > 0) {
            const activeChild = children[children.length - 1];
            runningCommand = activeChild.args ? activeChild.args.slice(0, 50) : activeChild.comm;
          }

          shells.push({
            pid: parseInt(proc.pid, 10),
            tty: `/dev/${proc.tty}`,
            shortTty: proc.tty,
            stat: proc.stat,
            comm: proc.comm,
            args: proc.args,
            cwd,
            runningCommand,
            isTmuxChild
          });
        }
      }

      return shells;
    } catch (err) {
      console.error('Failed to scan system shells:', err);
      return [];
    }
  }
}
