import {test,expect,mock} from 'bun:test';
let row:any,updates:any;
const config:any={GITLAB_CLIENT_ID:'client',GITLAB_CLIENT_SECRET:'secret'};
mock.module('../src/config/env.ts',()=>({env:config}));
mock.module('../src/config/db.ts',()=>({db:{select:()=>({from:()=>({where:async()=>[row]})}),update:()=>({set:(value:any)=>({where:async()=>{updates=value;row={...row,...value};}})})}}));
const {getValidGitlabToken}=await import('../src/services/gitlab-token.ts');
const originalFetch=globalThis.fetch;
function reset(){row={accessToken:'old',refreshToken:'refresh',tokenExpiresAt:new Date(Date.now()-1000)};updates=null;config.GITLAB_CLIENT_SECRET='secret';}
test('expired token refreshes once for concurrent callers and saves rotated credentials',async()=>{
 reset();let calls=0;
 globalThis.fetch=(async()=>{calls++;await new Promise(r=>setTimeout(r,5));return Response.json({access_token:'new',refresh_token:'rotated',expires_in:7200});}) as any;
 try {expect(await Promise.all([getValidGitlabToken('u'),getValidGitlabToken('u')])).toEqual(['new','new']);expect(calls).toBe(1);expect(updates.refreshToken).toBe('rotated');}finally{globalThis.fetch=originalFetch;}
});
test('missing refresh configuration never returns expired credentials',async()=>{
 reset();config.GITLAB_CLIENT_SECRET='';expect(await getValidGitlabToken('u')).toBeNull();
});
test('explicit rejection refreshes even when recorded expiry is in the future',async()=>{
 reset();row.tokenExpiresAt=new Date(Date.now()+7200000);
 globalThis.fetch=(async()=>Response.json({access_token:'replacement',expires_in:7200})) as any;
 try{expect(await getValidGitlabToken('u','old')).toBe('replacement');}finally{globalThis.fetch=originalFetch;}
});
test('valid token does not require refresh configuration',async()=>{
 reset();row.tokenExpiresAt=new Date(Date.now()+7200000);config.GITLAB_CLIENT_SECRET='';expect(await getValidGitlabToken('u')).toBe('old');
});
