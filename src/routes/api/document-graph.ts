import { Hono } from 'hono';
import { z } from 'zod';
import { and,eq } from 'drizzle-orm';
import { requireAuth } from '../../auth/middleware.ts';
import type { auth } from '../../auth/index.ts';
import { getProjectAccess } from '../../auth/project-access.ts';
import { db } from '../../config/db.ts';
import { documentGraphs,documentGraphLinks } from '../../db/schema/document-graph.ts';
import { readDocumentGraph,collectGraph,ensureDocumentGraph,graphId } from '../../services/document-graph.ts';
import { graphHash } from '../../services/document-graph-analysis.ts';
const router=new Hono<{Variables:{user:typeof auth.$Infer.Session.user;session:typeof auth.$Infer.Session.session}}>();
router.use('*',requireAuth);
router.get('/:projectId/document-graph',async c=>{
  const user=c.get('user'); const access=await getProjectAccess(c.req.param('projectId'),user.id);
  if(!access) return c.json({error:'Project not found'},404);
  return c.json({...await readDocumentGraph(access.project,user.id),canEdit:access.permissions.canEditFiles});
});
router.post('/:projectId/document-graph/retry',async c=>{
  const user=c.get('user'); const access=await getProjectAccess(c.req.param('projectId'),user.id);
  if(!access) return c.json({error:'Project not found'},404);
  if(!access.permissions.canEditFiles) return c.json({error:'Editing permission required'},403);
  await ensureDocumentGraph(access.project.id,user.id);
  // Do not invalidate an active lease or allow repeated clicks to duplicate work.
  const [state]=await db.select().from(documentGraphs).where(eq(documentGraphs.id,graphId(access.project.id,user.id)));
  if(state?.status!=='indexing') await db.update(documentGraphs).set({checkedAt:0,status:'pending',error:null}).where(and(eq(documentGraphs.id,state!.id),eq(documentGraphs.checkedAt,state!.checkedAt)));
  return c.json({ok:true});
});
const linkInput=z.object({source:z.string().max(200),target:z.string().max(200),relation:z.enum(['related_to','relevant_to','source_for']),decision:z.enum(['accepted','rejected','remove'])});
router.post('/:projectId/document-graph/links',async c=>{
  const user=c.get('user');const access=await getProjectAccess(c.req.param('projectId'),user.id);
  if(!access) return c.json({error:'Project not found'},404);
  if(!access.permissions.canEditFiles) return c.json({error:'Editing permission required'},403);
  const parsed=linkInput.safeParse(await c.req.json().catch(()=>null));
  if(!parsed.success) return c.json({error:'Invalid relationship'},400);
  const {source,target,relation,decision}=parsed.data;
  const {nodes}=await collectGraph(access.project,user.id);
  const from=nodes.find(n=>n.id===source),to=nodes.find(n=>n.id===target);
  if(!from||!to||source===target||['epic','ticket'].includes(from.kind)||(relation==='relevant_to'&&to.kind!=='epic')) return c.json({error:'Invalid or inaccessible document relationship'},400);
  const id=graphHash(JSON.stringify([access.project.id,user.id,source,target,relation]));
  if(decision==='remove') await db.delete(documentGraphLinks).where(eq(documentGraphLinks.id,id));
  else await db.insert(documentGraphLinks).values({id,projectId:access.project.id,userId:user.id,source,target,relation,decision}).onConflictDoUpdate({target:documentGraphLinks.id,set:{decision}});
  return c.json({ok:true});
});
export default router;
