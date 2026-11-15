// Simulates PI's newline-delimited JSON output. Never calls an LLM.
const args = process.argv.slice(2);
const prompt = args.at(-1);
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
  console.log(JSON.stringify({ type: 'done', args, cwd: process.cwd() }));
}
