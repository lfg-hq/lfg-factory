import { expect, test } from 'bun:test';
import { composeDesignPreview } from '../src/services/design-preview.ts';
import { getSkill, skillCatalogue } from '../src/ai/skills/index.ts';
const html = '<!doctype html><html><head><title>Screen</title></head><body><button>Save</button></body></html>';
test('packages assets and escapes synthetic data', () => {
  const result = composeDesignPreview({html, css:'button{color:red}',js:'document.title=window.mockData.title',data:{title:'</script><img src=x>'}});
  expect(result).toContain('<style>button{color:red}</style>');
  expect(result).toContain('\\u003c/script>');
  expect(result.indexOf('window.mockData =')).toBeLessThan(result.indexOf('document.title='));
  expect(composeDesignPreview({html})).toBe(html);
});
test('rejects incomplete, oversized and malformed assets', () => {
  expect(()=>composeDesignPreview({html:'<div>Hi</div>'})).toThrow();
  expect(()=>composeDesignPreview({html,css:'</style><script>bad</script>'})).toThrow();
  expect(()=>composeDesignPreview({html,js:'</script><script>bad</script>'})).toThrow();
  expect(()=>composeDesignPreview({html,css:' '.repeat(400001)})).toThrow();
});
test('skill is discoverable without inlining workflow',()=>{
 const skill=getSkill('design-feature')!;
 expect(skill).toBeDefined();expect(skillCatalogue()).toContain(skill.description);expect(skillCatalogue()).not.toContain(skill.body);
});
