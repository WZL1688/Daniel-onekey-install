import { spawn } from 'node:child_process';

export function browserCommand(url, platform = process.platform) {
  const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/.exec(url);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) throw new Error('浏览器只能打开程序生成的本机地址');
  const address = url.endsWith('/') ? url : `${url}/`;
  if (platform === 'win32') return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', address] };
  if (platform === 'darwin') return { command: 'open', args: [address] };
  return { command: 'xdg-open', args: [address] };
}

export async function openBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  const { command, args } = browserCommand(url, platform);
  return new Promise(resolve => {
    try {
      const child = spawnImpl(command, args, { shell: false, stdio: 'ignore', windowsHide: true, detached: true });
      child.once('error', () => resolve(false));
      child.once('spawn', () => { child.unref(); resolve(true); });
    } catch { resolve(false); }
  });
}
