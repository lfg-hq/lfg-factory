import { env } from '../../config/env.ts';
import { sealDesignBaseline } from '../../services/design-baseline.ts';
import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../config/db.ts';
import { projects } from '../../db/schema/projects.ts';
import { projectFiles } from '../../db/schema/documents.ts';
import { githubTokens } from '../../db/schema/users.ts';
import { getProjectAccess } from '../../auth/project-access.ts';
import { resolveGitActor } from '../../services/git-access.ts';
import { getValidGitlabToken } from '../../services/gitlab-token.ts';
import { getRepoReader } from '../../services/repo-reader.ts';
import { saveContent } from '../../services/s3.ts';

export async function designProject(projectId:string,userId:string) {
 const [project]=await db.select().from(projects).where(eq(projects.id,projectId));
 if(!project) throw new Error('Project not found');
 const access=await getProjectAccess(project.projectId,userId);
 if(!access?.permissions.canEditFiles) throw new Error('Project file editing access is required');
 return project;
}
export const readDesignSource = tool({
 description:'Read exact UI source files, without an AI summary, pinned to one repository commit. First use queryCodebase to locate the actual layout/navigation, affected page and styles. Read these files before proposing app UI; preserve their labels and structure. Never read secrets or environment files.',
 inputSchema:zodSchema(z.object({projectId:z.string(),userId:z.string(),branch:z.string().optional(),paths:z.array(z.string().min(1)).min(1).max(12)})),
 execute:async({projectId,userId,branch,paths})=>{
  const project=await designProject(projectId,userId);
  const actor=resolveGitActor(project,userId);
  const provider=project.repoProvider==='gitlab'?'gitlab':'github';
  const token=provider==='gitlab' ? await getValidGitlabToken(actor.gitUserId) : (await db.select().from(githubTokens).where(eq(githubTokens.userId,actor.gitUserId)))[0]?.accessToken;
  if(!token||!project.repoOwner||!project.repoName) return {error:'Connect repository access before reading UI source.'};
  const reader=getRepoReader(provider);
  const ref=branch || (await reader.getRepoInfo(project.repoOwner,project.repoName,token))?.defaultBranch;
  if(!ref) return {error:'Could not resolve the repository branch.'};
  const commit=await reader.getRefSha(project.repoOwner,project.repoName,ref,token);
  if(!commit) return {error:'Could not pin the repository commit.'};
  const files=[];
  for(const path of paths) {
   if(path.startsWith('/')||path.split('/').some(p=>p==='..'||p.startsWith('.env')||p==='.git')||/\.(pem|key|p12)$/i.test(path)) throw new Error('Use UI source paths only, without secrets or traversal.');
   const content=await reader.readFile(project.repoOwner,project.repoName,path,commit,token,60000);
   files.push({path,content});
  }
  return {branch:ref,commit,files,instruction:'Use the actual layout and styles. A source read is not visual verification. Capture the running screen with captureDesignLayout before claiming layout fidelity.'};
 }
});
export const captureDesignLayout=tool({
 description:'Capture the REAL running project preview at 1440×900. Saves an immutable layout screenshot and a selected feature region. previewPage can replace ONLY that region; surrounding menus are preserved pixel-for-pixel. Use a selector from readDesignSource, excluding global navigation. Does not start builds, alter app code, or use production. If unavailable, explain the limitation and label standalone previews approximate.',
 inputSchema:zodSchema(z.object({projectId:z.string(),userId:z.string(),path:z.string().startsWith('/'),selector:z.string().min(1).max(300)})),
 execute:async({projectId,userId,path,selector})=>{
  await designProject(projectId,userId);
  const {getPreviewState}=await import('../../services/dev-preview.ts');
  const state=await getPreviewState(projectId);
  if(state.previewStatus!=='running'||!state.previewUrl) return {error:'The project preview is not running. Start its Preview environment to capture the real layout, or offer an explicitly approximate standalone mockup.'};
  try{
   const {captureDesignBaseline}=await import('../../services/capture-design-baseline.ts');
   const baseline=await captureDesignBaseline({projectId,previewUrl:state.previewUrl,branch:state.branch,path,selector});
   const name=`App layout ${new Date().toISOString()} ${crypto.randomUUID()}`;
   const stored=await saveContent(projectId,'design_baseline',name,sealDesignBaseline(baseline,env.BETTER_AUTH_SECRET));
   const [file]=await db.insert(projectFiles).values({projectId,epicId:'',name,fileType:'design_baseline',content:stored.dbContent,s3Key:stored.s3Key}).returning();
   return {baselineId:file!.id,branch:baseline.branch,path,capturedAt:baseline.capturedAt,region:baseline.region,viewport:{width:1440,height:900},instruction:'Pass baselineId to previewPage and provide HTML for ONLY the selected feature region. The real shell is a static visual reference; mock interactions work inside the region. Do not claim this is the implemented app or that navigation is interactive.'};
  }catch(e){return {error:`Cannot capture the actual app layout: ${(e as Error).message}. Do not invent a replacement shell and call it faithful.`};}
 }
});
