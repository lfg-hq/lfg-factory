import { describe, expect, test } from 'bun:test';
import { providerErrorMessage } from '../src/ai/provider-error.ts';
import { streamText } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';

describe('provider failures', () => {
  test('explains billing failures without exposing request data', () => {
    const text = providerErrorMessage({statusCode:402,message:'Insufficient Balance',requestBodyValues:{secret:'private'}},'deepseek');
    expect(text).toContain('DeepSeek has insufficient API credit');
    expect(text).toContain('choose another model');
    expect(text).not.toContain('private');
  });
  test('recognizes nested billing errors and sanitizes unknown failures', () => {
    expect(providerErrorMessage({cause:{statusCode:402}},'deepseek')).toContain('insufficient API credit');
    expect(providerErrorMessage(new Error('secret-token'),null)).not.toContain('secret-token');
    expect(providerErrorMessage({statusCode:401},'deepseek')).toContain('credentials');
    expect(providerErrorMessage({statusCode:429},'deepseek')).toContain('limiting requests');
  });
  test('captures original stream error before SDK response rejects with no output', async () => {
    const error = Object.assign(new Error('Insufficient Balance'), {statusCode:402});
    const model = new MockLanguageModelV3({doStream:async()=>{throw error;}});
    const result = streamText({model,prompt:'Hello',onError:()=>{}});
    let message='';
    try { for await (const event of result.fullStream) { if(event.type==='error') throw event.error; } }
    catch (error) { message=providerErrorMessage(error,'deepseek'); }
    expect(message).toContain('DeepSeek has insufficient API credit');
    await expect(result.response).rejects.toThrow('No output generated');
  });
});

test('diagnostic reasons keep error codes and drop message text', async () => {
  const { safeErrorReason } = await import('../src/ai/provider-error.ts');
  const error = Object.assign(new Error('Service unavailable: server_is_overloaded for https://api.example.test?key=sk-secret123456'), { name: 'AI_APICallError', statusCode: 503 });
  const reason = safeErrorReason(error);
  expect(reason).toBe('AI_APICallError 503 server_is_overloaded');
  expect(reason).not.toContain('sk-');
});
