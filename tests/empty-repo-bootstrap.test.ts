import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {emptyRepoBootstrap} from '../src/services/empty-repo-bootstrap.ts';
function fixture(run:(dir:string,remote:string)=>void){
 const root=mkdtempSync(join(tmpdir(),'empty-repo-'));
 try{const remote=join(root,'remote.git'),dir=join(root,'checkout');execFileSync('git',['init','--bare',remote],{stdio:'ignore'});execFileSync('git',['clone',remote,dir],{stdio:'ignore'});run(dir,remote);}finally{rmSync(root,{recursive:true,force:true});}
}
test('empty remote receives a base commit and repeated setup preserves it',()=>fixture((cwd,remote)=>{
 const run=()=>execFileSync('sh',['-c',emptyRepoBootstrap('main')],{cwd,stdio:'pipe'});
 run();const before=execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'});
 expect(execFileSync('git',['--git-dir='+remote,'rev-parse','refs/heads/main'],{encoding:'utf8'})).toBe(before);
 run();expect(execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'})).toBe(before);
}));
test('inaccessible remote fails without creating a commit',()=>fixture((cwd)=>{
 execFileSync('git',['remote','set-url','origin','/no-such-lfs-repo'],{cwd});
 expect(spawnSync('sh',['-c',emptyRepoBootstrap('main')],{cwd}).status).not.toBe(0);
 expect(spawnSync('git',['rev-parse','--verify','HEAD'],{cwd}).status).not.toBe(0);
}));
