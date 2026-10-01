import {test,expect} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {extractDocumentText} from '../src/services/chat-document-text.ts';
test('reads Word paragraphs and table cells',async()=>{
 const bytes=await readFile(new URL('./fixtures/chat-upload.docx',import.meta.url));
 const text=await extractDocumentText(bytes,'requirements.docx','application/octet-stream');
 expect(text).toContain('Invoice requirements');
 expect(text).toContain('Supplier and amount');
});
test('reports unreadable attachments instead of pretending they are absent',async()=>{
 await expect(extractDocumentText(Buffer.from('broken'),'file.docx','')).rejects.toThrow();
 await expect(extractDocumentText(Buffer.from('legacy'),'file.doc','application/msword')).rejects.toThrow('not supported');
});
test('bounds plain text context and reports truncation',async()=>{
 expect(await extractDocumentText(Buffer.from('hello'),'file.txt','text/plain')).toBe('hello');
 const text=await extractDocumentText(Buffer.from('a'.repeat(70000)),'notes.md','');
 expect(text).toContain('truncated');expect(text.length).toBeLessThan(60100);
});
