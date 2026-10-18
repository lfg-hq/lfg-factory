import {createHash} from 'node:crypto';
import {loadAppProfile,saveAppProfile} from './app-profile.ts';
import {encryptSecret,decryptSecret} from '../utils/crypto.ts';
export interface PreviewAccount {identity:string;connectionKey:string;username:string;passwordEncrypted:string;verifiedAt:string}
export function databaseIdentity(connection:{engine:string;host:string;port:number;database:string}) {
 return createHash('sha256').update(JSON.stringify([connection.engine,connection.host,connection.port,connection.database])).digest('hex');
}
export async function storePreviewAccount(projectId:string,branch:string,account:Omit<PreviewAccount,'passwordEncrypted'|'verifiedAt'> & {password:string}) {
 const loaded=await loadAppProfile(projectId,branch);if(!loaded)throw Error('Selected runtime profile is unavailable');
 const passwordEncrypted=encryptSecret(account.password);
 if(!passwordEncrypted.startsWith('gcm:'))throw Error('Encrypted credential storage is unavailable. Configure ENCRYPTION_KEY; the verified login was not saved.');
 const {password,...publicFields}=account;
 const entry:PreviewAccount={...publicFields,passwordEncrypted,verifiedAt:new Date().toISOString()};
 loaded.profile.previewAccounts=[...(loaded.profile.previewAccounts||[]).filter(a=>a.identity!==entry.identity||a.username!==entry.username),entry];
 await saveAppProfile(projectId,loaded.profile,branch);
}
export async function recallPreviewAccounts(projectId:string,branch:string,identity:string) {
 const loaded=await loadAppProfile(projectId,branch);
 return (loaded?.profile.previewAccounts||[]).filter(a=>a.identity===identity).map(({passwordEncrypted,...a})=>({...a,password:decryptSecret(passwordEncrypted)}));
}
