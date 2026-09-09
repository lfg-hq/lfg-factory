import {test,expect} from "bun:test";
import {ticketDocumentPath,appendTicketDocument,ticketDocumentMessage,writeTicketDocumentScript} from "../src/services/ticket-document.ts";
import {mkdtempSync,readFileSync,mkdirSync,symlinkSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";
test('branch filenames are stable, contained and distinguish slug collisions',()=>{
 const branch='feature/COH-24 Workforce';
 expect(ticketDocumentPath(branch)).toBe(ticketDocumentPath(branch));
 expect(ticketDocumentPath(branch)).toMatch(/^docs\/feature-coh-24-workforce-[a-f0-9]{8}\.md$/);
 expect(ticketDocumentPath('feature/A')).not.toBe(ticketDocumentPath('feature-a'));
 expect(ticketDocumentPath('../../bad')).not.toContain('..');
});
test('updates preserve history; the same source tree does not append twice',()=>{
 const first=appendTicketDocument('','feature/a','a','First summary','### Implementation\nFirst implementation.','2026-09-09','Ticket title');
 const second=appendTicketDocument(first,'feature/a','b','Second summary','### Validation\nSecond evidence.','2026-09-10');
 expect(second).toContain(first.trim());expect(second).toContain('Second summary');expect(second).toStartWith('# Ticket title');
 expect(appendTicketDocument(second,'feature/a','b','duplicate','wrong','later')).toBe(second);
});
test('document writes are atomic and reject repository symlinks',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ticket-doc-'));const other=mkdtempSync(join(tmpdir(),'ticket-doc-outside-'));
 const run=(script:string)=>spawnSync('bash',['-c',script],{encoding:'utf8'});
 try{
  const path=ticketDocumentPath('feature/a');expect(run(writeTicketDocumentScript(dir,path,'first')).status).toBe(0);
  expect(run(writeTicketDocumentScript(dir,path,'first\nsecond')).status).toBe(0);
  expect(readFileSync(join(dir,path),'utf8')).toBe('first\nsecond');
  expect(run(writeTicketDocumentScript(dir,path,'overwrite','first')).status).not.toBe(0);
  expect(readFileSync(join(dir,path),'utf8')).toBe('first\nsecond');
  rmSync(join(dir,'docs'),{recursive:true});symlinkSync(other,join(dir,'docs'));
  expect(run(writeTicketDocumentScript(dir,path,'escaped')).status).not.toBe(0);
 }finally{rmSync(dir,{recursive:true,force:true});rmSync(other,{recursive:true,force:true});}
});
test('Agent message links to the document on the correct branch',()=>{
 expect(ticketDocumentMessage('feature/a','https://github.com/org/repo.git','Added validation.')).toContain('/blob/feature%2Fa/docs/feature-a-');
 expect(ticketDocumentMessage('feature/a','https://gitlab.com/org/repo.git','Added validation.')).toContain('/-/blob/feature%2Fa/docs/feature-a-');
});
