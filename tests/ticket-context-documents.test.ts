import {test,expect} from 'bun:test';
import {selectTicketContextDocuments as select,ticketDocumentInstructions} from '../src/services/ticket-context-documents.ts';
const id='8b21cc0d-c9f5-42a8-ba5c-a0043a57f245';
const doc=(id:string,overrides={})=>({id,projectId:'project',epicId:'',name:id,fileType:'spec',isActive:true,...overrides});
const ctx={projectId:'project',epicId:'epic',text:'',linkedIds:[] as string[]};
test('requirements reach builder even without UUIDs in ticket prose',()=>{
 const rows=[doc('rules'),doc('prd',{fileType:'prd'}),doc('own',{epicId:'epic'}),doc('linked',{fileType:'research'}),doc('other',{epicId:'other'}),doc('inactive',{isActive:false}),doc('foreign',{projectId:'other'}),doc('preview',{fileType:'page_preview'})];
 expect(select(rows,{...ctx,linkedIds:['linked','foreign','preview']}).map(d=>d.id)).toEqual(['linked','own','prd','rules']);
});
test('explicit design references and structured source document are preserved',()=>{
 const rows=[doc(id,{fileType:'page_preview'}),doc('source',{fileType:'other'})];
 expect(select(rows,{...ctx,text:`Approved design document ${id}`,sourceDocumentId:'source'})).toHaveLength(2);
 expect(()=>select(rows,{...ctx,sourceDocumentId:'missing'})).toThrow('missing or inactive');
 expect(()=>select([doc('source',{projectId:'foreign'})],{...ctx,sourceDocumentId:'source'})).toThrow();
});
test('document context conveys full requirements without inventing approval',()=>{
 const prompt=ticketDocumentInstructions([{name:'Rules',fileType:'spec',path:'/data/project/.lfg/context/rules.md'}]);
 expect(prompt).toContain('/data/project/.lfg/context/rules.md');expect(prompt).toContain('rule tables');expect(prompt).toContain('approval must be explicit');
 expect(ticketDocumentInstructions([])).toContain('No saved requirements documents');
});
