import { describe,it,expect } from 'bun:test';
import { graphCandidates,graphHash,validateGraphSuggestions } from '../src/services/document-graph-analysis.ts';
import { connectorDocument,connectorDocuments } from '../src/services/document-graph-connector-data.ts';
import type { ReadableGraphNode } from '../src/services/document-graph-types.ts';
const node=(id:string,text:string,kind:ReadableGraphNode['kind']='document'):ReadableGraphNode=>({id,name:id,text,kind,hash:graphHash(text)});
describe('document graph classifier boundary',()=>{
  it('rejects unknown IDs, self-links, weak evidence, duplicate targets, and non-epic relevance',()=>{
    const source=node('source','payments'),epic=node('epic','payments','epic'),doc=node('doc','payments');
    const raw=JSON.stringify({links:[
      {target:'foreign',relation:'related_to',confidence:.99,reason:'unknown'},
      {target:'source',relation:'related_to',confidence:.99,reason:'self'},
      {target:'doc',relation:'relevant_to',confidence:.99,reason:'not an epic'},
      {target:'epic',relation:'relevant_to',confidence:.5,reason:'weak'},
      {target:'epic',relation:'relevant_to',confidence:.9,reason:'same acceptance criteria'},
      {target:'epic',relation:'related_to',confidence:.9,reason:'duplicate'},
    ]});
    expect(validateGraphSuggestions(raw,source,[doc,epic])).toEqual([{source:'source',target:'epic',relation:'relevant_to',confidence:.9,reason:'same acceptance criteria',origin:'suggested'}]);
  });
  it('rejects malformed output rather than inventing links',()=>{
    expect(()=>validateGraphSuggestions('not json',node('a',''),[])).toThrow();
    expect(()=>validateGraphSuggestions('{"links":[{"target":"b"}]}',node('a',''),[])).toThrow();
  });
  it('bounds and ranks candidates without including the source',()=>{
    const a=node('a','payment billing checkout'); const nodes=[a,node('relevant','payment billing checkout'),...Array.from({length:50},(_,i)=>node('other'+i,'garden'))];
    const result=graphCandidates(a,nodes);expect(result).toHaveLength(24);expect(result[0]?.id).toBe('relevant');expect(result.some(n=>n.id==='a')).toBe(false);
  });
});
describe('connected document ingestion',()=>{
  it('captures document text and identity without persisting secrets or arguments',()=>{
    const doc=connectorDocument('NOTION_GET_PAGE',{}, {data:{id:'page1',title:'Plan',content:'Billing requirements',access_token:'secret',url:'https://notion.so/page1'}});
    expect(doc?.content).toBe('Billing requirements');expect(doc?.identity).toBe('page1');expect(JSON.stringify(doc)).not.toContain('secret');
  });
  it('ignores mutations, search, errors, unrelated services, and credential URLs',()=>{
    for(const name of ['NOTION_UPDATE_PAGE','NOTION_SEARCH','GMAIL_GET_MESSAGE'])expect(connectorDocument(name,{}, {content:'text'})).toBeNull();
    expect(connectorDocument('NOTION_GET_PAGE',{}, {successful:false,data:{content:'failed'}})).toBeNull();
    expect(connectorDocument('NOTION_GET_PAGE',{}, {content:'body',url:'https://host/doc?token=secret'})?.url).toBeNull();
  });
  it('handles MCP and Composio multi-execute results only for requested read tools',()=>{
    const results={data:{results:[{tool_slug:'NOTION_GET_PAGE',response:{data:{id:'p',content:'Page body'}}},{tool_slug:'NOTION_DELETE_PAGE',response:{content:'deleted'}}]}};
    const docs=connectorDocuments('COMPOSIO_MULTI_EXECUTE_TOOL',{tools:[{tool_slug:'NOTION_GET_PAGE',arguments:{page_id:'p'}}]},{content:[{type:'text',text:JSON.stringify(results)}]});
    expect(docs).toHaveLength(1);expect(docs[0]?.content).toBe('Page body');
  });
  it('caps source text and handles cyclic or deeply nested data',()=>{
    expect(connectorDocument('GOOGLEDOCS_GET_DOCUMENT',{}, {content:'a'.repeat(20000)})?.content.length).toBeLessThanOrEqual(12000);
    const cycle:any={};cycle.data=cycle;expect(connectorDocument('NOTION_GET_PAGE',{},cycle)).toBeNull();
  });
});
