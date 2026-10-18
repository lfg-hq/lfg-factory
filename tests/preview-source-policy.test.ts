import {test,expect} from 'bun:test';
import {PREVIEW_SOURCE_POLICY,previewPublicationBlocked,assertPreviewRuntimePatches} from '../src/services/preview-source-policy.ts';
import {readFileSync} from 'node:fs';
test('preview source fixes go through tickets, while runtime configuration remains supported',()=>{
 expect(PREVIEW_SOURCE_POLICY).toContain('belong to ticket execution');
 expect(PREVIEW_SOURCE_POLICY).toContain('Never save account creation');
 for (const file of ['src/app/login/page.tsx','src/app/globals.css','scripts/preview-admin.mjs','scripts/verify-preview-browser.cjs','package.json','../appsettings.json']) {
  expect(()=>assertPreviewRuntimePatches([{file}])).toThrow('requires a ticket repair');
 }
 expect(()=>assertPreviewRuntimePatches([{file:'Web/appsettings.Development.json'},{file:'application-dev.yml'}])).not.toThrow();
});
test('blocks direct publication including directory and configuration options',()=>{
 for(const cmd of ['git commit -am fix','git -C /data/project push','git -c user.name=Agent commit -m fix','dotnet build && git push','git update-ref refs/heads/main HEAD'])expect(previewPublicationBlocked(cmd)).toBe(true);
 for(const cmd of ['dotnet build','git diff HEAD','git status --short','git log -1','git rev-parse HEAD'])expect(previewPublicationBlocked(cmd)).toBe(false);
});
test('preview recovery enforces publication policy and the legacy shell agent is removed',()=>{
 const source=readFileSync(new URL('../src/services/dev-preview.ts',import.meta.url),'utf8');
 expect(source).not.toContain('Source repairs require an isolated feature-branch checkout');
 expect(source).not.toContain('then COMMIT so the change persists');
 expect(source).not.toContain('export async function runPreviewChat');
 expect(source.match(/if \(previewPublicationBlocked\(command\)\)/g)?.length).toBe(1);
});
