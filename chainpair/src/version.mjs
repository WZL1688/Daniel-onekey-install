import { readFileSync } from 'node:fs';

// Resolve against this module so launching from another directory cannot
// report the version of an unrelated package.json.
export const APP_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
