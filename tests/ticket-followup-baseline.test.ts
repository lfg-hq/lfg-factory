import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {ticketFollowupBaselineScript} from '../src/services/ticket-followup-baseline.ts';

function fixture(run:(f:any)=>void) {
 const root=mkdtempSync(join(tmpdir(),'ticket-baseline-'));
 const repo=join(root,'ticket'), bare=join(root,'remote.git');
 const sh=(cmd:string)=>spawnSync('bash',['-c',cmd],{cwd:root,encoding:'utf8'});
 const git=(args:string)=>{const r=sh(`git -C '${repo}' ${args}`);if(r.status)throw Error(r.stderr);return r.stdout.trim();};
 try {
  sh(`git init -q --bare '${bare}'; git init -q -b epic/test '${repo}'`);
  git('config user.name Test');git('config user.email test@example.test');
  writeFileSync(join(repo,'app.txt'),'original\n');git('add .');git('commit -qm initial');
  git(`remote add origin '${bare}'`);git('push -q origin epic/test');git('checkout -qb feature/test');
  const advance=()=>{git('checkout -q epic/test');writeFileSync(join(repo,'app.txt'),'latest epic\n');git('commit -qam advance');git('push -q origin epic/test');git('checkout -q feature/test');};
  const refresh=()=>sh(ticketFollowupBaselineScript(repo,'feature/test','epic/test',bare));
  run({repo,git,advance,refresh});
 } finally {rmSync(root,{recursive:true,force:true});}
}
test('reused ticket advances to latest epic while preserving ignored runtime settings',()=>fixture(({repo,git,advance,refresh}:any)=>{
 git('config core.excludesfile /dev/null');writeFileSync(join(repo,'.git/info/exclude'),'.env.local\n');
 writeFileSync(join(repo,'.env.local'),'LOCAL=kept');advance();
 expect(refresh().status).toBe(0);expect(readFileSync(join(repo,'app.txt'),'utf8')).toBe('latest epic\n');
 expect(readFileSync(join(repo,'.env.local'),'utf8')).toBe('LOCAL=kept');expect(git('branch --show-current')).toBe('feature/test');
 expect(refresh().stdout).toContain('BASELINE_CURRENT');
}));
test('saved dirty edits are never reset or silently built on stale code',()=>fixture(({repo,git,advance,refresh}:any)=>{
 advance();const head=git('rev-parse HEAD');writeFileSync(join(repo,'app.txt'),'unsaved repair\n');
 const r=refresh();expect(r.status).toBe(2);expect(r.stdout).toContain('BASELINE_LOCAL_EDITS');
 expect(git('rev-parse HEAD')).toBe(head);expect(readFileSync(join(repo,'app.txt'),'utf8')).toBe('unsaved repair\n');
}));
test('divergent conflicts abort without destroying saved ticket commits',()=>fixture(({repo,git,advance,refresh}:any)=>{
 writeFileSync(join(repo,'app.txt'),'ticket repair\n');git('commit -qam repair');const head=git('rev-parse HEAD');advance();
 const r=refresh();expect(r.status).toBe(3);expect(r.stdout).toContain('BASELINE_CONFLICT');
 expect(git('rev-parse HEAD')).toBe(head);expect(git('status --porcelain')).toBe('');
 expect(readFileSync(join(repo,'app.txt'),'utf8')).toBe('ticket repair\n');
}));
test('non-conflicting unpublished work is retained when updating the epic baseline',()=>fixture(({repo,git,advance,refresh}:any)=>{
 writeFileSync(join(repo,'repair.txt'),'unpublished fix');git('add .');git('commit -qm repair');const head=git('rev-parse HEAD');advance();
 expect(refresh().status).toBe(0);expect(git(`merge-base --is-ancestor ${head} HEAD`)).toBe('');
 expect(readFileSync(join(repo,'repair.txt'),'utf8')).toBe('unpublished fix');
 expect(readFileSync(join(repo,'app.txt'),'utf8')).toBe('latest epic\n');
}));
test('refresh also includes a newer published ticket commit that has not reached the epic',()=>fixture(({repo,git,refresh}:any)=>{
 const original=git('rev-parse HEAD');
 writeFileSync(join(repo,'remote-repair.txt'),'published by another session');git('add .');git('commit -qm repair');git('push -q origin feature/test');
 const published=git('rev-parse HEAD');git(`reset --hard ${original}`);
 expect(refresh().status).toBe(0);expect(git('rev-parse HEAD')).toBe(published);
 expect(readFileSync(join(repo,'remote-repair.txt'),'utf8')).toBe('published by another session');
}));
