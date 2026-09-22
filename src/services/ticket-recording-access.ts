type Dependencies={
 publicProjectForTicket:(ticketId:string)=>Promise<string|null>;
 projectAccess:(publicProjectId:string,userId:string)=>Promise<unknown>;
};
/** Ticket rows reference projects.id; authorization requires projects.projectId. */
export async function canReadTicketRecording(ticketId:string,userId:string,deps?:Dependencies):Promise<boolean>{
 if(!deps){
  const [{db},{projectTickets},{projects},{eq},{getProjectAccess}]=await Promise.all([
   import('../config/db.ts'),import('../db/schema/tickets.ts'),import('../db/schema/projects.ts'),import('drizzle-orm'),import('../auth/project-access.ts'),
  ]);
  deps={publicProjectForTicket:async id=>{
   const [row]=await db.select({publicProjectId:projects.projectId}).from(projectTickets).innerJoin(projects,eq(projectTickets.projectId,projects.id)).where(eq(projectTickets.id,id)).limit(1);
   return row?.publicProjectId??null;
  },projectAccess:getProjectAccess};
 }
 const publicId=await deps.publicProjectForTicket(ticketId);
 return publicId!==null && !!await deps.projectAccess(publicId,userId);
}
