/**
 * Source Readiness
 *
 * One transactional entry point for turning a source-test verdict into durable
 * readiness state and live session exposure. The module owns identity
 * validation, source-test gating, probe verdict, staged-unhealthy persistence,
 * activation ordering, ready persistence, redaction and stable reason mapping.
 *
 * The `SessionSourceReadiness` seam is the only knowledge the caller injects:
 * the live probe backend, a probe that observes the session toolset, an
 * activation that exposes the source and commits bookkeeping, and a config
 * persister. All ordering and failure policy live here so callers only declare
 * intent.
 */

import type {
  ConnectionStatus,
  SourceConfig,
  SourceProbeBackend,
  SourceReadinessReason,
  SourceToolIdentity,
} from '../types.ts';

/** Inputs the source-test handler already resolved before readiness begins. */
export interface SourceReadinessRequest {
  source: SourceConfig;
  /** Connection reachability gate: schema/connection checks passed and connected. */
  sourceTestPassed: boolean;
  connectionStatus: ConnectionStatus;
  /** Whether a passing readiness verdict should expose the source in-session. */
  autoEnable: boolean;
  /** Timestamp stamped into every persisted readiness evidence record. */
  checkedAt: number;
}

/** Result of temporarily exposing the source and observing its session tools. */
export type SourceProbeOutcome =
  | { ok: true; observedTools: SourceToolIdentity[] }
  | { ok: false; reason: 'backend-injection-failed' | 'probe-failed' | 'cleanup-failed' };

/**
 * Result of committing live exposure. The `reason` is a closed diagnostic union
 * describing which activation stage failed; it is never persisted and carries no
 * raw error text. This module surfaces it only as a transient diagnostic on the
 * outcome, mapping every activation failure to the stable `backend-injection-failed`
 * readiness reason for durable state.
 */
export type SourceActivationReason = 'exposure-failed' | 'commit-failed' | 'ready-persist-failed';

export type SourceActivationOutcome =
  | { ok: true }
  | { ok: false; reason: SourceActivationReason };

/**
 * The runtime seam the source-test handler needs to resolve readiness. Built
 * once by the server-core adapter; late-bound onto the session tool context.
 */
export interface SessionSourceReadiness {
  readonly backend: SourceProbeBackend;
  /** Inject, observe and restore the session toolset for a single source. */
  probeSourceTools(sourceSlug: string): Promise<SourceProbeOutcome>;
  /**
   * Expose the source in the live session and commit activation bookkeeping.
   * `persistReady` durably records the ready config and MUST run only after the
   * commit succeeds. Any failure — including a throwing `persistReady` — must
   * restore the pre-activation exposure and resolve to `{ ok: false }`.
   */
  activateSource(sourceSlug: string, persistReady: () => void): Promise<SourceActivationOutcome>;
  /** Persist a source config (staged-unhealthy, unhealthy or ready). */
  persistSourceConfig(source: SourceConfig): void;
}

export type SourceReadinessOutcome =
  | { ready: true; observedTools: SourceToolIdentity[] }
  | {
      ready: false;
      reason: SourceReadinessReason;
      /**
       * Transient, never-persisted diagnostic identifying which activation stage
       * failed. Present only for activation failures so the source-test handler
       * can render a distinct message while the durable reason stays stable.
       */
      activationDiagnostic?: SourceActivationReason;
    };

/**
 * Fallback seam used when the runtime never bound a readiness adapter. It reports
 * an unsupported backend so `resolveSourceReadiness` demotes the source to durable
 * disabled/unhealthy via `persist`, never probing or exposing it. The probe and
 * activation members are unreachable (the unsupported-backend gate short-circuits
 * first) and exist only to satisfy the seam contract.
 */
export function createUnsupportedSessionSourceReadiness(
  persist: (source: SourceConfig) => void,
): SessionSourceReadiness {
  return {
    backend: 'unsupported',
    probeSourceTools(): Promise<SourceProbeOutcome> {
      throw new Error('unsupported backend cannot probe source tools');
    },
    activateSource(): Promise<SourceActivationOutcome> {
      throw new Error('unsupported backend cannot activate a source');
    },
    persistSourceConfig: persist,
  };
}

const SAFE_TOOL_IDENTITY_PART = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const NON_VERSION_METADATA: Record<string, true> = { invalid: true, unknown: true, unversioned: true };

function isExplicitSourceToolVersion(value: string): boolean {
  return SAFE_TOOL_IDENTITY_PART.test(value) && NON_VERSION_METADATA[value.toLowerCase()] !== true;
}

/** Source tool API versions are compatible only when the declared versions match exactly. */
export function isSourceToolVersionCompatible(expected: string, observed: string): boolean {
  return expected === observed;
}

type ProbeVerdict =
  | { ready: true; observedTools: SourceToolIdentity[] }
  | { ready: false; reason: 'missing-tools' | 'version-mismatch'; observedTools: SourceToolIdentity[] };

/**
 * Compares expected identities to the observed session toolset. Only allowlisted
 * identities with explicit versions enter evidence, so caught probe noise and
 * unversioned tools can never leak into a persisted config or public result.
 */
function evaluateProbe(
  expectedTools: SourceToolIdentity[],
  rawObservedTools: SourceToolIdentity[],
): ProbeVerdict {
  const expectedNames = new Set(expectedTools.map((tool) => tool.name));
  const observedTools = rawObservedTools.flatMap((tool) => {
    if (!expectedNames.has(tool.name) || !SAFE_TOOL_IDENTITY_PART.test(tool.name)) return [];
    return isExplicitSourceToolVersion(tool.apiVersion)
      ? [{ name: tool.name, apiVersion: tool.apiVersion }]
      : [];
  });

  const observedByName = new Map<string, string[]>();
  for (const tool of observedTools) {
    const versions = observedByName.get(tool.name) ?? [];
    if (!versions.includes(tool.apiVersion)) versions.push(tool.apiVersion);
    observedByName.set(tool.name, versions);
  }

  const missing = expectedTools.some((tool) => !observedByName.has(tool.name));
  if (missing) return { ready: false, reason: 'missing-tools', observedTools };

  const versionMismatch = expectedTools.some((tool) => {
    const observedApiVersions = observedByName.get(tool.name);
    return (
      observedApiVersions !== undefined
      && !observedApiVersions.some((version) => isSourceToolVersionCompatible(tool.apiVersion, version))
    );
  });
  if (versionMismatch) return { ready: false, reason: 'version-mismatch', observedTools };

  return { ready: true, observedTools };
}

/**
 * Resolves whether a configured source is ready and, when so, exposes it.
 *
 * Ordering invariants (all owned here, never by the caller):
 * - probe cleanup completes before any health is persisted;
 * - staged-unhealthy state is durable before live exposure;
 * - ready state is durable only after the activation commit;
 * - every activation failure leaves the staged-unhealthy state in place.
 */
export async function resolveSourceReadiness(
  request: SourceReadinessRequest,
  session: SessionSourceReadiness,
): Promise<SourceReadinessOutcome> {
  const { source, sourceTestPassed, connectionStatus, autoEnable, checkedAt } = request;
  const slug = source.slug;
  const expectedTools = source.expectedTools ?? [];

  const persistUnhealthy = (
    reason: SourceReadinessReason,
    observedTools?: SourceToolIdentity[],
  ): void => {
    session.persistSourceConfig({
      ...source,
      enabled: false,
      lastTestedAt: checkedAt,
      connectionStatus: 'unhealthy',
      connectionError: reason,
      readiness: {
        status: 'unhealthy',
        reason,
        ...(observedTools ? { observedTools } : {}),
        checkedAt,
      },
    });
  };

  const failUnhealthy = (
    reason: SourceReadinessReason,
    observedTools?: SourceToolIdentity[],
  ): SourceReadinessOutcome => {
    // A persistence failure here still fails closed: the outcome is unhealthy and
    // the caller never exposes the source, so the (possibly stale) durable config
    // is left untouched rather than crashing the tool call.
    try {
      persistUnhealthy(reason, observedTools);
    } catch {
      // fail closed
    }
    return { ready: false, reason };
  };

  if (session.backend === 'unsupported') {
    return failUnhealthy('unsupported-backend');
  }

  const identitiesValid = expectedTools.length > 0
    && expectedTools.every(
      (tool) => SAFE_TOOL_IDENTITY_PART.test(tool.name) && isExplicitSourceToolVersion(tool.apiVersion),
    );
  if (!identitiesValid) {
    return failUnhealthy('source-test-failed');
  }

  // Connection gate is enforced independently here, not just trusted from the
  // caller: a passing source-test flag with any non-connected status is a
  // contradictory request and fails closed.
  if (!sourceTestPassed || connectionStatus !== 'connected') {
    return failUnhealthy('source-test-failed');
  }

  const probe = await session.probeSourceTools(slug);
  if (!probe.ok) {
    return failUnhealthy(probe.reason);
  }

  const verdict = evaluateProbe(expectedTools, probe.observedTools);
  if (!verdict.ready) {
    return failUnhealthy(verdict.reason, verdict.observedTools);
  }
  const observedTools = verdict.observedTools;

  const readyConfig = (): SourceConfig => ({
    ...source,
    enabled: autoEnable,
    lastTestedAt: checkedAt,
    connectionStatus,
    connectionError: undefined,
    readiness: { status: 'ready', observedTools, checkedAt },
  });

  // Verified but activation not requested: record durable ready evidence without
  // live exposure and keep the source disabled.
  if (!autoEnable) {
    try {
      session.persistSourceConfig(readyConfig());
    } catch {
      return { ready: false, reason: 'backend-injection-failed' };
    }
    return { ready: true, observedTools };
  }

  // Staged unhealthy must be durable before exposure so a crash mid-activation
  // never leaves a source enabled without confirmed readiness.
  try {
    session.persistSourceConfig({
      ...source,
      enabled: false,
      lastTestedAt: checkedAt,
      connectionStatus: 'unhealthy',
      connectionError: 'backend-injection-failed',
      readiness: { status: 'unhealthy', reason: 'backend-injection-failed', checkedAt },
    });
  } catch {
    return { ready: false, reason: 'backend-injection-failed' };
  }

  let activation: SourceActivationOutcome;
  try {
    activation = await session.activateSource(slug, () => {
      session.persistSourceConfig(readyConfig());
    });
  } catch {
    return { ready: false, reason: 'backend-injection-failed' };
  }

  if (!activation.ok) {
    // The staged-unhealthy state remains durable; ready is never persisted. The
    // stage-specific reason rides along as a transient diagnostic only.
    return { ready: false, reason: 'backend-injection-failed', activationDiagnostic: activation.reason };
  }

  return { ready: true, observedTools };
}
