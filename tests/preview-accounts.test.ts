import {test,expect,mock} from 'bun:test';
const env={NODE_ENV:'test',ENCRYPTION_KEY:'test-only-encryption-key-32-characters'};
mock.module('../src/config/env.ts',()=>({env}));
let profile:any={};let saved=0;
mock.module('../src/services/app-profile.ts',()=>({loadAppProfile:async()=>({profile}),saveAppProfile:async(_project:string,value:any)=>{profile=value;saved++;}}));
const {storePreviewAccount,recallPreviewAccounts,databaseIdentity}=await import('../src/services/preview-accounts.ts');
test('verified credentials are encrypted at rest and cannot be recalled for another database',async()=>{
 profile={};saved=0;
 const identity=databaseIdentity({engine:'mssql',host:'127.0.0.1',port:1433,database:'branch-a'});
 await storePreviewAccount('p','feature/a',{identity,connectionKey:'DB',username:'test-admin',password:'test-only-password'});
 expect(saved).toBe(1);expect(JSON.stringify(profile)).not.toContain('test-only-password');expect(profile.previewAccounts[0].passwordEncrypted).toStartWith('gcm:');
 expect(await recallPreviewAccounts('p','feature/a',identity)).toMatchObject([{username:'test-admin',password:'test-only-password'}]);
 expect(await recallPreviewAccounts('p','feature/a',databaseIdentity({engine:'mssql',host:'127.0.0.1',port:1433,database:'branch-b'}))).toEqual([]);
});
test('missing encryption refuses storage instead of silently saving plaintext-equivalent credentials',async()=>{
 const before=saved;env.ENCRYPTION_KEY='';
 try{await expect(storePreviewAccount('p','feature/a',{identity:'i',connectionKey:'DB',username:'admin',password:'generated'})).rejects.toThrow('Encrypted credential storage');expect(saved).toBe(before);}finally{env.ENCRYPTION_KEY='test-only-encryption-key-32-characters';}
});
