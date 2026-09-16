import {test,expect,mock,afterAll} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const root=mkdtempSync(join(tmpdir(),'retry-route-'));
process.env.DATABASE_URL=join(root,'test.db');process.env.DATABASE_DRIVER='sqlite';
process.env.BETTER_AUTH_SECRET='test-only-placeholder';process.env.BETTER_AUTH_URL='http://localhost:8000';
const generated=Bun.spawnSync(['bun','node_modules/drizzle-kit/bin.cjs','generate','--dialect','sqlite','--schema','./src/db/schema/sqlite/index.ts','--out',join(root,'schema')]);
if(generated.exitCode)throw new Error(generated.stderr.toString());
const sqlite=new Database(process.env.DATABASE_URL);
for(const file of readdirSync(join(root,'schema')).filter(f=>f.endsWith('.sql')))sqlite.exec(readFileSync(join(root,'schema',file),'utf8'));
sqlite.close();
mock.module('../src/auth/middleware.ts',()=>({requireAuth:async(c:any,next:any)=>{c.set('user',{id:'owner'});return next();}}));
let permitted=true, accessible=true;
mock.module('../src/auth/project-access.ts',()=>({getProjectAccess:async(id:string)=>accessible && id==='public-project' ? {project:{id:'internal-project',projectId:'public-project'},permissions:{canManageTickets:permitted,canEditFiles:permitted}}:null,requirePermission:()=>true}));
const started:string[]=[];let rejectStart=false;
mock.module('../src/workers/ticket-executor.ts',()=>({startTicketValidationRetry:async(id:string)=>{if(rejectStart)throw new Error("Ticket operation is stopping.");started.push(id);}}));
const {db}=await import('../src/config/db.ts');
const {users}=await import('../src/db/schema/users.ts');
const {projects}=await import('../src/db/schema/projects.ts');
const {projectTickets}=await import('../src/db/schema/tickets.ts');
await db.insert(users).values({id:'owner',name:'Owner',email:'owner@example.test'});
await db.insert(projects).values([{id:'internal-project',projectId:'public-project',name:'Project',ownerId:'owner'},{id:'another-internal',projectId:'another-public',name:'Another project',ownerId:'owner'}]);
await db.insert(projectTickets).values([{id:'ticket',projectId:'internal-project',name:'Test ticket',description:'Test'},{id:'foreign-ticket',projectId:'another-internal',name:'Another ticket',description:'Test'}]);
const {default:routes}=await import('../src/routes/api/tickets.ts');
const post=(id:string)=>routes.request('/public-project/tickets/'+id+'/retry-validation',{method:'POST'});
test('public project URL resolves to internal project ID before ticket lookup',async()=>{
 const res=await post('ticket');expect(res.status).toBe(202);expect(started).toEqual(['ticket']);
});
test('ticket from a different project is rejected without dispatch',async()=>{
 const before=started.length;const res=await post('foreign-ticket');expect(res.status).toBe(404);expect(started.length).toBe(before);
});
test('missing tickets and insufficient permissions never dispatch',async()=>{
 const before=started.length;expect((await post('missing')).status).toBe(404);
 permitted=false;try{expect((await post('ticket')).status).toBe(403);}finally{permitted=true;}
 accessible=false;try{expect((await post('ticket')).status).toBe(404);}finally{accessible=true;}
 expect(started.length).toBe(before);
});
test('rejected retry returns authoritative queue state to resynchronize the drawer',async()=>{
 const {eq}=await import('drizzle-orm');
 await db.update(projectTickets).set({queueStatus:'stopping'}).where(eq(projectTickets.id,'ticket'));
 rejectStart=true;
 try {const res=await post('ticket');expect(res.status).toBe(409);const data=await res.json() as any;expect(data.ticket.ticketId).toBe('ticket');expect(data.ticket.queueStatus).toBe('stopping');}
 finally{rejectStart=false;}
});
afterAll(()=>rmSync(root,{recursive:true,force:true}));
