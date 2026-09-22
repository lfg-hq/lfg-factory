import {shellQuote as q} from './preview-plan.ts';

type Options={
 localUrl:string;
 shell:(command:string)=>Promise<{exitCode:number;output:string}>;
 progress:(message:string)=>Promise<void>;
};
const readyStatus=(status:number)=>status>=200 && status<400 || status===401 || status===403;

/** Check the existing process, without starting a second app or assuming a port is healthy. */
export async function checkLocalFeatureApp(o:Options):Promise<void>{
 await o.progress(`**App readiness:** Checking the existing server at ${o.localUrl} in the saved ticket sandbox.`);
 const result=await o.shell(`curl --silent --show-error --output /dev/null --write-out '\\nLFG_HTTP_STATUS=%{http_code}\\n' --connect-timeout 5 --max-time 15 ${q(o.localUrl)}`);
 const status=Number(result.output.match(/LFG_HTTP_STATUS=(\d{3})/)?.[1]||0);
 if(result.exitCode!==0 || !readyStatus(status))throw Error(`App readiness failed in the saved sandbox: ${o.localUrl}; curl exit ${result.exitCode}, HTTP ${status||'unavailable'}. Browser was not opened. Inspect the app startup command and server log before retrying.`);
 await o.progress(`**App readiness:** Existing server responded at ${o.localUrl} — HTTP ${status}${status===401||status===403?' (authentication required)':''}. Reusing this process; no new app was started.`);
}

export async function checkPublicFeatureApp(url:string,progress:Options['progress'],request:typeof fetch=fetch):Promise<void>{
 await progress(`**Preview readiness:** Checking [${url}](${url}) before opening the browser.`);
 let response:Response;
 try{response=await request(url,{redirect:'manual',signal:AbortSignal.timeout(15000)});}
 catch{throw Error(`Preview readiness failed: ${url} did not respond within the connection check. The app responded inside its sandbox, but the public route is unavailable. Browser was not opened.`);}
 await response.body?.cancel();
 if(!readyStatus(response.status))throw Error(`Preview readiness failed: ${url} returned HTTP ${response.status}. The app responded inside its sandbox, but the public route did not pass. Browser was not opened.`);
 await progress(`**Preview ready:** [${url}](${url}) — HTTP ${response.status}. Opening the test browser now.`);
}
