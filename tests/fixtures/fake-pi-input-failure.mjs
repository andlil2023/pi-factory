// Model-free process failure fixture: intentionally never consumes stdin.
if (process.argv[2] === 'exit') {
  console.error('early fixture failure');
  process.exit(7);
}
setInterval(() => {}, 1000);
