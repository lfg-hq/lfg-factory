import { graphHash } from './document-graph-analysis.ts';
// Only document-read operations are eligible. Never persist complete connector
// envelopes, request arguments, credentials, or results of mutations.
export function connectorDocument(toolName:string,input:unknown,result:unknown) {
  const args=input && typeof input==='object' ? input as Record<string,unknown> : {};
  const slug=String(args.tool_slug ?? args.toolSlug ?? args.tool_name ?? toolName);
  if(!/(NOTION|GOOGLE.?DOCS|GOOGLE.?DRIVE|CONFLUENCE)/i.test(slug) || !/(GET|FETCH|READ|RETRIEVE|EXPORT)/i.test(slug) || /(CREATE|UPDATE|DELETE|SEARCH|LIST|AUTH|TOKEN)/i.test(slug)) return null;
  const texts:string[]=[]; let title=''; let url=''; let externalId=''; let size=0;
  function walk(value:unknown,depth=0) {
    if(depth>10 || size>=12000 || !value || typeof value!=='object') return;
    if(Array.isArray(value)) { for(const item of value.slice(0,100)) walk(item,depth+1); return; }
    const obj=value as Record<string,unknown>;
    if(obj.successful===false || obj.success===false || obj.error) return;
    if(!title && typeof obj.title==='string') title=obj.title.slice(0,200);
    if(!externalId && typeof obj.id==='string') externalId=obj.id;
    if(!url && typeof obj.url==='string' && /^https?:\/\//i.test(obj.url)) {
      try { const u=new URL(obj.url); if(!u.username&&!u.password&&!u.search) url=u.href; } catch {}
    }
    for(const [key,item] of Object.entries(obj)) {
      if(/^(plain_text|content|text|markdown|body)$/i.test(key)&&typeof item==='string') { const part=item.slice(0,12000-size); texts.push(part); size+=part.length; }
      else if(/^(data|response|result|results|blocks|children|rich_text|paragraph|heading_[123]|text|body|content|document|elements|paragraphs|textRun)$/i.test(key)) walk(item,depth+1);
    }
  }
  walk(result);
  const content=texts.join('\n');
  if(!content.trim()) return null;
  // Identity comes from the resource, never from a transient tool-call ID.
  const resource=externalId || url || String(args.page_id??args.document_id??args.file_id??'');
  return {name:title||slug.replace(/_/g,' '),content,url:url||null,provider:slug.split('_')[0]!,identity:resource||graphHash(content)};
}

export function connectorDocuments(name:string,input:unknown,result:unknown) {
  // Composio may return JSON inside MCP text blocks, or a multi-execute envelope.
  let payload=result;
  if (payload && typeof payload==='object' && Array.isArray((payload as any).content)) {
    const text=(payload as any).content.find((c:any)=>c.type==='text'&&typeof c.text==='string')?.text;
    if(text) try { payload=JSON.parse(text); } catch {}
  }
  const direct=connectorDocument(name,input,payload);
  if(direct) return [direct];
  const args=input as any, output=payload as any;
  if(!/MULTI_EXECUTE/i.test(name)||!Array.isArray(args?.tools)) return [];
  const results=output?.data?.results ?? output?.results;
  if(!Array.isArray(results)) return [];
  return results.slice(0,20).flatMap((entry:any)=>{
    const slug=entry?.tool_slug;
    const request=args.tools.find((t:any)=>t.tool_slug===slug);
    if(!request||typeof slug!=='string')return [];
    const doc=connectorDocument(slug,request.arguments,entry.response??entry.result);
    return doc?[doc]:[];
  });
}
