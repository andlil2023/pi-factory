// Compute child minus parent's before-sample wall/monotonic offset in milliseconds.
const fs = require('node:fs');
for (const file of process.argv.slice(2)) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data.rows) || !data.rows.length) throw Error('Expected raw rows');
  const offsets = data.rows.map(row => {
    const { before: p, child: c, after } = row;
    for (const s of [p, c, after]) {
      if (!Number.isSafeInteger(s.w) || BigInt(s.a) > BigInt(s.b)) throw Error('Invalid sample');
    }
    const midpointDifference = (BigInt(c.a) + BigInt(c.b)) - (BigInt(p.a) + BigInt(p.b));
    return c.w - p.w - Number(midpointDifference) / 2e6;
  });
  console.log(JSON.stringify({ file, count: offsets.length, minMs: Math.min(...offsets), maxMs: Math.max(...offsets) }));
}
