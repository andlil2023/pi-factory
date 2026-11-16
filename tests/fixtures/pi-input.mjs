// Model-free fixtures emulate PI's documented piped-input and instruction-path CLI.
import { readFile } from 'node:fs/promises';
export const args = process.argv.slice(2);
process.stdin.setEncoding('utf8');
let text = '';
for await (const chunk of process.stdin) text += chunk;
export const prompt = text;
const index = args.indexOf('--append-system-prompt');
export const instructions = index < 0 ? '' : await readFile(args[index + 1], 'utf8');
