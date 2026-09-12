# Install `wyzr` on the manager box

`wyzr` belongs on the operator's **manager box**, never on the fleet box it
controls. No agent runs it. Before installing, establish which machine you are
on from the authoritative inventory or configuration for your environment; do
not infer it from a shell prompt. Then run `wyzr doctor`: if its wrong-box guard
does not report `not_target`, stop. A `target` or `inconclusive` result means
this machine has not been proved different from the fleet box.

## Install

The package requires Bun. From a reviewed checkout or package artifact chosen
by the maintainer, install dependencies and expose the CLI on the manager box:

```sh
bun install --frozen-lockfile
bun link
wyzr --help
```

Failure condition: if `wyzr --help` does not exit 0 and list `devices`, `plug`,
`wedge`, `recovery`, `cycle`, `doctor`, and `rehearse-safe-plug-write`, stop;
the intended CLI is not installed. Do not install it on the fleet box as a
fallback.

## Provision configuration and credentials

Use the manager box's own XDG configuration base (`$XDG_CONFIG_HOME` when set,
otherwise its user's standard configuration directory). Create its `wyzr`
directory with mode `0700`; create `config.json` and `credentials.json` inside
with mode `0600`:

```sh
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/wyzr"
chmod 700 "${XDG_CONFIG_HOME:-$HOME/.config}/wyzr"
cp docs/config.example.json "${XDG_CONFIG_HOME:-$HOME/.config}/wyzr/config.json"
chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/wyzr/config.json"
chmod 600 "${XDG_CONFIG_HOME:-$HOME/.config}/wyzr/credentials.json"
```

Failure condition: if either file contains example values, is absent, or the
directory/file modes are broader than those above, stop. `config_invalid`
(exit 26) or `credentials_invalid` (exit 3) names the affected field or
permission without printing its value.

The human operator must provision, on the manager box and outside this public
repo:

- working Wyze credentials;
- a fleet plug physically on the fleet box's power cord and a separate safe
  rehearsal plug;
- network access from the manager box to Wyze and all configured probes;
- every environment-specific instrument value; and
- DNS or a hosts entry that resolves the configured `suspectBox.host` from the
  manager box even while the fleet box is powered off. Failure to resolve it
  makes the wrong-box guard refuse; power state must not determine identity.

For the next credential provisioning, re-check this dated, relayed prerequisite:
a maintainer-level reply on a community SDK issue, read 2026-09-02, says an
SSO-created Wyze account has no Wyze-native password for the login MD5 chain and
that the resulting error is indistinguishable from a wrong password or a key
the service never saw. In the Wyze app, open **Account → Security**, verify that
**Change Password** exists, and set a Wyze-specific password. If that option is
absent, stop: the account appears SSO-only. This is community guidance, not a
fact measured by this project; re-verify it at provisioning time.

## Preflight

```sh
wyzr doctor --json
```

Failure condition: anything except `READY`/exit 0 means do not operate. Exit 27
means a check affirmatively failed, 28 means an attempted check was unreadable,
and 29 means something was not configured. An authentication error reports only
what login could not do; never diagnose its cause from `errorCode 1000`.

The staged, human-only write rehearsal is documented in
[write-rehearsal-procedure.md](write-rehearsal-procedure.md). Shipping that
procedure is not evidence it has run.
