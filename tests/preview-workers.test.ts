import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {test,expect} from 'bun:test';
import {discoverBackgroundProcesses,backgroundProcessSchema,previewWorkerCommand} from '../src/services/preview-workers.ts';
test('old profiles discover only explicit foreground worker scripts and preserve configured workers',()=>{
 const pkg={scripts:{start:'next start',worker:'node --env-file=.env.local --import tsx src/worker/index.ts','worker:email':'node workers/email.js',test:'vitest','bootstrap:admin':'node scripts/bootstrap-admin.ts'}};
 const result=discoverBackgroundProcesses(pkg);
 expect(result.map(w=>w.name)).toEqual(['worker','worker-email']);
 expect(result[0]?.entrypoint).toBe('src/worker/index.ts');
 expect(result[0]?.environmentFiles).toEqual(['.env.local']);
 expect(discoverBackgroundProcesses(pkg,[{name:'worker',runCmd:'npm run worker'}])[0]?.environmentFiles).toEqual(['.env.local']);
 expect(discoverBackgroundProcesses(pkg,[{name:'worker',runCmd:'custom-worker',readyLog:'Ready'}])[0]?.runCmd).toBe('custom-worker');
 expect(()=>discoverBackgroundProcesses({scripts:{worker:'node worker.js &'}})).toThrow('foreground');
 expect(()=>backgroundProcessSchema.parse({name:'worker',runCmd:'run',dir:'../other'})).toThrow();
});
test('supervisor commands quote checkout paths and carry declared database keys without values',()=>{
 const command=previewWorkerCommand('start',"/data/checkout's branch",[{name:'worker',runCmd:'npm run worker'}],['DATABASE_URL']);
 expect(command).toContain('python3 -c');
 expect(command).not.toContain('postgres://');
});

test('legacy worker env filenames fail without creating aliases or overwriting existing files',()=>{
 const root=mkdtempSync(join(tmpdir(),'canonical-env-'));
 try {
  writeFileSync(join(root,'.env'),'DATABASE_URL=canonical\n');
  const run=()=>spawnSync('sh',['-c',previewWorkerCommand('start',root,[{name:'worker',runCmd:'exit 0',environmentFiles:['.env.local']}],[],{stateFile:join(root,'state.json')})],{encoding:'utf8'});
  const first=run();expect(first.status).toBe(1);expect(first.stdout).toContain('noncanonical environment file');
  expect(existsSync(join(root,'.env.local'))).toBe(false);
  writeFileSync(join(root,'.env.local'),'EXISTING=preserved\n');
  expect(run().status).toBe(1);
  expect(readFileSync(join(root,'.env.local'),'utf8')).toBe('EXISTING=preserved\n');
  expect(readFileSync(join(root,'.env'),'utf8')).toBe('DATABASE_URL=canonical\n');
 } finally {rmSync(root,{recursive:true,force:true});}
});
