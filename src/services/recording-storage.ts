import {mkdir,writeFile,unlink} from 'node:fs/promises';
/** This storage belongs to the LFG server, never the ticket VM. */
export class RecordingStorageError extends Error {
 constructor(directory:string,error:unknown){
  const code=(error as NodeJS.ErrnoException).code || 'IO_ERROR';
  super(`LFG recorder storage unavailable (${code}): ${directory}. The LFG server user (uid ${process.getuid?.() ?? 'unknown'}) cannot write temporary capture files. Check the LFG server's temporary-directory permissions and disk capacity; changing /app/uploads inside the ticket sandbox cannot fix this. No browser was launched.`);
  this.name='RecordingStorageError';
 }
}
export async function prepareRecordingDirectory(directory:string){
 const probe=directory+'/.write-check-'+crypto.randomUUID();
 try{await mkdir(directory,{recursive:true});await writeFile(probe,'',{flag:'wx'});await unlink(probe);}
 catch(error){throw new RecordingStorageError(directory,error);}
}
