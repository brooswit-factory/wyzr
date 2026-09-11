// The injectable boundary for the THREE probes this story adds that do not
// already exist in src/wedge-probes.ts — src/recovery-probes-real.ts (real
// ssh exec) and src/recovery-probes-fake.ts (canned readings) both implement
// this interface, and src/recovery-runner.ts is written against the
// interface only. Same split, same reasoning, as src/wedge-probes.ts vs its
// two implementations vs src/wedge-runner.ts — see that trio's own comments.
//
// DELIBERATELY NOT WIDENED INTO src/wedge-probes.ts's `WedgeProbes`
// interface (the ticket's explicit instruction): `WedgeProbes` is a
// published interface WYZR-19 depends on, and adding methods to it would
// force every existing implementation and fake to change for a consumer
// (this story) that is not WYZR-19. This story's runner
// (src/recovery-runner.ts) takes BOTH a `WedgeProbes` (reused verbatim for
// ssh, tunnel-ping, Jira-activity, GitHub-activity, and local-connectivity —
// see that module's own comment for why) and this new, separate
// `RecoveryProbes` interface for the three genuinely new probes below.
//
// Every method here returns a RAW reading — no verdict/precedence logic
// lives here; src/recovery.ts (the pure engine) never sees a RecoveryProbes,
// only the observation shapes src/recovery-runner.ts assembles from a raw
// reading plus its matching config.

/** The reboot check's uptime probe (ticket's check 2). A DURATION on the
 * suspect box's own monotonic-ish counter — never a wall-clock instant, so
 * neither side's clock skew can produce a false PASS or a false FAIL (see
 * src/recovery.ts's reboot-check comment for the full reasoning). How the
 * duration is obtained is this repo's own choice — see
 * src/recovery-probes-real.ts's top comment for what was chosen and why. */
export interface UptimeProbeConfig {
  readonly host: string;
  readonly timeoutMs: number;
}

export type UptimeRawOutcome = "observed" | "error" | "timeout";

export interface RawUptimeReading {
  readonly outcome: UptimeRawOutcome;
  /** Milliseconds since the suspect box's own boot, per its own monotonic
   * counter. Present (non-null) only when `outcome === "observed"`. A
   * reading that could not be PARSED is reported as `"error"` here (never a
   * pass, never a fail — "could not look," per the ticket) rather than ever
   * falling back to a wall-clock method. */
  readonly uptimeMs: number | null;
  /** Fragment-safe — same rule as src/wedge.ts's InstrumentObservation.note. */
  readonly note: string | null;
}

/** The daemon-health check (ticket's check 3). BOTH `unit` and `scope` are
 * required, with no default for either — see src/recovery-config.ts's top
 * comment for why: a wrong scope must read as "pointed at nothing," never
 * silently as "unhealthy" (the sharp edge the ticket names by name: a
 * system-level query against a user unit looks like an empty, not a wrong,
 * answer). */
export type DaemonScope = "user" | "system";

export interface DaemonProbeConfig {
  readonly host: string;
  readonly unit: string;
  readonly scope: DaemonScope;
  readonly timeoutMs: number;
}

/** Four distinguishable outcomes, per the ticket — not three. `"healthy"`
 * (found, affirmatively running), `"unhealthy"` (found, affirmatively NOT
 * running), `"pointed-at-nothing"` (the unit does not exist under the
 * configured scope — what a WRONG SCOPE looks like, and it must never be
 * read as `"unhealthy"`), or a genuine probe failure (`"error"`/`"timeout"`
 * — "could not look," distinct from both of the above). */
export type DaemonRawOutcome = "healthy" | "unhealthy" | "pointed-at-nothing" | "error" | "timeout";

export interface RawDaemonReading {
  readonly outcome: DaemonRawOutcome;
  readonly note: string | null;
}

/** The fleet-pane-audit check (ticket's check 5 — the herdr-restore trap).
 * `processMatch` and `expectedFlags` are BOTH required, with no default —
 * naming either in this public repo would be exactly the fleet-fact leak
 * the ticket forbids elsewhere. See src/recovery-probes-real.ts's top
 * comment for the enumeration trap this config's shape exists to avoid: the
 * candidate SET must be built from something a bare-restored pane still
 * has, never from `expectedFlags` itself (a bare pane's argv contains none
 * of those flags, so filtering by them would exclude exactly the panes this
 * check exists to catch). */
export interface FleetAuditConfig {
  readonly host: string;
  /** Identifies a CANDIDATE agent process — matched against the process
   * list's own raw text on the probe side only (see
   * src/recovery-probes-real.ts's classifyFleetProcesses()). Must be
   * something a bare-restored pane still has (e.g. the binary name),
   * never one of `expectedFlags`. */
  readonly processMatch: string;
  /** A candidate process "carries the expected spawn flags" only if its
   * argv contains EVERY string in this list; otherwise it is "bare." */
  readonly expectedFlags: readonly string[];
  readonly timeoutMs: number;
}

export type FleetAuditRawOutcome = "enumerated" | "error" | "timeout";

/**
 * COUNTS ONLY — structurally, this is the type that makes the ticket's
 * hardest redaction rule for this check checkable at all: there is no field
 * here a raw argv string, a pid, or a session id could ever be assigned to.
 * See src/recovery-probes-real.ts's checkFleetAudit() for where the
 * classification (which sees raw text) happens and why nothing it sees ever
 * crosses into this shape.
 */
export interface RawFleetAuditReading {
  readonly outcome: FleetAuditRawOutcome;
  /** The denominator — how many candidate agent processes were found at
   * all. Present (non-null) only when `outcome === "enumerated"`. Per the
   * ticket: "0 bare panes found" is only meaningful next to a denominator
   * that could have contained one, so this is ALWAYS reported alongside
   * `bareCount`, never omitted when the latter is present. */
  readonly totalCandidates: number | null;
  readonly flaggedCount: number | null;
  readonly bareCount: number | null;
  /** Fragment-safe — and, for this check specifically, never a raw argv
   * fragment, a pid, or a session id, on ANY path including every error
   * path (see this module's top comment). */
  readonly note: string | null;
}

/**
 * The three probes this story adds. Handed the same config shape the runner
 * already has, same reasoning as src/wedge-probes.ts's `WedgeProbes` — a
 * fake implementation never needs real config to be exercised, and the real
 * implementation never has a second, hidden source of truth for what to
 * probe.
 */
export interface RecoveryProbes {
  checkUptime(config: UptimeProbeConfig): Promise<RawUptimeReading>;
  checkDaemon(config: DaemonProbeConfig): Promise<RawDaemonReading>;
  checkFleetAudit(config: FleetAuditConfig): Promise<RawFleetAuditReading>;
}
