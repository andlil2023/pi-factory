// Simulates PI's newline-delimited JSON output. Never calls an LLM.
import { args, prompt, instructions } from './pi-input.mjs';
if (prompt === 'fail') {
  console.error('fake failure');
  process.exit(7);
}
if (prompt === 'invalid') {
  console.log('not-json');
  process.exit(0);
}
if (prompt === 'empty') process.exit(0);
if (prompt === 'sleep') {
  setTimeout(() => console.log(JSON.stringify({ type: 'done' })), 2000);
} else {
  console.log(JSON.stringify({ type: 'done', args, prompt, instructions, cwd: process.cwd() }));
}
