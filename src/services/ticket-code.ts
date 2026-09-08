import { readFileSync } from 'node:fs';
import { execOnWorkspace } from './mags.ts';
const worker = readFileSync(new URL('./ticket-code-worker.py', import.meta.url), 'utf8');
export const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export async function ticketCodeCommand(workspace: string, args: Record<string, unknown>) {
  const encoded = Buffer.from(worker).toString('base64');
  const command = `python3 -c ${shellQuote(`import base64; exec(base64.b64decode('${encoded}'))`)} ${shellQuote(JSON.stringify(args))}`;
  const result = await execOnWorkspace(workspace, command, { timeout: 60_000 });
  try { return JSON.parse(result.output.trim()); }
  catch { throw new Error('The ticket sandbox is unavailable. Restore or rebuild the ticket and retry.'); }
}
