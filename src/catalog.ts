/**
 * Shipped launch catalog — the ONLY agent/model/permission combinations the
 * council may launch (PUBLIC-USE.md). Pure and synchronous: no I/O, no
 * network, no provider probing, no auth checks, no environment or secret
 * reads. Type-only imports from contracts.js are erased at compile time, so
 * the module carries zero runtime dependencies beyond node:crypto (fingerprint).
 *
 * Design rules:
 * - Agent ≠ model ≠ profile. `agent` is the CLI agent Orca runs; `model` is a
 *   caller-supplied provider model id validated as DATA (token charset, never
 *   shell); `profile` is a named CLI profile honored only where the CLI
 *   documents a named selector (Codex `--profile`).
 * - Fixed documented argv templates only — posture tokens map to fixed argv
 *   fragments per CLI. Nothing user-supplied becomes a template, flag name,
 *   or path. No arbitrary suppliers, no config paths, no account mutation.
 * - Explicit model ids, not curated lists: the product does not hard-code a
 *   "latest models" allowlist, does not probe providers to learn one, and
 *   does not ship personal pricing/usage claims. An unavailable model fails
 *   at launch visibly — never a substitute or fallback.
 * - Presence/verification labels are honesty data for the caller; they are
 *   NOT launch semantics and are excluded from LAUNCH_POLICY_HASH.
 */

import { createHash } from 'node:crypto';
import type { AgentChoice, CouncilError, ExecutionPolicy, Result } from './contracts.js';

// ─── Token safety ────────────────────────────────────────────────────────────
// Launch values are rendered into argv text, so they get a STRICTER grammar
// than the contract-level TOKEN_RE (which stays permissive for ids like OMP
// "@worker" selectors that never reach a CLI). A leading `@` is PowerShell
// splatting syntax and a leading `-` parses as a flag — both are refused.
// Selector syntax such as "provider/model:level" is accepted as safe opaque
// DATA only; the catalog does not assert that any CLI accepts a particular
// selector, and never infers an ambient match.
const VALUE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;
/**
 * Named CLI profile grammar: a name, never a path — no `/`, `\`, `:`, `@`,
 * `+`, or traversal. Covers documented names like `work` or `team-a`.
 */
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Own-property proof — inherited keys (constructor, toString) are not choices. */
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

// ─── Catalog types ───────────────────────────────────────────────────────────

/** How the launch's provider/account identity is determined. */
export type AccountMode =
  /** The CLI's ambient sign-in/environment — never claimed as a verified identity. */
  | 'ambient'
  /** A documented named profile selector carries the identity (Codex --profile). */
  | 'named-profile';

/** Honesty label for how well a lane is proven. Descriptive, never hashed. */
export type CatalogVerification =
  /** Exercised end-to-end in a live council run. */
  | 'live-verified'
  /** Documented/observed via CLI --help and official docs only. */
  | 'help-verified'
  /** Declared but unverified — launch at the approver's own risk. */
  | 'unverified';

/**
 * One supported CLI agent. `permissionModes` maps each user-facing posture
 * token to a FIXED argv fragment emitted verbatim — there is no default
 * posture: a choice without a valid permissionMode can never launch.
 */
export interface CatalogEntry {
  /** Catalog key and agent identity the launched terminal must report. */
  readonly agent: string;
  /** CLI binary token (also what `council doctor`/`catalog` probes for). */
  readonly binary: string;
  /** Launch lane — this catalog ships documented argv templates only. */
  readonly lane: 'argv';
  /** Model selection is always caller-explicit; the flag that carries it. */
  readonly modelSelection: 'explicit';
  readonly modelFlag: string;
  /** Documented named-profile selector, when the CLI provides one. */
  readonly profileFlag?: string;
  /** Documented effort selector + exact accepted tokens, when verified. */
  readonly effortFlag?: string;
  readonly effortValues?: readonly string[];
  /** posture token → fixed argv fragment tokens. */
  readonly permissionModes: Readonly<Record<string, readonly string[]>>;
  /** How well this lane is proven (descriptive; excluded from the hash). */
  readonly verification: CatalogVerification;
  /** One-line catalog description for `council catalog` output. */
  readonly summary: string;
  /** Factual notes for callers — selectors, caveats. No pricing/auth claims. */
  readonly notes: readonly string[];
}

/** Catalog schema/semantics version. Changes only when launch semantics change. */
export const CATALOG_VERSION = '1.0.0';

/**
 * The shipped catalog. Keys are the AgentChoice.agent values callers write;
 * anything else is refused — there is no fallback lane. The original Devin
 * pin (swe-2-max via its own --model flag, "bypass" → --permission-mode
 * dangerous) remains selectable but is a catalog entry like any other, never
 * a product default.
 */
export const AGENT_CATALOG: Readonly<Record<string, CatalogEntry>> = Object.freeze({
  devin: Object.freeze({
    agent: 'devin',
    binary: 'devin',
    lane: 'argv',
    modelSelection: 'explicit',
    modelFlag: '--model',
    // `devin --model` honors account-catalog model ids (env DEVIN_MODEL);
    // `--effort` is not a documented Devin selector — effort is refused.
    permissionModes: Object.freeze({
      auto: Object.freeze(['--permission-mode', 'auto']),
      'accept-edits': Object.freeze(['--permission-mode', 'accept-edits']),
      smart: Object.freeze(['--permission-mode', 'smart']),
      dangerous: Object.freeze(['--permission-mode', 'dangerous']),
      bypass: Object.freeze(['--permission-mode', 'dangerous']),
    }),
    verification: 'live-verified',
    summary: 'Devin CLI — documented --model/--permission-mode argv lane',
    notes: Object.freeze([
      'Posture "bypass" is council vocabulary emitted as --permission-mode dangerous (the verified all-tools-approved equivalent).',
      'No documented effort selector — an effort request is refused, never ignored.',
      'No named-profile selector — runs on the ambient sign-in; account identity is not asserted.',
    ]),
  }),
  claude: Object.freeze({
    agent: 'claude',
    binary: 'claude',
    lane: 'argv',
    modelSelection: 'explicit',
    modelFlag: '--model',
    // `claude --effort` is verified in help: low|medium|high|max.
    effortFlag: '--effort',
    effortValues: Object.freeze(['low', 'medium', 'high', 'max']),
    permissionModes: Object.freeze({
      default: Object.freeze(['--permission-mode', 'default']),
      auto: Object.freeze(['--permission-mode', 'auto']),
      plan: Object.freeze(['--permission-mode', 'plan']),
      'accept-edits': Object.freeze(['--permission-mode', 'acceptEdits']),
      bypass: Object.freeze(['--permission-mode', 'bypassPermissions']),
    }),
    verification: 'help-verified',
    summary: 'Claude Code CLI — documented --model/--effort/--permission-mode argv lane',
    notes: Object.freeze([
      'Posture "bypass" maps to --permission-mode bypassPermissions; "accept-edits" to acceptEdits.',
      'Effort tokens verified in help: low, medium, high, max.',
      '--settings is a file path, not a named provider profile — profile requests are refused.',
      '--fallback-model is never emitted: the council has no model fallback.',
    ]),
  }),
  codex: Object.freeze({
    agent: 'codex',
    binary: 'codex',
    lane: 'argv',
    modelSelection: 'explicit',
    modelFlag: '--model',
    // `codex --profile <name>` — the only documented NAMED profile selector
    // shipped. The catalog validates it as a name token, never a path.
    profileFlag: '--profile',
    permissionModes: Object.freeze({
      // Codex posture is a --sandbox + --ask-for-approval pair, both fixed.
      auto: Object.freeze(['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request']),
      'read-only': Object.freeze(['--sandbox', 'read-only', '--ask-for-approval', 'never']),
      bypass: Object.freeze(['--sandbox', 'danger-full-access', '--ask-for-approval', 'never']),
    }),
    verification: 'live-verified',
    summary: 'Codex CLI — documented --model/--profile/--sandbox argv lane',
    notes: Object.freeze([
      'Live-verified as a supervisor on a bounded run (launch, model pin, spec intake, one advance, clean cancel); no full council seat run yet.',
      'Posture maps to a fixed --sandbox + --ask-for-approval pair; there is no single permission flag.',
      'No verified effort selector — an effort request is refused explicitly, not ignored.',
      '--profile <name> is the documented named-profile selector; without it the ambient sign-in applies and is not asserted.',
      'Local supplier lanes exist (--oss/--local-provider) but are unverified here — unlisted modes are refused.',
    ]),
  }),
});

// ─── Errors ──────────────────────────────────────────────────────────────────

function catErr(
  code: CouncilError['code'],
  message: string,
  details?: Record<string, unknown>,
): CouncilError {
  const e: CouncilError = { code, message };
  if (details !== undefined) e.details = details;
  return e;
}

const fail = <T>(error: CouncilError): Result<T> => ({ ok: false, error });
const okVoid = (): Result<void> => ({ ok: true, value: undefined });

// ─── Validation and resolution ───────────────────────────────────────────────

/**
 * Validate one explicit AgentChoice against the shipped catalog. Synchronous
 * and total — this is EngineDeps.execution.validateChoice. Rejects: unknown
 * agent, unsafe model/profile token, posture outside the entry's explicit
 * map, effort on an agent with no verified selector or unlisted value, and a
 * named profile on an agent with no documented profile flag. Never rewrites
 * the choice and never substitutes.
 */
export function validateAgentChoice(choice: AgentChoice): Result<void> {
  // Own-property proof on every lookup — "constructor"/"toString" pass token
  // parsing upstream but must never resolve to inherited members here.
  if (!hasOwn(AGENT_CATALOG, choice.agent)) {
    return fail(catErr('unsupported', `no launch catalog entry for agent ${JSON.stringify(choice.agent)}`, {
        agent: choice.agent,
        supported: Object.keys(AGENT_CATALOG),
      }));
  }
  const entry = AGENT_CATALOG[choice.agent]!;
  if (!VALUE_TOKEN_RE.test(choice.model)) {
    return fail(catErr('config_invalid', `model ${JSON.stringify(choice.model)} is not a safe argv value`, { agent: choice.agent }));
  }
  if (!hasOwn(entry.permissionModes, choice.permissionMode)) {
    return fail(catErr('unsupported',
      `permissionMode ${JSON.stringify(choice.permissionMode)} is not a catalog posture for ${choice.agent}`,
      { agent: choice.agent, postures: Object.keys(entry.permissionModes) }));
  }
  if (choice.effort !== undefined) {
    if (!VALUE_TOKEN_RE.test(choice.effort)) {
      return fail(catErr('config_invalid', `effort ${JSON.stringify(choice.effort)} is not a safe argv value`, { agent: choice.agent }));
    }
    if (entry.effortValues === undefined) {
      return fail(catErr('unsupported',
        `agent ${choice.agent} has no verified effort selector — refusing rather than ignoring`,
        { agent: choice.agent, effort: choice.effort }));
    }
    if (!entry.effortValues.includes(choice.effort)) {
      return fail(catErr('unsupported',
        `effort ${JSON.stringify(choice.effort)} is not a documented value for ${choice.agent}`,
        { agent: choice.agent, effortValues: entry.effortValues }));
    }
  }
  if (choice.profile !== undefined) {
    if (!PROFILE_NAME_RE.test(choice.profile)) {
      return fail(catErr('config_invalid', `profile ${JSON.stringify(choice.profile)} is not a named profile (name token only, never a path)`, { agent: choice.agent }));
    }
    if (entry.profileFlag === undefined) {
      return fail(catErr('unsupported',
        `agent ${choice.agent} has no documented named-profile selector — refusing rather than asserting an ambient match`,
        { agent: choice.agent, profile: choice.profile }));
    }
  }
  return okVoid();
}

export interface ResolvedLaunch {
  /** Fixed argv fragment list — compose with spaces into `terminal create --command`. */
  command: readonly string[];
  /** Agent identity the readiness check must observe on the terminal. */
  expectedAgent: string;
  /** Honesty label for how well this lane is proven. */
  verification: CatalogVerification;
  /** How provider/account identity is determined for this launch. */
  accountMode: AccountMode;
}

/**
 * Resolve an approved AgentChoice to its concrete argv template. Pure — the
 * returned tokens are binary, fixed flags, and catalog/approved values only.
 * Model tokens may carry provider/model:level selector syntax as opaque data;
 * the catalog guarantees only that they are shell-safe argv tokens, not that
 * a given CLI accepts a particular selector. Nothing is ever joined from
 * unvalidated text.
 */
export function resolveAgentLaunch(choice: AgentChoice): Result<ResolvedLaunch> {
  const v = validateAgentChoice(choice);
  if (!v.ok) return fail(v.error);
  const entry = AGENT_CATALOG[choice.agent]!;

  const command: string[] = [entry.binary, entry.modelFlag, choice.model];
  command.push(...entry.permissionModes[choice.permissionMode]!);
  if (choice.effort !== undefined) {
    command.push(entry.effortFlag!, choice.effort);
  }
  if (choice.profile !== undefined) {
    command.push(entry.profileFlag!, choice.profile);
  }
  return {
    ok: true,
    value: {
      command,
      expectedAgent: entry.agent,
      verification: entry.verification,
      accountMode: choice.profile !== undefined ? 'named-profile' : 'ambient',
    },
  };
}

// ─── Catalog description (for `council catalog` / doctor) ────────────────────

/**
 * Presentation view of one catalog entry. The CLI adds binary presence and
 * account probes itself — this module only ships what the launch policy
 * declares, labeled by verification status. Presence never implies
 * authenticated, approved, free, or unlimited.
 */
export interface CatalogDescription {
  agent: string;
  binary: string;
  lane: 'argv';
  modelSelection: 'explicit';
  modelFlag: string;
  profileFlag: string | null;
  effortFlag: string | null;
  effortValues: readonly string[] | null;
  permissionModes: readonly string[];
  verification: CatalogVerification;
  summary: string;
  notes: readonly string[];
}

/** Stable, sorted catalog listing for `council catalog --json`. */
export function describeCatalog(): readonly CatalogDescription[] {
  return Object.values(AGENT_CATALOG).map((e) => ({
    agent: e.agent,
    binary: e.binary,
    lane: e.lane,
    modelSelection: e.modelSelection,
    modelFlag: e.modelFlag,
    profileFlag: e.profileFlag ?? null,
    effortFlag: e.effortFlag ?? null,
    effortValues: e.effortValues ?? null,
    permissionModes: Object.keys(e.permissionModes).sort(),
    verification: e.verification,
    summary: e.summary,
    notes: e.notes,
  }));
}

// ─── Policy fingerprint ──────────────────────────────────────────────────────

/**
 * Deterministic canonical JSON — recursively sorted keys, undefined dropped.
 * Same canonicalization convention as validation.ts so catalog and approval
 * fingerprints share one stable byte form.
 */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys
    .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

/**
 * The launch-semantics projection of the catalog — exactly the fields that
 * change emitted argv or validation outcomes. Descriptive fields
 * (verification, summary, notes) are excluded: relabeling a lane's evidence
 * level must not invalidate existing approvals.
 */
function policyProjection(): unknown {
  const agents: Record<string, unknown> = {};
  for (const [id, e] of Object.entries(AGENT_CATALOG)) {
    agents[id] = {
      agent: e.agent,
      binary: e.binary,
      lane: e.lane,
      modelSelection: e.modelSelection,
      modelFlag: e.modelFlag,
      profileFlag: e.profileFlag,
      effortFlag: e.effortFlag,
      effortValues: e.effortValues,
      permissionModes: e.permissionModes,
    };
  }
  return { catalogVersion: CATALOG_VERSION, agents };
}

/**
 * sha256 fingerprint of the shipped launch policy — stored on
 * CouncilConfig.execution.policyHash at init and re-checked against the
 * loaded catalog before any launch in execution-config runs. Deterministic:
 * same catalog data → same hash on every platform.
 */
export const LAUNCH_POLICY_HASH: string = createHash('sha256')
  .update(canonicalJson(policyProjection()), 'utf8')
  .digest('hex');

/**
 * The concrete EngineDeps.execution implementation — the single policy the
 * CLI and host adapter inject so engine, CLI, and adapter share one shipped
 * catalog.
 */
export const CATALOG_EXECUTION_POLICY: ExecutionPolicy = Object.freeze({
  policyHash: LAUNCH_POLICY_HASH,
  validateChoice: validateAgentChoice,
});
