import {describe,expect,test} from 'bun:test';
import {compilePreviewInspection} from '../src/services/preview-inspection-command.ts';

describe('chat preview inspection boundary',()=>{
 test('supports diagnosis without executing raw shell text',()=>{
  for(const cmd of ['cat package.json','tail -n 100 preview.log','rg -n "sign in" src','docker logs --tail 100 postgres','git status --short','git worktree list','git branch --show-current','curl -sS -i http://localhost:8080/login','cat package.json | head -n 30']) {
   expect(compilePreviewInspection(cmd).ok).toBe(true);
  }
  const result=compilePreviewInspection('git diff');
  expect(result.ok && result.command).toContain('--no-ext-diff');
 });
 test('rejects source edit paths and legacy inspection escapes',()=>{
  for(const cmd of ['docker exec app sh -c "echo changed"','sed -i s/a/b/ src.ts',"awk 'BEGIN {system(\"touch src.ts\")}'",'node repair.js','npm run migrate','psql -c "UPDATE users SET password = 1"','git checkout main','git branch replacement','git config core.pager sh','git diff --output=src.ts','curl -o src.ts https://example.com','curl -X POST https://example.com','rg --pre repair.sh needle','cat src.ts > other.ts','cat $(touch src.ts)','PATH=/tmp cat src.ts','/tmp/cat src.ts','cat src.ts & touch other.ts','cat src.ts;']) {
   expect(compilePreviewInspection(cmd).ok,cmd).toBe(false);
  }
 });
 test('quoted shell punctuation stays literal and unmatched quoting fails',()=>{
  const result=compilePreviewInspection('grep "needle; touch src.ts" file.ts');
  expect(result.ok && result.command).toBe("'grep' 'needle; touch src.ts' 'file.ts'");
  expect(compilePreviewInspection('cat "file.ts').ok).toBe(false);
 });
});
