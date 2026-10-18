/** Keep completed events intact; streaming snapshots otherwise grow quadratically. */
export const piLogCompactorSource = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const file = process.argv[2], forward = process.argv[3] === '--forward';
let lastActivity = 0, previous = '';
const input = readline.createInterface({input:process.stdin,crlfDelay:Infinity});
input.on('line', line => {
  if (forward) process.stdout.write(line + '\n');
  let event;
  try { event = JSON.parse(line); } catch { fs.appendFileSync(file, line + '\n'); return; }
  if (event.type === 'message_update') {
    const kind = event.assistantMessageEvent?.type || '';
    const text = kind.startsWith('thinking') ? 'Thinking through the next step'
      : kind.startsWith('toolcall') ? 'Preparing the next action' : 'Preparing a response';
    const now = Date.now();
    if (text === previous && now - lastActivity < 1000) return;
    previous = text; lastActivity = now;
    fs.appendFileSync(file, JSON.stringify({type:'activity',text}) + '\n');
    return;
  }
  fs.appendFileSync(file, line + '\n');
});
`;
