# Emergency operator runbook

Use this only from the provisioned **manager box**. Never install or run `wyzr`
on the fleet box, even as an emergency workaround. Fill placeholders from your
own protected config; do not copy environment values from this repository.

## 1. Prove this is the manager box and check the gate

Failure condition before running: if `wyzr doctor --json` does not return
`READY` with exit 0, or its wrong-box guard is anything except `not_target`,
stop. Exit 27 is an affirmative preflight failure, 28 means a check was tried
but unreadable, and 29 means required operational coverage is unconfigured.

```sh
wyzr doctor --json
wyzr wedge status --json
```

For the gate, exit 0 is `WEDGED`; 11 is `NOT_PROVEN` and 12 is
`INCONCLUSIVE_BY_SHARED_CAUSE`. Either nonzero verdict means do not act without
the deliberate force procedure below. Read every probe and reason. `P5` and
`conn_state` are plug preconditions, not evidence that the box is wedged or
later recovered.

## 2. Preview the entire decision

Failure condition before running: if the dry run does not report `would_act`
(exit 20), nothing may be cut. Run:

```sh
wyzr cycle <FLEET-PLUG-FROM-CONFIG> --dry-run --json
```

Read `gate`, `wrongBoxGuard`, and `preconditions` independently. Exit 17 means
the gate refused; 18 means this machine is the target or could not be proved
different; 19 means cloud reachability or the plug's P3/P5 state was not
confident immediately before the proposed cut. Fix the cause and repeat the
doctor and preview. Force cannot override 18 or 19.

## 3. Act, or deliberately override only the verdict

Failure condition before acting: if the preview target is not the fleet plug
named by your protected `fleetPlug` config, if hand restoration is unavailable,
or if you cannot tolerate the configured interruption and restore bounds, stop.

Normal gated action:

```sh
wyzr cycle <FLEET-PLUG-FROM-CONFIG> --json
```

Force is legitimate only when a human has reviewed the complete evidence and
has independent reason to accept that the gate's verdict is too conservative.
It overrides only `NOT_PROVEN`/`INCONCLUSIVE_BY_SHARED_CAUSE`; it never overrides
configuration/login requirements, preconditions, or the wrong-box guard.

```sh
wyzr cycle <FLEET-PLUG-FROM-CONFIG> \
  --force-override-gate-verdict-i-accept-the-risk \
  --json
```

Failure condition: if the interactive target does not exactly match the
configured target host, do not confirm. For automation, the equivalent
`--force-non-interactive-confirm-target=<TARGET-HOST-FROM-CONFIG>` remains an
exact-match confirmation, not a bypass.

## 4. Interpret the result and recover a stranded plug

- Exit 0, `recovered`: automated restore completed and the composed recovery
  verdict passed.
- Exit 21, `stranded`: OFF was attempted and ON was not confirmed. Immediately
  copy the exact `handRestoreCommand` shown in this result (configured at
  `cycle.handRestoreCommand`) and run it by hand:

  ```sh
  <HAND-RESTORE-COMMAND-FROM-CONFIG>
  ```

  Failure condition: if that command does not independently confirm power is
  restored, escalate to physical/app control; do not rerun the cycle.
- Exit 22, `not_recovered`: the plug confirmed ON, but the box affirmatively did
  not recover. Plug liveness is not a substitute for recovery.
- Exit 23, `fleet_half_restored`: the box rebooted, but fleet processes lack the
  expected launch flags; follow the fleet restoration procedure.
- Exit 24, `recovery_inconclusive`: a configured recovery check was unreadable.
- Exit 25, `recovery_unconfigured`: recovery evidence was not fully configured.

Generic command failures remain distinct: 1 generic, 2 usage, 3 credentials,
4 device not found, 5 network, 6 API, 7 MFA required, 8 ambiguous device,
9 state unknown, and 10 write contradicted. Stop and correct the named problem;
an auth error does not identify its own cause.

For completeness, the remaining command-specific codes are: 11 wedge not
proven; 12 wedge inconclusive by shared cause; 13 recovery not recovered; 14
recovery fleet half restored; 15 recovery inconclusive; 16 recovery
unconfigured; and 26 invalid config. Codes 27–29 are the doctor results defined
in step 1. Codes 30–33 belong only to the separately documented safe-plug
rehearsal: same-as-fleet refusal, precondition refusal, preview-would-write, and
stranded. Do not use that rehearsal during an outage; follow
[write-rehearsal-procedure.md](write-rehearsal-procedure.md) at a deliberately
chosen time. Every refusal means nothing was cut; code 20 is also non-writing by
construction. Codes 21 and 33 are different: their write was attempted and
restore was not confirmed.

## 5. Verify the box, independently

Failure condition before checking: ssh still failing, or `who -b` reporting the
old boot time, means recovery is **not** confirmed. Once ssh responds, run on
the recovered box through your environment's authoritative access path:

```sh
ssh <FLEET-HOST-FROM-AUTHORITATIVE-INVENTORY> 'who -b'
```

Success requires both ssh returning and `who -b` showing a boot time newer than
the recorded power-cut time. This recovery method was measured; `P5`,
`conn_state`, and all other plug-liveness readings say nothing about broader box
recovery.

## 6. Record without transmitting identifiers

Use [capture-format.md](capture-format.md), writing the expected result before
the command and capturing the exit directly (`cmd > log 2>&1; echo "exit=$?"`).
Before pasting, replace the command's target with a placeholder and run the
result through the repository's paste-back redaction code. Then re-read the
paste specifically for secrets, device macs, plug names, fleet hostnames,
addresses, ports, usernames, and systemd units. Failure condition: if any such
value remains, do not paste it. Record times, exit code, redacted full output,
whether ssh returned, whether `who -b` advanced, and any hand restoration.
