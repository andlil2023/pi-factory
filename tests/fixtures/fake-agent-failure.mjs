process.stdin.resume();
process.stdin.on('end', () => {
  console.log('SECRET_STDOUT');
  console.error('SECRET_STDERR');
  process.exitCode = 7;
});
