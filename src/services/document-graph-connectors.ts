import { connectorDocuments } from './document-graph-connector-data.ts';
import { graphHash } from './document-graph-analysis.ts';
import { db } from '../config/db.ts';
import { documentGraphSources } from '../db/schema/document-graph.ts';
import { ensureDocumentGraph } from './document-graph.ts';

export function wrapGraphConnectorTools<T extends Record<string,any>>(tools:T,projectId:string,userId:string):T {
  return Object.fromEntries(Object.entries(tools).map(([name,definition])=>{
    if(typeof definition?.execute!=='function') return [name,definition];
    return [name,{...definition,execute:async (...args:any[])=>{
      const result=await definition.execute(...args);
      // Preserve the original tool outcome even when graph storage is unavailable.
      try {
        for (const doc of connectorDocuments(name,args[0],result)) {
          const id=graphHash(JSON.stringify([projectId,userId,doc.provider,doc.identity]));
          const {identity,...fields}=doc;
          await db.insert(documentGraphSources).values({id,projectId,userId,...fields}).onConflictDoUpdate({target:documentGraphSources.id,set:fields});
          await ensureDocumentGraph(projectId,userId);
        }
      } catch(e) { console.warn('[document-graph] connector capture unavailable',(e as Error).name); }
      return result;
    }}];
  })) as T;
}
