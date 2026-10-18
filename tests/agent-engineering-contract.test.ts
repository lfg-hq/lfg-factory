import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildBuilderPrompt, buildTicketChatPrompt } from '../src/ai/prompts/builder.ts';
import { buildApiBuilderPrompt } from '../src/ai/prompts/builder-api.ts';
import { getProductSystemPrompt } from '../src/ai/prompts/product.ts';
import {getSkill,skillCatalogue} from '../src/ai/skills/index.ts';
import {buildLoadSkillTool} from '../src/ai/tools/skill-tools.ts';
const ctx = {ticket:{id:'t',name:'Feature',description:'Implement AI analysis'}, project:{id:'p',name:'App'}, callbackBaseUrl:'https://example.test',cliApiKey:'test'};
test('delivery skills, API, CLI and follow-up prompts retain the engineering contract', () => {
  for (const prompt of [getSkill('ticket-delivery')!.body, buildBuilderPrompt(ctx), buildApiBuilderPrompt(ctx), buildTicketChatPrompt(ctx,'Fix this')]) {
    expect(prompt).toContain('Observability is required');
    expect(prompt).toContain('platform seeds settings only into .env');
    expect(prompt).toContain('keyword rules, mock responses or silent fallbacks cannot satisfy it');
    expect(prompt).toContain('Admin accounts are not a universal project requirement');
    expect(prompt).toContain('same resolved environment and database identity');
    expect(prompt).toContain('platform owns commits, pushes and merges');
  }
  const executor=readFileSync(new URL('../src/workers/ticket-executor.ts',import.meta.url),'utf8');
  expect(executor.match(/\$\{ENGINEERING_CONTRACT\}/g)?.length).toBe(2); // Pi build + Pi follow-up
});

test('runtime repairs share the contract and login checks forbid bypass evidence', () => {
  const runtime=readFileSync(new URL('../src/services/ticket-runtime.ts',import.meta.url),'utf8');
  expect(runtime).toContain('TICKET_RUNTIME_INSTRUCTION = `${ENGINEERING_CONTRACT}');
  const feature=readFileSync(new URL('../src/services/feature-test-plan.ts',import.meta.url),'utf8');
  expect(feature).toContain('Never use test-only cookie injection');
  expect(feature).toContain('verified real login');
});


test('coordinator routes to skills without carrying their operational procedures',()=>{
 const prompt=getProductSystemPrompt();
 expect(prompt).toContain('lead researcher and project manager');
 expect(prompt).toContain('## Feature lifecycle');
 expect(prompt).toContain('never grant authorization');
 for(const phrase of ['DEVELOPMENT PREVIEW ACCESS:', 'Observability is required', 'databaseTransaction', 'create-if-absent']) {
  expect(prompt).not.toContain(phrase);
  expect(skillCatalogue()).not.toContain(phrase);
 }
 expect(getSkill('preview-operations')!.body).toContain('databaseTransaction');
 expect(getSkill('environment-configuration')!.body).toContain('registerRequiredEnvVars');
 expect(getSkill('ticket-delivery')!.body).toContain('startBuildRun');
 for(const removed of ['epic-delivery','product-planning','technical-research','document-authoring']) expect(getSkill(removed)).toBeUndefined();
 expect(prompt.length).toBeLessThan(9000);
});

test('lifecycle covers every step from request to preview summary',()=>{
 const prompt=getProductSystemPrompt();
 for(const step of ['Understand the request','Brainstorm and research','Requirements doc','Technical analysis','Technical analysis doc','Tickets','Build','Preview and summary']) expect(prompt).toContain(`**${step}.**`);
 expect(prompt).toContain('startEpic');
 expect(prompt).toContain('mermaid');
 expect(prompt).toContain('startBuildRun');
 expect(prompt).toContain('automated build event');
});

test('on-demand loader returns the complete canonical procedure',async()=>{
 const tool=buildLoadSkillTool();
 for(const id of ['preview-operations','environment-configuration','ticket-delivery','diagram-mapping']) {
  const result=await (tool.execute as any)({id},{toolCallId:'test',messages:[]});
  expect(result.found).toBe(true);
  expect(result.instructions).toBe(getSkill(id)!.body);
 }
});
