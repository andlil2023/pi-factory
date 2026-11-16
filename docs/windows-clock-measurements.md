# Windows clock exchange measurements

## Reproduction

On Windows with Node v24.12.0, from the repository root (PowerShell):

```powershell
node --version
node -p "JSON.stringify({platform:process.platform,arch:process.arch,release:require('node:os').release(),uv:process.versions.uv})"
powershell -NoProfile -Command '[System.Diagnostics.Stopwatch]::Frequency'
$scratch = Join-Path $env:TEMP ([guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $scratch | Out-Null
$utf8 = [System.Text.UTF8Encoding]::new($false)
foreach ($mode in @('ipc', 'worker')) {
  $json = node tests/fixtures/clock-exchanges.cjs $mode
  if ($LASTEXITCODE -ne 0) { throw "Probe failed: $mode" }
  [System.IO.File]::WriteAllText((Join-Path $scratch "$mode.json"), ($json -join "`n"), $utf8)
}
node tests/fixtures/clock-summarize.cjs (Join-Path $scratch 'ipc.json') (Join-Path $scratch 'worker.json')
```

The explicit BOM-free UTF-8 capture works in Windows PowerShell 5.1; native-command `>` there writes UTF-16LE and must not be used for these JSON files. The fresh scratch directory is private working data; remove it when no longer needed. Each run records 1,000 sequential request/response exchanges. `ipc` uses a persistent child process; `worker` uses a worker thread in the same process. Start fresh processes for independent runs. Output contains wall timestamps and monotonic readings: keep raw files private, outside version control, and review any exported output for identifiers and secrets. Summaries below contain no raw timestamps or host identifiers. The summarizer prints its input path; remove paths before sharing. No machine name, user name, environment variables or filesystem paths are captured in probe JSON. Operating system release and runtime versions are recorded; capture PowerShell/.NET version and Stopwatch frequency separately for native comparisons. Environment details may themselves be identifying.

The supplied native experiment requires its original `clock-native-probe.cjs` and `clock-native-child.ps1` in `.factory` relative to the working directory. Run the supplied probe from that directory's repository root, capture its output with the same BOM-free UTF-8 method above (checking `$LASTEXITCODE`), and summarize the private file with `clock-summarize.cjs`. It invokes Windows PowerShell, sends 1,000 lines to one process and compares Node Date.now with GetSystemTimePreciseAsFileTime. The supplied script multiplies Stopwatch ticks by 100: this assumes a frequency of 10,000,000 ticks/second. Check the frequency on the measurement host; do not use its results as nanoseconds if that assumption fails. None of the supplied files were modified.

The measurements below were recomputed from the supplied raw JSON with the summarizer. The supplied IPC and worker files report Windows and Node v24.12.0; native files report Node v24.12.0 but do not record platform or Stopwatch frequency. An independent operator reproduction on Windows x64 with Node v24.12.0, libuv 1.51.0 and Stopwatch frequency 10,000,000 Hz produced the following sanitized summaries (ms):

| Probe | Count | Minimum ms | Maximum ms |
|---|---:|---:|---:|
| IPC | 1000 | -0.2469 | 0.99015 |
| worker | 1000 | -0.11945 | 0.9953 |
| native | 1000 | -0.14075 | 1.26635 |

The reproduction frequency does not prove the historical frequency. The operator independently executed the exact PowerShell block above with Windows PowerShell 5.1 on Windows x64, Node v24.12.0, libuv 1.51.0 and Stopwatch frequency 10,000,000 Hz. Both files parsed successfully and the command exited 0. Sanitized summaries (ms):

| Probe | Count | Minimum ms | Maximum ms |
|---|---:|---:|---:|
| IPC | 1000 | -3.2881 | -2.00955 |
| worker | 1000 | -0.07625 | 0.99595 |

## Method and observed results

For each exchange, a wall read is bracketed by monotonic reads `a` and `b` in the parent before sending and in the peer on receipt. The reported estimate is peer wall minus parent wall minus the difference between monotonic bracket midpoints, converted to milliseconds. Positive means the peer's wall clock was ahead after this elapsed-time correction. The supplied native child reports integer milliseconds from the precise Windows wall clock instead of Date.now. Numbers below are extrema of per-exchange estimates, rounded to four decimal places, not confidence intervals.

| Recording | Count | Minimum ms | Maximum ms |
|---|---:|---:|---:|
| IPC unnumbered | 1000 | -1.0418 | 0.3854 |
| IPC 1 | 1000 | -1.1651 | 0.0210 |
| IPC 2 | 1000 | 8.9211 | 9.9925 |
| IPC 3 | 1000 | -4.2838 | -3.0098 |
| IPC 4 | 1000 | -14.1671 | -13.0092 |
| IPC 5 | 1000 | -5.3852 | -4.0083 |
| worker 1 | 1000 | -0.0474 | 0.9961 |
| worker 2 | 1000 | -0.0770 | 0.9961 |
| worker 3 | 1000 | -0.6592 | 0.9961 |
| worker 4 | 1000 | -0.1582 | 0.9943 |
| worker 5 | 1000 | -0.1026 | 0.9964 |
| native 1 | 1000 | -0.3267 | 0.9974 |
| native 2 | 1000 | -0.1255 | 1.1952 |
| native 3 | 1000 | -0.1085 | 1.4133 |

A separate supplied one-shot process probe recorded 100 already-derived midpoint offsets, range -10.3886 to 1.3874 ms; 23 had absolute magnitude over 1 ms. These counts and extrema were recomputed from its recorded derived values, but the original monotonic bracket readings were not saved, so the individual derived offsets cannot be independently reconstructed. It is not part of the 1,000-exchange comparison.

These estimates assume Node hrtime readings share a comparable monotonic epoch and rate across the compared processes and threads. The native comparison additionally assumes Stopwatch and Node hrtime share a compatible epoch and rate, and the conversion above is correct. These are assumptions, not proven by the probes. Bracket midpoint choice introduces uncertainty up to half the combined bracket widths if the wall read occurred anywhere inside each bracket; integer millisecond wall readings add quantization uncertainty. Scheduling delays, initial startup, wall-clock adjustment, clock drift and sampling only a short correlated sequence add uncertainty. The after sample is recorded but not used for the table. A midpoint is an estimate, not a rigorous bound on a persistent clock offset.

The observations show varying corrected cross-process offsets in these recordings, and smaller observed worker and native ranges under the stated assumptions. They do not establish why individual offsets occurred, external clock accuracy, a universal bound, or behavior on other hosts or versions. Repeated samples within one run are not independent trials.

## Pinned implementation and interpretation

The following is the normal Windows path in the source bundled with **Node v24.12.0**, not a claim about all Node or Windows versions. An independent supervisor inspected the linked files and control flow retrieved from the v24.12.0 tag over HTTPS; this source verification does not independently establish the provenance of the measured Node executable:

1. V8 installs [`Date.now` as `Builtin::kDateNow`](https://github.com/nodejs/node/blob/v24.12.0/deps/v8/src/init/bootstrapper.cc#L3100-L3105); [`BUILTIN(DateNow)`](https://github.com/nodejs/node/blob/v24.12.0/deps/v8/src/builtins/builtins-date.cc#L146-L150) calls [`JSDate::CurrentTimeValue`](https://github.com/nodejs/node/blob/v24.12.0/deps/v8/src/objects/js-objects.cc#L5692-L5701). The latter has a correctness-fuzzer suppression returning a constant; normally it calls the platform's `CurrentClockTimeMilliseconds`.
2. The [V8 platform default](https://github.com/nodejs/node/blob/v24.12.0/deps/v8/include/v8-platform.h#L1293-L1308) floors `CurrentClockTimeMillis` to integer milliseconds. [Node's override](https://github.com/nodejs/node/blob/v24.12.0/src/node_platform.cc#L753-L755) calls `SystemClockTimeMillis`, which [calls `base::OS::TimeCurrentMillis`](https://github.com/nodejs/node/blob/v24.12.0/deps/v8/src/init/v8.cc#L304-L306). On Windows [that calls `Time::Now().ToJsTime()`](https://github.com/nodejs/node/blob/v24.12.0/deps/v8/src/base/platform/platform-win32.cc#L503-L505).
3. The Windows [`Clock` and `Time::Now`](https://github.com/nodejs/node/blob/v24.12.0/deps/v8/src/base/platform/time.cc#L311-L369) use a lazy, mutex-protected clock. Its constructor samples `TimeTicks::Now()` and then `GetSystemTimeAsFileTime` for the initial tick and wall time. Each `Now` samples ticks and wall time again; normally it returns the initial wall time plus elapsed ticks. It resets both baselines and returns the sampled wall time if the sampled wall time is earlier than the initial wall time, or if tick elapsed time is **greater than** one minute. `NowFromSystemTime` explicitly resets both baselines too. A forward wall-clock change alone is not a separate immediate reset condition.
4. [`TimeTicks::Now` selects its Windows source](https://github.com/nodejs/node/blob/v24.12.0/deps/v8/src/base/platform/time.cc#L635-L725): QPC when `QueryPerformanceFrequency` is positive and the CPU reports a non-stop timestamp counter, otherwise rollover-protected `timeGetTime`. [`QPCNowRaw`](https://github.com/nodejs/node/blob/v24.12.0/deps/v8/src/base/platform/time.cc#L168-L177) calls `QueryPerformanceCounter`; the [fallback](https://github.com/nodejs/node/blob/v24.12.0/deps/v8/src/base/platform/time.cc#L530-L595) extends the 32-bit tick count, subject to its documented call-frequency assumption. The separate `Win32Time::SetToCurrentTime` implementation in `platform-win32.cc` is not the `Time::Now` path described above.

**Mechanism, not attribution:** the wall read has comparatively coarse resolution and is sampled separately from the tick read. Independent process-local baselines can therefore pair different wall values and tick instants, producing different extrapolated wall readings even when elapsed ticks advance comparably. Threads using the same loaded V8 clock share its baseline; the observed worker ranges are consistent with that distinction, but do not prove it caused any sample. The source does not establish which tick branch ran on the measurement host, the phase of any baseline, or whether scheduling, quantization, adjustments or other effects caused a particular estimate. The native probe uses the precise Windows wall clock, not the same Date.now implementation; its historical frequency and shared-epoch assumptions remain unverified as described above.

The existing UI evidence policy accepts timestamps inclusively from `started - 50 ms` through `ended + 50 ms`. This is an approved operator tradeoff: it accommodates some timing discrepancies while potentially admitting stale timestamps. Neither the source nor these measurements establish 50 ms as a universal bound. This diagnostic does not change the tolerance or other validation safeguards.
