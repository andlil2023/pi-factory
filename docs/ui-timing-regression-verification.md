# UI collection timing regression verification

On Windows (win32), Node v24.12.0, the following Git Bash experiment was run from the repository root with dependencies installed. The temporary copy is inside the repository so Node can resolve its dependencies from the parent; it is removed on exit. Only the copied predicate is changed. The test uses the real collector and validation, but controls the parent clock samples to model the first recorded 4 ms post-end observation in `windows-ui-timing-investigation.md`. It is not a real-time reproduction or proof of a physical cause or universal bound.

```bash
set -eu
root=$PWD
p=$(mktemp -d ./timing-check-XXXXXX)
trap 'cd "$root"; rm -rf "$p"' EXIT
mkdir -p "$p/src" "$p/contracts" "$p/tests/fixtures"
cp src/*.ts "$p/src/"
cp contracts/*.json "$p/contracts/"
cp tests/ui-evidence-timing-regression.test.ts "$p/tests/"
cp tests/fixtures/fake-ui-collector.mjs "$p/tests/fixtures/"
cd "$p"
node --experimental-strip-types --test tests/ui-evidence-timing-regression.test.ts
node -e "const fs=require('fs');const p='src/ui-evidence.ts';const s=fs.readFileSync(p,'utf8');const a='Number.isFinite(captured) && captured >= started - 50 && captured <= ended + 50';const b='Number.isFinite(captured) && captured >= started && captured <= ended';if(s.split(a).length!==2)throw Error('predicate mismatch');fs.writeFileSync(p,s.replace(a,b));"
set +e
node --experimental-strip-types --test tests/ui-evidence-timing-regression.test.ts
status=$?
set -e
echo "strict exit: $status"
test "$status" -eq 1
node -e "const fs=require('fs');const p='src/ui-evidence.ts';const s=fs.readFileSync(p,'utf8');const a='Number.isFinite(captured) && captured >= started && captured <= ended';const b='Number.isFinite(captured) && captured >= started - 50 && captured <= ended + 50';if(s.split(a).length!==2)throw Error('predicate mismatch');fs.writeFileSync(p,s.replace(a,b));"
node --experimental-strip-types --test tests/ui-evidence-timing-regression.test.ts
```

Captured results: the initial approved policy passed 1/1 (exit 0); strict boundaries failed 1/1 (exit 1) at `tests/ui-evidence-timing-regression.test.ts:45:10` with `AssertionError [ERR_ASSERTION]: UI evidence capture timestamp is stale or invalid` and `false !== true`; the restored approved policy passed 1/1 (exit 0). The mutation is exactly from `Number.isFinite(captured) && captured >= started - 50 && captured <= ended + 50` to `Number.isFinite(captured) && captured >= started && captured <= ended`, and back.

Also on Windows Node v24.12.0, `node --experimental-strip-types --test tests/ui-evidence-timing-regression.test.ts tests/ui-evidence.test.ts` passed 25/25, including both inclusive boundaries and the safeguard rejection cases. `node node_modules/typescript/bin/tsc --noEmit` passed.
