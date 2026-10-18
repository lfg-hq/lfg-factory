import {test,expect,mock,beforeEach} from 'bun:test';
import {Database} from 'bun:sqlite';
import {drizzle} from 'drizzle-orm/bun-sqlite';
process.env.DATABASE_DRIVER='sqlite';
const sqlite=new Database(':memory:');
sqlite.exec(`CREATE TABLE ticket_log(id TEXT PRIMARY KEY,ticket_id TEXT,log_type TEXT,command TEXT,output TEXT,created_at INTEGER);
CREATE TABLE project_ticket(id TEXT PRIMARY KEY,project_id TEXT);
CREATE TABLE project(id TEXT PRIMARY KEY,project_id TEXT);
CREATE TABLE conversation(id TEXT PRIMARY KEY,project_id TEXT);
CREATE TABLE message(id TEXT PRIMARY KEY,conversation_id TEXT,role TEXT,user_role TEXT,content TEXT);`);
// Drizzle selects complete schema rows; create unused nullable columns from the schema.
const schema=await import('../src/db/schema/sqlite/index.ts');
const {getTableColumns,getTableName}=await import('drizzle-orm');
for(const table of [schema.ticketLogs,schema.projectTickets,schema.projects,schema.conversations,schema.messages]){
 const name=getTableName(table);const present=new Set((sqlite.query(`pragma table_info("${name}")`).all() as any[]).map(c=>c.name));
 for(const column of Object.values(getTableColumns(table)))if(!present.has(column.name))sqlite.exec(`ALTER TABLE "${name}" ADD COLUMN "${column.name}" TEXT`);
}
const database=drizzle(sqlite,{schema});
mock.module('../src/config/db.ts',()=>({db:database}));
let allowed=true;let canWrite=true;const delivered:any[]=[];
mock.module('../src/auth/project-access.ts',()=>({getProjectAccess:async()=>allowed?{permissions:{canChat:true,canEditFiles:true,canManageTickets:true}}:null}));
mock.module('../src/services/chat-access.ts',()=>({getChatAccess:async()=>({canWrite})}));
mock.module('../src/ws/connection-manager.ts',()=>({broadcastToUser:(_user:any,message:any)=>delivered.push(message)}));
mock.module('../src/services/dev-preview.ts',()=>({getPreviewState:async()=>({branch:'feature/t',previewStatus:'running'})}));
const {createTicketOperation,readTicketOperation,withTicketOperation,updateTicketOperation,recoverTicketOperations}=await import('../src/services/ticket-operations.ts');
const request={ticketId:'t',projectId:'p',userId:'u',conversationId:'c',turnId:'turn',message:'Fix button'};
beforeEach(()=>{for(const name of ['ticket_log','project_ticket','project','conversation','message'])sqlite.exec(`DELETE FROM "${name}"`);sqlite.exec("INSERT INTO project_ticket(id,project_id) VALUES('t','p'); INSERT INTO project(id,project_id) VALUES('p','public'); INSERT INTO conversation(id,project_id) VALUES('c','public');");allowed=true;canWrite=true;delivered.length=0;});
test('dispatch is authorized and deduplicated durably within a user turn',async()=>{
 const first=await createTicketOperation(request),again=await createTicketOperation(request);expect(first.created).toBe(true);expect(again.created).toBe(false);expect(again.operation.id).toBe(first.operation.id);
 const retried=await createTicketOperation({...request,turnId:'retry'});expect(retried.created).toBe(false);expect(retried.operation.id).toBe(first.operation.id);
 await expect(createTicketOperation({...request,projectId:'other'})).rejects.toThrow();allowed=false;await expect(createTicketOperation(request)).rejects.toThrow();allowed=true;canWrite=false;await expect(createTicketOperation(request)).rejects.toThrow();
});
test('only one executor claims an operation and result returns to its originating chat',async()=>{
 const {operation}=await createTicketOperation(request);let calls=0;
 const run=async()=>{calls++;await updateTicketOperation('completed','Fixed and published');};
 await Promise.all([withTicketOperation(operation.id,run),withTicketOperation(operation.id,run)]);
 expect(calls).toBe(1);expect((await readTicketOperation(operation.id))?.status).toBe('completed');expect(delivered).toHaveLength(1);expect(delivered[0].conversation_id).toBe('c');
 await updateTicketOperation('completed','Fixed and published',operation.id);expect(delivered).toHaveLength(1);
});
test('questions and failures are durable outcomes, restart never silently replays a mutation',async()=>{
 const {operation}=await createTicketOperation(request);await withTicketOperation(operation.id,async()=>{await updateTicketOperation('needs_input','Which screen?');});expect(delivered[0].message).toBe('Which screen?');
 const next=await createTicketOperation({...request,turnId:'next'});await recoverTicketOperations(Date.now()+1);expect((await readTicketOperation(next.operation.id))?.status).toBe('failed');expect((await readTicketOperation(operation.id))?.status).toBe('needs_input');
});

test('a blocking question can be answered from its originating chat without queuing another agent',async()=>{
 const {noteTicketOperationInput}=await import('../src/services/ticket-operations.ts');
 const {operation}=await createTicketOperation(request);
 await updateTicketOperation('running','Working',operation.id);
 await noteTicketOperationInput('t','Which color?',['Blue','Green']);
 expect((await readTicketOperation(operation.id))?.status).toBe('needs_input');
 const reply=await createTicketOperation({...request,turnId:'answer',message:'Blue'});
 expect(reply.created).toBe(false);expect(reply.operation.id).toBe(operation.id);expect(reply.operation.status).toBe('running');
 const notes=(sqlite.query("select notes from project_ticket where id='t'").get() as any).notes;expect(notes).toContain('INPUT_RESPONSE:t:Blue');
 await createTicketOperation({...request,turnId:'answer',message:'Blue'});expect((sqlite.query("select notes from project_ticket where id='t'").get() as any).notes).toBe(notes);
});

let epicCount=0;let buildCount=0;
mock.module('../src/services/epics.ts',()=>({createEpic:async()=>({id:'epic-'+(++epicCount)})}));
mock.module('../src/services/build-queue.ts',()=>({getActiveRun:async()=>null,createBuildRun:async()=>({runId:'run-'+(++buildCount),queued:1})}));
mock.module('../src/utils/ticket-keys.ts',()=>({nextTicketKey:async()=> 'TEST-1'}));
const {quickChangeTool}=await import('../src/ai/tools/quick-change-tools.ts');
test('quick change creates one ticket without documents and refuses unauthorized execution',async()=>{
 sqlite.exec("UPDATE project SET repo_name='existing',name='Example' WHERE id='p'");epicCount=0;buildCount=0;
 const tool=quickChangeTool({projectId:'p',userId:'u',conversationId:'c',turnId:'quick'});
 const args={approvedByUser:true as const,name:'Fix button',description:'Correct the existing button color in the header.',acceptanceCriteria:['Header button uses the approved color','Keyboard focus stays visible']};
 const first=await tool.execute!(args,{} as any);expect(first).toHaveProperty('ticketId');expect(epicCount).toBe(1);
 await tool.execute!(args,{} as any);expect(epicCount).toBe(1);expect((sqlite.query("SELECT count(*) AS count FROM project_ticket").get() as any).count).toBe(2);
 allowed=false;expect(await tool.execute!(args,{} as any)).toHaveProperty('error');
});
