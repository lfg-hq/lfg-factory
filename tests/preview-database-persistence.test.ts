import {test,expect} from 'bun:test';
import {branchDatabaseScript} from '../src/services/preview-isolation.ts';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
test('same branch reuses the same existing database and never reinitializes it',()=>{
 const root=mkdtempSync(join(tmpdir(),'preview-databases-'));const bin=join(root,'bin');mkdirSync(bin);
 writeFileSync(join(root,'.env'),"DATABASE_URL='postgres://app:secret@127.0.0.1:5432/app'\n");
 writeFileSync(join(bin,'docker'),`#!/usr/bin/env python3
import sys,os,json
state=os.environ['DB_STATE'];calls=os.environ['DB_CALLS'];args=sys.argv
try: names=json.load(open(state))
except: names=[]
if 'createdb' in args:
 names.append(args[-1]);json.dump(names,open(state,'w'));open(calls,'a').write('createdb\\n')
elif 'psql' in args:
 print('1' if any(name in args[-1] for name in names) else '')
`,{mode:0o755});
 const script=branchDatabaseScript(root,'feature/test',[{engine:'postgres',password:'secret',username:'app',port:5432,dbName:'app'}]);
 const run=()=>spawnSync('bash',['-c',script],{encoding:'utf8',env:{...process.env,PATH:bin+':'+process.env.PATH,DB_STATE:join(root,'databases'),DB_CALLS:join(root,'calls')}});
 try{const first=run();expect(first.status).toBe(0);const settings=readFileSync(join(root,'.env'),'utf8');const second=run();expect(second.status).toBe(0);expect(second.stdout).toBe(first.stdout);expect(readFileSync(join(root,'.env'),'utf8')).toBe(settings);expect(readFileSync(join(root,'calls'),'utf8')).toBe('createdb\n');}finally{rmSync(root,{recursive:true,force:true});}
});
