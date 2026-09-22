import {expect,test} from 'bun:test';
import {canReadTicketRecording} from '../src/services/ticket-recording-access.ts';
test('uses the resolved public project ID for artifact authorization',async()=>{
 expect(await canReadTicketRecording('ticket-25','owner',{
  publicProjectForTicket:async ticket=>{expect(ticket).toBe('ticket-25');return 'public-project-id';},
  projectAccess:async(project,user)=>{expect(project).toBe('public-project-id');expect(user).toBe('owner');return {role:'owner'};},
 })).toBe(true);
});
test('denies other users and missing tickets without exposing artifacts',async()=>{
 expect(await canReadTicketRecording('ticket','outsider',{publicProjectForTicket:async()=> 'public-id',projectAccess:async()=>null})).toBe(false);
 expect(await canReadTicketRecording('missing','owner',{publicProjectForTicket:async()=>null,projectAccess:async()=>{throw Error('Must not authorize an unknown ticket');}})).toBe(false);
});
