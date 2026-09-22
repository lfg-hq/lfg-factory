import {test,expect} from 'bun:test';
import {PREVIEW_SOURCE_POLICY,previewPublicationBlocked} from '../src/services/preview-source-policy.ts';
import {readFileSync} from 'node:fs';
test('preview permits source repairs on default and remembers replay without committing',()=>{
 expect(PREVIEW_SOURCE_POLICY).toContain('BOTH the default');expect(PREVIEW_SOURCE_POLICY).toContain('persistConfigPatch');expect(PREVIEW_SOURCE_POLICY).toContain('never commit');
});
test('blocks direct publication including directory and configuration options',()=>{
 for(const cmd of ['git commit -am fix','git -C /data/project push','git -c user.name=Agent commit -m fix','dotnet build && git push','git update-ref refs/heads/main HEAD'])expect(previewPublicationBlocked(cmd)).toBe(true);
 for(const cmd of ['dotnet build','git diff HEAD','git status --short','git log -1','git rev-parse HEAD'])expect(previewPublicationBlocked(cmd)).toBe(false);
});
test('both preview agents share policy and no longer tell ticket preview to commit',()=>{
 const source=readFileSync(new URL('../src/services/dev-preview.ts',import.meta.url),'utf8');
 expect(source).not.toContain('Source repairs require an isolated feature-branch checkout');
 expect(source).not.toContain('then COMMIT so the change persists');
 expect(source.match(/if \(previewPublicationBlocked\(command\)\)/g)?.length).toBe(2);
});
