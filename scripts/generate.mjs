import { readFileSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFromRoot, updateAccountsVisitor } from 'codama';
import { rootNodeFromAnchor } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';

const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(`${root}client/idl`, { recursive: true });
copyFileSync(`${root}target/idl/once.json`, `${root}client/idl/once.json`);
const idl = JSON.parse(readFileSync(`${root}client/idl/once.json`, 'utf8'));
const codama = createFromRoot(rootNodeFromAnchor(idl));
codama.update(updateAccountsVisitor({ call: { name: 'callAccount' } }));
await codama.accept(renderVisitor(`${root}client`, {
  syncPackageJson: false, kitImportStrategy: 'rootOnly', importExtension: 'js',
  internalNodes: [], formatCode: true,
}));
const errors = `${root}client/src/generated/errors/once.ts`;
writeFileSync(errors, readFileSync(errors, 'utf8').replaceAll('ONCE_ERROR__' + 'ONCE_', 'ONCE_ERROR__Once_'));
console.log(JSON.stringify({ program: idl.address, instructions: idl.instructions.map(i => i.name) }));
