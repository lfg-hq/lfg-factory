import {getProductSystemPrompt,SKILLS_PLACEHOLDER,DOC_TEMPLATES_PLACEHOLDER} from '../src/ai/prompts/product.ts';
import {skillCatalogue} from '../src/ai/skills/index.ts';
import {templateCatalogueFor} from '../src/ai/doc-templates/index.ts';
import {READING_INSTRUCTIONS} from '../src/ai/reading-policy.ts';

const prompt=getProductSystemPrompt()
  .replace(SKILLS_PLACEHOLDER,skillCatalogue())
  .replace(DOC_TEMPLATES_PLACEHOLDER,await templateCatalogueFor());
await Bun.write(new URL('../docs/main-agent-prompt.txt',import.meta.url),
  'MAIN CHAT AGENT — LOCAL PROMPT EXPORT\n\n'+
  'This heading and paragraph are export notes, not model instructions. The base prompt below includes built-in catalogues and reading guidance. Runtime supplies project identity, flags, project skills and custom instructions. Detailed operational workflows load through skills; they are not included on every turn. This is not a production request capture.\n\n'+
  prompt+READING_INSTRUCTIONS);
console.log(`Exported base prompt: ${prompt.length} characters (including catalogues).`);
