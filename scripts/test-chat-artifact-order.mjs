import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import assert from 'node:assert/strict';
const source=readFileSync('public/js/chat.js','utf8');
const functions=source.slice(source.indexOf('    function renderSavedInlineArtifacts('),source.indexOf('    /** The turn is over:'));
const output=[];
const context={
 assistantTimelineParts:message=>message.parts,
 renderChatArtifact:artifact=>output.push(artifact.id),
 addMessageToChat:(_,text)=>{output.push(text);return {};},
 renderSavedTrail:()=>output.push('activity'),markMessageEndReason:()=>{}
};
runInNewContext(functions,context);
const documents=[{id:'document',kind:'document'},{id:'tickets',kind:'tickets'},{id:'old-preview'}];
context.renderAssistantTimeline({parts:[{kind:'message',text:'I’ll write it.'},{kind:'trail',steps:[]},{kind:'message',text:'Saved requirements.'}],page_previews:documents});
assert.deepEqual(output,['I’ll write it.','activity','document','tickets','Saved requirements.']);
output.length=0;
context.renderAssistantTimeline({parts:[{kind:'trail',steps:[]}],pagePreviews:documents});
assert.deepEqual(output,['activity','document','tickets']);
output.length=0;
context.renderSavedInlineArtifacts({page_previews:documents});context.addMessageToChat('assistant','Saved requirements.');
assert.deepEqual(output,['document','tickets','Saved requirements.']);
output.length=0;
context.renderAssistantTimeline({parts:[{kind:'trail',steps:[]},{kind:'message',text:'All four tickets are queued.'}],page_previews:[{id:'build',kind:'build_run'},{id:'tickets',kind:'tickets'}]});
assert.deepEqual(output,['activity','tickets','All four tickets are queued.','build']);
assert.match(source,/renderSavedInlineArtifacts\(message, true\)/);
assert.match(source,/if \(!renderedTimeline && message.role === 'assistant'\) renderSavedInlineArtifacts\(message\)/);
assert.match(source,/if \(msg.role === 'assistant'\) renderSavedInlineArtifacts\(msg\)/);
console.log('PASS: documents and tickets precede the final summary on replay; introductory text, activity, artifact-only turns and legacy previews are preserved; the build card follows its reply.');
