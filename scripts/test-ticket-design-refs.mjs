// Behavioral coverage of saved specifications and explicit design references.
import {spawnSync} from 'node:child_process';
const result=spawnSync('bun',['test','tests/ticket-context-documents.test.ts'],{stdio:'inherit'});
process.exit(result.status??1);
