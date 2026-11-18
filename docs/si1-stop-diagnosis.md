<!-- Copyright (C) 2026 Circuit Center Inc -->
<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# SI1: Stop on a fine step, diagnosed

Ledger row SI1: "Stop does not end a 1 ns step, 2 s transient (frozen at 6 percent)". Diagnosed on engine run 14 (island cc24, the same simulator as cc23) on the local pair, Playwright's headless Chromium, fixture `sim-rc` (V1 pulse, R1 1 kOhm, C1 1 uF), with a probe that read, every 100 to 300 ms while the run went: the last `ev.sim` percent, the renderer process's resident memory, and how long the service's worker took to answer a `running` read sent straight to `globalThis.ngspiceService` from the island frame.

## The three places the halt could be lost

1. The island: `sim.stop` is answered off the request queue and calls `kicadSimStop` at once. Measured: answered `{}` in 6 ms every time. Not lost here.
2. The engine: `kicadSimStop` marks the run stopped and queues its body on the apply coroutine, which calls KiCad's `NGSPICE::Stop` (`bg_halt`), a request to the service. Measured: the engine stayed busy (`kicadCollabBusy` true) after the Stop, because its coroutine was waiting on a request to the service that never came back. The queue itself is not the cause.
3. The service's worker: ngspice runs on its own pthread, so the worker's main thread is free to read the halt. Measured: before any Stop the worker had stopped answering.

## What was measured

| transient | memory of the renderer, before, then within about 2 s | the worker's `running` read | Stop |
|---|---|---|---|
| 1 ns over 20 ms | 883 MiB, then 1,802 MiB, flat after | answered in 0 to 1 ms throughout | ended `stopped` 344 ms after the press |
| 1 ns over 200 ms | 883 MiB, then 3,937 MiB at 6 percent | no answer within 1.5 s, from 2.6 s in | no end 60 s after the press |
| 1 ns over 2 s | 885 MiB, then 3,858 MiB at 6 percent | no answer within 1.5 s, from 2.6 s in | no end 60 s after the press, none in 600 s in a first probe |

The memory grows within the first two seconds, long before ngspice has covered any real share of the span, and with the span over the step (2 x 10^7 rows took about 0.9 GiB). A second probe, the engine's own event handler wrapped to log what the service sent it (1 ns over 2 s), showed the other way it ends, the worker answering throughout:

```
stderr Error: malloc: can't allocate 3115098912 bytes.
stderr Not enough memory or heap corruption
stderr Error: ngspice.dll cannot recover and awaits to be reset or detached
{"kind":"bg","finished":true}
{"kind":"exit","status":1,"immediate":false,"quit":false}
```

1.3 s after the run began. From then on the worker answered `running: false` in 0 to 1 ms, the engine was idle (`kicadCollabBusy` false), and no record was written: the run stayed live. A Stop 4 s in reached ngspice ("Background thread stopped with timeout = 0", so `bg_halt` succeeded on a thread that had already ended) and the engine went on waiting for the end of that thread, which had come before.

So there are two ways the halt is lost, both from one cause, ngspice's storage passing the memory the service's worker can hold:

- the worker no longer reads its messages (the first probes): the halt never reaches ngspice and the engine's apply coroutine waits on it;
- ngspice's thread ends on its own with an allocation failure and the engine writes no record (the second probe): the halt finds nothing to stop and the engine waits for an end that came already.

## Where it lives, and the fix

- **The cause is in the service and the engine, not the island**: ngspice's storage for a run is allowed past the memory the worker can hold (the service, `wasm/ngspice-service/ngspice_service_main.cpp` in pcbjam, unit lo-e2-svc-e: a run whose storage cannot be had should end failed with ngspice's message, and the worker should keep answering), and the engine does not finish a run whose ngspice thread ended with a controlled exit (`kicadSimRun`'s state handler, unit lo-e2-e: the `exit` event after `bg finished` should end the run `sim_failed` with ngspice's first error line, and kicadSimStop should finish at once a run whose thread has ended).
- **The island holds the part that makes Stop work whatever the service or the engine does**, fixed here (`src/sim-service.ts` `endIfWedged`, wired by `bridge/ext/lo-e2-i.ts` on `sim.stop`): after a Stop, while the run is still live, the island reads the worker every 300 ms. While ngspice runs, the worker is left to end the run. A worker that does not answer within 250 ms, or whose ngspice runs nothing while the engine is idle on two looks in a row, is ended (the provider's `release`, which settles what the engine waits on), and the engine is asked to stop again: its queued Stop finds no run in the fresh service and finishes the run itself, recorded `stopped` (kicadSimStop's own path for a service with no run). The next run boots a fresh worker.

## Measured with the fix

`tests/e2e/lo/sim-faults.spec.ts` on engine run 14, the local pair, Playwright's headless Chromium (2026-11-18):

- 1 ns over 2 s, Stop pressed at 6 percent: the run ended 555 ms after the press (573 ms in an earlier run), exactly one end, and the next run (1 us over 5 ms) was `done` 204 ms after its request, on a fresh worker. Without the watch the same run had no end 60 s after the press.
- The run's end reads `done`: the engine's record, not the island's word. The engine had queued the run's finish when ngspice's thread ended on its allocation failure, before the Stop, so kicadSimStop found the finish queued and did not mark the run stopped. A run whose ngspice ended with a controlled exit should end `failed` (lo-e2-e); the e2e's run 15 case asks for `stopped` or `failed`, never `done`.
- Unchanged: Stop 200 ms into a 20 s transient of 1 us steps ended it `stopped` 178 ms after the press (`tests/e2e/sim.spec.ts`), a worker that dies still ends its run `service_failed`, and `sim.release` still works.
