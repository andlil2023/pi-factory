# Windows UI collection timing investigation

## Environment and procedure

Measurements were made on Windows 11 Home x64, Windows release 10.0.26300, Node v24.12.0 (libuv 1.51.0), Git 2.56.0.windows.4, with project dependencies installed. The machine's wall clock reported 2026-11-16 UTC; its external accuracy was not checked. The shell was Git Bash; commands below also work from PowerShell except where noted. No desktop application was launched.

From the repository root, with Node 24, Git and `npm install` dependencies available:

```powershell
node --version
node --experimental-strip-types tests/fixtures/ui-timing-investigation.mjs > timing.jsonl
```

Repeat this command in fresh Node processes. Each run creates a temporary Git repository and external evidence directory and performs 100 sequential calls to `collectUiEvidence` using the unmodified `tests/fixtures/fake-ui-collector.mjs` and the real contract validator. It cleans up its temporary directory. The harness copies `src/ui-evidence.ts` to a temporary file, changes its validator import to an absolute URL, and records the already sampled `started` and `ended` values immediately after `ended` is sampled. No timestamp validation or other collection safeguard is disabled. The harness prints each boundary in Unix milliseconds, the manifest's ISO timestamp, collection result, and the derived offsets (`captured - started` and `captured - ended`, in milliseconds). Run from the repository root because paths are resolved there. Instrumentation and workload can affect timing; an individual run is not guaranteed to show an out-of-bound timestamp.

Independently recompute both offsets in PowerShell (substitute a recorded file or `timing.jsonl`):

```powershell
$x = Get-Content timing.jsonl | ConvertFrom-Json
$bad = 0
foreach ($v in $x) {
  $t = [DateTimeOffset]::Parse($v.capturedAt).ToUnixTimeMilliseconds()
  if (($t - $v.started -ne $v.fromStart) -or ($t - $v.ended -ne $v.fromEnd)) { $bad++ }
}
"records=$($x.Count) mismatches=$bad"
```

## Results and interpretation

The recorded raw results are `windows-ui-timing-measurements-first.jsonl`, `windows-ui-timing-measurements.jsonl`, and `windows-ui-timing-measurements-third.jsonl` in this directory. The first run used the same harness before adding a check that the instrumentation marker exists; the remaining two used the checked-in harness. All 300 collections passed. Independent PowerShell recomputation returned zero mismatches for each file.

| Run | captured before start | captured after end | equal to end | captured − start range (ms) | captured − end range (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| first | 0 | 82 | 3 | 31 to 138 | -10 to +6 |
| second | 0 | 0 | 0 | 22 to 126 | -17 to -5 |
| third | 0 | 92 | 2 | 35 to 137 | -7 to +8 |

For example, in first run record 0, start is 1794862759213, end 1794862759254, and captured is 2026-11-16T20:59:19.258Z (1794862759258): offsets are +45 ms and +4 ms respectively. With strict boundaries that timestamp would be rejected; the current inclusive margin accepts it. The second run shows that this occurrence is not deterministic even on the same machine. It is reproducible as an observed pattern across the first and third process runs, not as a guaranteed outcome of every run.

The parent samples start before `execFile` and end after the collector command completes. The fixture writes its image and tree, then creates `capturedAt` from `new Date().toISOString()` before writing its manifest. Thus the fixture's capture operation logically precedes process completion, yet some reported wall-clock values compare later than the parent's end. Different process wall-clock readings or clock adjustments are possible explanations, but these measurements do not identify the cause, the clock implementation, or whether the processes' clocks were stable. We did not measure monotonic time or external clock accuracy. This is one host, one Node version and one fixture; the observed offsets do not establish a universal bound or explain behavior of actual desktop collectors. No claim is made that 50 ms bounds all such offsets.
