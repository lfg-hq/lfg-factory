import type { WSIncoming } from './types.ts';
export type ChatRequest = Extract<WSIncoming, {type:'message'}>;
export class FollowupQueue {
  readonly items: Array<{id:string;request:ChatRequest}> = [];
  steeringId?: string;
  add(request:ChatRequest) {
    const id=request.client_message_id || crypto.randomUUID();
    if(this.items.some(item=>item.id===id))return id;
    if(this.items.length>=10)throw new Error('The queue is full (10 messages). Remove a queued message before adding another.');
    this.items.push({id,request});return id;
  }
  remove(id:string) {const i=this.items.findIndex(item=>item.id===id);if(i>=0)this.items.splice(i,1);}
  steer(id:string) {
    const i=this.items.findIndex(item=>item.id===id);if(i<0)return false;
    const [item]=this.items.splice(i,1);this.items.unshift(item!);this.steeringId=id;return true;
  }
  next(){const item=this.items.shift();if(item?.id===this.steeringId)this.steeringId=undefined;return item;}
  snapshot(){return this.items.map(({id,request})=>({id,steering:id===this.steeringId,message:request.display_message ?? request.message,files:request.files ?? []}));}
}
