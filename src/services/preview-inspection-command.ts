/** Compile a small inspection language, never execute the model's raw shell text.
 * No interpreters, SQL clients, docker exec, environment assignments or write modes.
 * This is a capability boundary for chat, not an OS sandbox for hostile binaries.
 */
export function compilePreviewInspection(command: string): {ok:true;command:string}|{ok:false;reason:string} {
  const deny = (reason:string) => ({ok:false as const, reason});
  if (!command.trim()) return deny('empty command');
  if (/[`$<>\\\n\r]/.test(command)) return deny('shell expansion, redirection and escapes are unavailable');
  const groups:string[][] = [[]];
  const operators:string[] = [];
  const pattern = /\s+|'([^']*)'|"([^"]*)"|(\|\||&&|[|;])|([^\s'"|;&]+)/gy;
  let pos=0;
  while(pos<command.length) {
    pattern.lastIndex=pos;
    const m=pattern.exec(command);
    if(!m) return deny('unsupported shell syntax');
    pos=pattern.lastIndex;
    if(/^\s+$/.test(m[0]))continue;
    if(m[3]) {if(!groups.at(-1)!.length)return deny('empty command segment'); operators.push(m[3]);groups.push([]);}
    else groups.at(-1)!.push(m[1]??m[2]??m[4]!);
  }
  const files=new Set(['cat','head','tail','ls','grep','egrep','fgrep','wc','stat','file','ps','df','du','free','pwd','whoami','hostname','uname','id','nl','cut','tr','uniq']);
  const git=new Set(['status','log','diff','show','rev-parse','ls-files','ls-tree','describe','blame','shortlog','name-rev','for-each-ref','show-ref','count-objects']);
  for(const args of groups) {
    const [bin,...rest]=args;
    if(!bin)return deny('empty command segment');
    if(files.has(bin)) {
      if(bin==='file' && rest.some(x=>/^(--compile|-C)$/.test(x)))return deny('file compilation is unavailable');
      continue;
    }
    if(bin==='rg') {
      if(rest.some(x=>/^--(pre|hostname-bin|search-zip)/.test(x)))return deny('search helpers are unavailable');
      continue;
    }
    if(bin==='docker') {
      if(!['ps','logs','images','inspect','top','stats','version','info'].includes(rest[0]??''))return deny('docker inspection only; no exec or changes');
      continue;
    }
    if(bin==='git') {
      const [sub,...flags]=rest;
      const special=(sub==='branch' && flags.every(x=>['-a','-r','-v','-vv','--list','--show-current'].includes(x))) || (sub==='worktree' && flags.join(' ')==='list');
      if(!git.has(sub??'') && !special)return deny('git inspection only; no branch changes or configuration');
      if(flags.some(x=>/^--(output|ext-diff|textconv|exec|config|paginate|open-files-in-pager)/.test(x)))return deny('git output files and external helpers are unavailable');
      // Disable optional index refresh and configured external diff/text conversion.
      args.splice(1,0,'--no-pager');
      if(['diff','show','log'].includes(sub!))args.push('--no-ext-diff','--no-textconv');
      continue;
    }
    if(bin==='curl') {
      for(let i=0;i<rest.length;i++) {
        const arg=rest[i]!;
        if(/^https?:\/\/[^\s]+$/.test(arg) || /^-[sSfIiL]+$/.test(arg) || ['--silent','--show-error','--fail','--head','--include','--location'].includes(arg))continue;
        if(['--max-time','--connect-timeout'].includes(arg) && /^\d+$/.test(rest[++i]??''))continue;
        return deny('curl supports HTTP GET/HEAD inspection only, without file output or custom commands');
      }
      args.splice(1,0,'--disable','--proto','=http,https','--proto-redir','=http,https','--max-time','20');
      continue;
    }
    return deny(`${bin} is unavailable in chat inspection; use ticket execution for application changes`);
  }
  const quote=(s:string)=>`'${s.replace(/'/g,"'\\''")}'`;
  return {ok:true,command:groups.map((args,i)=>`${i?operators[i-1]+' ':''}${args[0]==='git'?'GIT_OPTIONAL_LOCKS=0 ':''}${args.map(quote).join(' ')}`).join(' ')};
}
