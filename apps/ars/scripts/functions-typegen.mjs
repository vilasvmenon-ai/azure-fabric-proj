// Regenerates packages/functions/src/types.ts (AppFunctionsSchema) offline.
//
// `rayfin dev` normally runs this generator, but it needs a live Fabric
// backend. This script calls the SAME generator shipped in the installed,
// version-pinned @microsoft/rayfin-cli (dist/utils/functions-types-generator.js),
// so the output is identical and still never hand-edited. It is not a public
// CLI entry point: re-check the path when upgrading the CLI.
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const cliRoot = dirname(require.resolve('@microsoft/rayfin-cli/package.json'));
const generatorPath = join(cliRoot, 'dist', 'utils', 'functions-types-generator.js');
const { generateFunctionsTypes } = await import(pathToFileURL(generatorPath).href);

const functionsDir = resolve(import.meta.dirname, '..', 'packages', 'functions');
await generateFunctionsTypes(functionsDir);
console.log(`[typegen] regenerated ${join(functionsDir, 'src', 'types.ts')}`);
