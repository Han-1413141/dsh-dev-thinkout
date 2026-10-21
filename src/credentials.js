import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
const execute = promisify(execFile);

export async function readApiKey(credentialFile) {
  if (process.env.JEV_API_KEY) return process.env.JEV_API_KEY.trim();
  if (process.platform !== 'win32' || !credentialFile || !existsSync(credentialFile)) return '';
  const literal = credentialFile.replaceAll("'", "''");
  const script = `$ErrorActionPreference='Stop'; $c=Import-Clixml -LiteralPath '${literal}'; [Console]::Out.Write($c.GetNetworkCredential().Password)`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    const { stdout } = await execute('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',encoded],
      { windowsHide: true, timeout: 10000, maxBuffer: 4096 });
    return /^sk-vsr-[A-Za-z0-9]+$/.test(stdout.trim()) ? stdout.trim() : '';
  } catch { return ''; }
}
