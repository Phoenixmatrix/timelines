import { describe, expect, test } from "vite-plus/test";
import {
  bucketsFor,
  checkCursorBinding,
  cursorRequestDigest,
  METRIC_IDS,
  METRICS,
  normalizeCommitRef,
  normalizeTraceRef,
  OBSERVABILITY_CURSOR_MAX_AGE_MS,
  OBSERVABILITY_MAX_BUCKETS,
  OBSERVABILITY_PAGE_DEFAULT,
  OBSERVABILITY_PAGE_MAX,
  OBSERVABILITY_PROVIDERS,
  ObservabilityError,
  observationBindingCheck,
  pageLimit,
  parseUtcInstant,
  ratePoints,
  retentionSplit,
  safeProviderLink,
  UNAVAILABLE_REASONS,
  validateCapability,
  validateEvidence,
  validateInterval,
  validateLinkPrefixes,
  validateProviderDeployment,
  validateSeries as validateSeriesAt,
  type CursorBinding,
  type DatasetCapability,
  type EvidenceCandidate,
  type ProviderDeployment,
  type RuntimeEvidence,
  type Series,
  type ServiceBinding,
} from "./observability.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const LIMITS = { maxIntervalMs: 7 * DAY, minBucketMs: MINUTE, maxBuckets: 500 };
const NOW = "2026-10-12T20:00:00.000Z";
const OID = "0123456789abcdef0123456789abcdef01234567";

/** Series checks at {@link NOW}. */
const validateSeries = (series: Series) => validateSeriesAt(series, NOW);

/** An array with an empty slot at `hole`, as a provider bug might produce. */
function withHole(values: number[], hole: number): (number | null)[] {
  const out: (number | null)[] = Array(values.length);
  values.forEach((value, i) => {
    if (i !== hole) out[i] = value;
  });
  return out;
}

function invalid(run: () => unknown, message: RegExp) {
  expect(run).toThrow(ObservabilityError);
  expect(run).toThrow(message);
}

describe("contract shape", () => {
  test("Cloudflare is the only provider; there is no otel provider", () => {
    expect(OBSERVABILITY_PROVIDERS).toEqual(["cloudflare"]);
  });

  test("every metric is defined under its own id, rates name both counts", () => {
    for (const id of METRIC_IDS) {
      const metric = METRICS[id];
      expect(metric.id).toBe(id);
      if (metric.kind === "rate") {
        expect(METRICS[metric.numerator!].kind).toBe("count");
        expect(METRICS[metric.denominator!].kind).toBe("count");
      } else {
        expect(metric.numerator).toBeNull();
        expect(metric.denominator).toBeNull();
      }
    }
    expect(METRICS["worker.exception_rate"].denominator).toBe("worker.invocations");
    expect(METRICS["tracker.bug_events"].source).toBe("gitmatrix");
  });

  test("edge and origin 5xx are separate signals over the same request denominator", () => {
    expect(METRICS["http.edge_5xx_rate"]).toMatchObject({
      numerator: "http.edge_5xx",
      denominator: "http.requests",
    });
    expect(METRICS["http.origin_5xx_rate"]).toMatchObject({
      numerator: "http.origin_5xx",
      denominator: "http.requests",
    });
    expect(METRIC_IDS).not.toContain("http.5xx" as never);
  });

  test("unavailable reasons include read-by-id and binding drift", () => {
    expect(UNAVAILABLE_REASONS).toContain("not_found");
    expect(UNAVAILABLE_REASONS).toContain("binding_changed");
    expect(UNAVAILABLE_REASONS).toContain("expired_at_provider");
  });
});

describe("parseUtcInstant", () => {
  test("accepts strict UTC instants", () => {
    expect(parseUtcInstant("2026-10-12T20:00:00Z")).toBe(Date.UTC(2026, 9, 12, 20));
    expect(parseUtcInstant("2026-10-12T20:00:00.5Z")).toBe(Date.UTC(2026, 9, 12, 20, 0, 0, 500));
    expect(parseUtcInstant(NOW)).toBe(Date.UTC(2026, 9, 12, 20));
    expect(parseUtcInstant("2028-02-29T00:00:00Z")).toBe(Date.UTC(2028, 1, 29));
    expect(parseUtcInstant("1970-01-01T00:00:00Z")).toBe(0);
  });

  test.each([
    "2026-10-12T20:00:00+00:00",
    "2026-10-12T22:00:00+02:00",
    "2026-10-12T20:00:00",
    "2026-10-12",
    "2026-10-12 20:00:00Z",
    "2026-10-12t20:00:00z",
    "2026-02-29T00:00:00Z",
    "2026-02-30T00:00:00Z",
    "2026-10-12T24:00:00Z",
    "2026-12-31T23:59:60Z",
    "2026-10-12T20:00:00.1234Z",
    "1969-12-31T23:59:59.999Z",
    "0000-01-01T00:00:00Z",
    "1760299200000",
  ])("refuses %s", (value) => invalid(() => parseUtcInstant(value), /Invalid time/));

  test("refuses non-strings", () => {
    invalid(() => parseUtcInstant(Date.UTC(2026, 0, 1)), /expected a UTC ISO time/);
  });
});

describe("validateInterval", () => {
  test("returns canonical instants", () => {
    expect(
      validateInterval(
        { start: "2026-10-12T18:00:00Z", end: "2026-10-12T19:00:00.000Z" },
        LIMITS,
        NOW,
      ),
    ).toEqual({ start: "2026-10-12T18:00:00.000Z", end: "2026-10-12T19:00:00.000Z" });
  });

  test("start must be before end", () => {
    invalid(
      () => validateInterval({ start: NOW, end: NOW }, LIMITS, NOW),
      /start must be before end/,
    );
    invalid(
      () => validateInterval({ start: NOW, end: "2026-10-12T19:00:00Z" }, LIMITS, NOW),
      /start must be before end/,
    );
  });

  test("no longer than the provider allows", () => {
    const start = "2026-10-05T20:00:00Z";
    expect(validateInterval({ start, end: NOW }, LIMITS, NOW).start).toBe(
      "2026-10-05T20:00:00.000Z",
    );
    invalid(
      () => validateInterval({ start: "2026-10-05T19:59:59.999Z", end: NOW }, LIMITS, NOW),
      /longer than/,
    );
  });

  test("ends at most an hour past now", () => {
    expect(validateInterval({ start: NOW, end: "2026-10-12T21:00:00Z" }, LIMITS, NOW).end).toBe(
      "2026-10-12T21:00:00.000Z",
    );
    invalid(
      () => validateInterval({ start: NOW, end: "2026-10-12T21:00:00.001Z" }, LIMITS, NOW),
      /future/,
    );
  });

  test("refuses malformed input and limits", () => {
    invalid(() => validateInterval(null, LIMITS, NOW), /expected \{start, end\}/);
    invalid(
      () => validateInterval({ start: "yesterday", end: NOW }, LIMITS, NOW),
      /interval start/,
    );
    invalid(
      () => validateInterval({ start: NOW, end: NOW }, { ...LIMITS, maxIntervalMs: 0 }, NOW),
      /maxIntervalMs/,
    );
  });
});

describe("bucketsFor", () => {
  const interval = { start: "2026-10-12T18:00:00.000Z", end: "2026-10-12T20:00:00.000Z" };

  test("covers the interval exactly, canonical", () => {
    expect(bucketsFor(interval, 5 * MINUTE, LIMITS)).toEqual({
      start: interval.start,
      bucketMs: 5 * MINUTE,
      count: 24,
    });
    expect(
      bucketsFor({ start: "2026-10-12T18:00:00Z", end: "2026-10-12T20:00:00Z" }, HOUR, LIMITS)
        .start,
    ).toBe(interval.start);
  });

  test("width is a multiple of the provider's minimum", () => {
    invalid(
      () => bucketsFor(interval, 90_000, { ...LIMITS, minBucketMs: 60_000 }),
      /multiple of 60000/,
    );
    invalid(() => bucketsFor(interval, 0, LIMITS), /positive whole number/);
    invalid(() => bucketsFor(interval, 1.5, LIMITS), /positive whole number/);
  });

  test("both ends align to the width from the UTC epoch", () => {
    invalid(
      () => bucketsFor({ ...interval, start: "2026-10-12T18:01:00Z" }, 5 * MINUTE, LIMITS),
      /align/,
    );
    invalid(
      () => bucketsFor({ ...interval, end: "2026-10-12T19:59:00Z" }, 5 * MINUTE, LIMITS),
      /align/,
    );
    // A New York or Kolkata "day"/"hour" is not a UTC-aligned bucket: the UI snaps to UTC.
    const month = { ...LIMITS, maxIntervalMs: 30 * DAY };
    invalid(
      () => bucketsFor({ start: "2026-10-12T04:00:00Z", end: "2026-10-13T04:00:00Z" }, DAY, month),
      /align/,
    );
    invalid(
      () => bucketsFor({ start: "2026-10-11T18:30:00Z", end: "2026-10-12T18:30:00Z" }, HOUR, month),
      /align/,
    );
    expect(
      bucketsFor({ start: "2026-10-12T00:00:00Z", end: "2026-10-13T00:00:00Z" }, DAY, month).count,
    ).toBe(1);
  });

  test("no longer than the provider allows", () => {
    const limits = { maxIntervalMs: HOUR, minBucketMs: MINUTE, maxBuckets: 100 };
    expect(bucketsFor({ ...interval, end: "2026-10-12T19:00:00Z" }, MINUTE, limits).count).toBe(60);
    invalid(() => bucketsFor(interval, DAY / 24, limits), /longer than/);
  });

  test("no more buckets than the provider or the shared ceiling allow", () => {
    expect(bucketsFor(interval, MINUTE, { ...LIMITS, maxBuckets: 120 }).count).toBe(120);
    invalid(() => bucketsFor(interval, MINUTE, { ...LIMITS, maxBuckets: 119 }), /more than 119/);
    const day = { start: "2026-10-11T00:00:00Z", end: "2026-10-12T00:00:01Z" };
    invalid(
      () => bucketsFor(day, 1000, { maxIntervalMs: 2 * DAY, minBucketMs: 1000, maxBuckets: 1e9 }),
      new RegExp(`more than ${OBSERVABILITY_MAX_BUCKETS}`),
    );
  });
});

describe("pageLimit", () => {
  test("defaults, accepts 1 to the maximum, refuses the rest", () => {
    expect(pageLimit(undefined)).toBe(OBSERVABILITY_PAGE_DEFAULT);
    expect(pageLimit(null)).toBe(OBSERVABILITY_PAGE_DEFAULT);
    expect(pageLimit(1)).toBe(1);
    expect(pageLimit(OBSERVABILITY_PAGE_MAX)).toBe(OBSERVABILITY_PAGE_MAX);
    for (const value of [0, -1, OBSERVABILITY_PAGE_MAX + 1, 2.5, "10", Number.NaN])
      invalid(() => pageLimit(value), /Invalid limit/);
  });
});

describe("retentionSplit", () => {
  const interval = { start: "2026-10-12T10:00:00.000Z", end: "2026-10-12T14:00:00.000Z" };

  test("splits at the retention horizon", () => {
    expect(retentionSplit(interval, 8 * HOUR, NOW)).toEqual({
      expired: { start: interval.start, end: "2026-10-12T12:00:00.000Z" },
      live: { start: "2026-10-12T12:00:00.000Z", end: interval.end },
    });
  });

  test("wholly live, wholly expired, or unknown retention", () => {
    expect(retentionSplit(interval, DAY, NOW)).toEqual({ expired: null, live: interval });
    expect(retentionSplit(interval, HOUR, NOW)).toEqual({ expired: interval, live: null });
    expect(retentionSplit(interval, 10 * HOUR, NOW)).toEqual({ expired: null, live: interval });
    expect(retentionSplit(interval, 6 * HOUR, NOW)).toEqual({ expired: interval, live: null });
    expect(retentionSplit(interval, null, NOW)).toEqual({ expired: null, live: interval });
  });

  test("returns canonical instants", () => {
    const loose = { start: "2026-10-12T10:00:00Z", end: "2026-10-12T14:00:00Z" };
    expect(retentionSplit(loose, DAY, NOW)).toEqual({ expired: null, live: interval });
    expect(retentionSplit(loose, null, NOW)).toEqual({ expired: null, live: interval });
    expect(retentionSplit(loose, HOUR, NOW)).toEqual({ expired: interval, live: null });
  });

  test("refuses bad retention and intervals", () => {
    for (const retention of [Number.NaN, 0, -5, Infinity, 1.5])
      invalid(() => retentionSplit(interval, retention, NOW), /retentionMs/);
    invalid(
      () => retentionSplit({ start: interval.end, end: interval.start }, HOUR, NOW),
      /start must be before end/,
    );
    invalid(() => retentionSplit(interval, HOUR, "now"), /Invalid now/);
  });
});

describe("validateCapability", () => {
  const capability: DatasetCapability = {
    dataset: "workers",
    stability: "beta",
    reads: ["series", "error-groups"],
    metrics: ["worker.invocations", "worker.exceptions"],
    retentionMs: 7 * DAY,
    limits: LIMITS,
  };

  test("accepts a consistent capability", () => {
    expect(validateCapability(capability)).toBe(capability);
    expect(
      validateCapability({ ...capability, reads: ["traces"], metrics: [], retentionMs: null }),
    ).toBeTruthy();
  });

  test.each([
    [{ dataset: "" }, /dataset/],
    [{ stability: "alpha" as never }, /stability/],
    [{ reads: ["series", "logs" as never] }, /read/],
    [{ reads: ["series", "series"] as never }, /read is listed twice/],
    [{ metrics: ["worker.exceptions", "made.up" as never] }, /metric/],
    [{ metrics: ["worker.exceptions", "worker.exceptions"] as never }, /metric is listed twice/],
    [{ metrics: ["tracker.bug_events"] as never }, /isn't a provider's/],
    [{ reads: ["error-groups"] as never }, /series read/],
    [{ metrics: [] }, /series read/],
    [{ retentionMs: 0 }, /retentionMs/],
    [{ limits: { ...LIMITS, minBucketMs: -1 } }, /minBucketMs/],
  ] as [Partial<DatasetCapability>, RegExp][])("refuses %j", (overrides, message) =>
    invalid(() => validateCapability({ ...capability, ...overrides }), message),
  );
});

describe("normalizeCommitRef", () => {
  test("needs repoId, sourceId and a full object id", () => {
    expect(normalizeCommitRef({ repoId: "repo_1", sourceId: "canonical", commit: OID })).toEqual({
      repoId: "repo_1",
      sourceId: "canonical",
      commit: OID,
    });
  });

  test("a bare SHA is not an identity", () => {
    invalid(() => normalizeCommitRef(OID), /bare SHA needs its repoId and sourceId/);
  });

  test.each([
    [{ sourceId: "canonical", commit: OID }, /repoId/],
    [{ repoId: "repo_1", commit: OID }, /sourceId/],
    [{ repoId: "", sourceId: "canonical", commit: OID }, /repoId/],
    [{ repoId: "repo 1", sourceId: "canonical", commit: OID }, /repoId/],
    [{ repoId: "repo_1", sourceId: "canonical", commit: OID.slice(0, 12) }, /40-character/],
    [{ repoId: "repo_1", sourceId: "canonical", commit: OID.toUpperCase() }, /40-character/],
    [{ repoId: "repo_1", sourceId: "canonical", commit: "production" }, /40-character/],
    [null, /expected \{repoId, sourceId, commit\}/],
  ])("refuses %j", (value, message) => invalid(() => normalizeCommitRef(value), message));
});

describe("normalizeTraceRef", () => {
  const trace = {
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    rayId: null,
    link: null,
  };

  test("accepts W3C ids and a Ray id", () => {
    expect(normalizeTraceRef(trace)).toBe(trace);
    expect(normalizeTraceRef({ ...trace, spanId: null, rayId: "8c1f0e2d3a4b5c6d-SJC" }).rayId).toBe(
      "8c1f0e2d3a4b5c6d-SJC",
    );
  });

  test("refuses malformed or all-zero ids", () => {
    invalid(() => normalizeTraceRef({ ...trace, traceId: "0".repeat(32) }), /trace id/);
    invalid(
      () => normalizeTraceRef({ ...trace, traceId: trace.traceId.toUpperCase() }),
      /trace id/,
    );
    invalid(() => normalizeTraceRef({ ...trace, spanId: "0".repeat(16) }), /span id/);
    invalid(() => normalizeTraceRef({ ...trace, spanId: "00f067aa" }), /span id/);
    invalid(() => normalizeTraceRef({ ...trace, rayId: "" }), /Ray id/);
  });
});

describe("validateEvidence", () => {
  const commit = { repoId: "repo_1", sourceId: "canonical", commit: OID };
  const other = { ...commit, sourceId: "work_2" };
  const version = {
    connectionId: "conn_1",
    bindingId: "bind_1",
    versionId: "v1",
    deploymentId: null,
  };
  const digest = `sha256:${"a".repeat(64)}`;
  const candidate = (overrides: Partial<EvidenceCandidate> = {}): EvidenceCandidate => ({
    commit,
    version,
    artifact: null,
    deploymentId: "7",
    times: [{ kind: "deployment", at: NOW }],
    ...overrides,
  });
  const evidence = (overrides: Partial<RuntimeEvidence> = {}): RuntimeEvidence => ({
    attribution: "explicit",
    join: "direct",
    candidates: [candidate()],
    ...overrides,
  });

  test("explicit: exactly one candidate with a version or an artifact digest", () => {
    expect(validateEvidence(evidence())).toEqual(evidence());
    const artifact = { packageId: "pkg", version: "1.0.0", digest };
    expect(
      validateEvidence(evidence({ candidates: [candidate({ version: null, artifact })] }))
        .candidates[0]!.artifact,
    ).toEqual(artifact);
    invalid(
      () => validateEvidence(evidence({ candidates: [candidate({ version: null })] })),
      /provider version or an artifact digest/,
    );
    invalid(
      () =>
        validateEvidence(
          evidence({
            candidates: [candidate({ version: null, artifact: { ...artifact, digest: null } })],
          }),
        ),
      /provider version or an artifact digest/,
    );
    invalid(
      () => validateEvidence(evidence({ candidates: [candidate(), candidate({ commit: other })] })),
      /explicit attribution has exactly one candidate/,
    );
  });

  test("temporal: exactly one candidate, matched by deployment or exposure time", () => {
    const temporal = { attribution: "temporal" as const, join: "derived" as const };
    const byTime = candidate({ version: null, deploymentId: null });
    expect(validateEvidence(evidence({ ...temporal, candidates: [byTime] })).candidates).toEqual([
      byTime,
    ]);
    const exposed = { ...byTime, times: [{ kind: "exposure" as const, at: NOW }] };
    expect(validateEvidence(evidence({ ...temporal, candidates: [exposed] })).attribution).toBe(
      "temporal",
    );
    invalid(
      () =>
        validateEvidence(
          evidence({ ...temporal, candidates: [byTime, { ...byTime, commit: other }] }),
        ),
      /temporal attribution has exactly one candidate/,
    );
    invalid(
      () =>
        validateEvidence(
          evidence({
            ...temporal,
            candidates: [{ ...byTime, times: [{ kind: "commit", at: NOW }] }],
          }),
        ),
      /deployment or exposure time/,
    );
  });

  test("ambiguous: one or more visible candidates", () => {
    const ambiguous = { attribution: "ambiguous" as const, join: "derived" as const };
    const visible = candidate({ commit: { ...commit, repoId: "visible" } });
    const hidden = candidate({ commit: { ...commit, repoId: "hidden" } });
    const all = evidence({ ...ambiguous, candidates: [visible, hidden] });
    expect(validateEvidence(all).candidates).toHaveLength(2);
    // The caller can't read "hidden": the server omits it and the evidence stays ambiguous.
    const filtered = {
      ...all,
      candidates: all.candidates.filter((c) => c.commit.repoId !== "hidden"),
    };
    expect(validateEvidence(filtered)).toEqual({ ...ambiguous, candidates: [visible] });
  });

  test("no candidates: omit the evidence, never an empty ambiguity", () => {
    for (const attribution of ["explicit", "temporal", "ambiguous"] as const)
      invalid(
        () => validateEvidence(evidence({ attribution, candidates: [] })),
        /no candidates; omit the evidence/,
      );
  });

  test("a direct join names every deployment record; a derived one needn't", () => {
    invalid(
      () => validateEvidence(evidence({ candidates: [candidate({ deploymentId: null })] })),
      /direct join needs each deployment record/,
    );
    expect(
      validateEvidence(
        evidence({ join: "derived", candidates: [candidate({ deploymentId: null })] }),
      ).join,
    ).toBe("derived");
    invalid(
      () =>
        validateEvidence(
          evidence({
            attribution: "ambiguous",
            candidates: [candidate(), candidate({ commit: other, deploymentId: null })],
          }),
        ),
      /direct join needs each deployment record/,
    );
  });

  test("malformed shapes are refused, not crashed on", () => {
    invalid(
      () => validateEvidence({ ...evidence(), candidates: undefined } as never),
      /evidence candidates: expected a list/,
    );
    invalid(
      () =>
        validateEvidence(evidence({ candidates: [{ ...candidate(), times: undefined } as never] })),
      /candidate times: expected a list/,
    );
    invalid(
      () => validateEvidence(evidence({ candidates: [candidate({ times: [null as never] })] })),
      /candidate time: expected an object/,
    );
    invalid(
      () => validateEvidence(evidence({ candidates: [null as never] })),
      /expected an object/,
    );
    invalid(() => validateEvidence(null as never), /evidence: expected an object/);
    invalid(
      () =>
        validateEvidence(
          evidence({ candidates: [{ ...candidate(), commit: undefined } as never] }),
        ),
      /Invalid commit/,
    );
    invalid(
      () => validateEvidence(evidence({ candidates: [candidate({ version: "v1" as never })] })),
      /version: expected an object/,
    );
  });

  test("a missing version, artifact or deploymentId reads as null", () => {
    const { version: _v, artifact: _a, deploymentId: _d, ...bare } = candidate();
    const checked = validateEvidence(
      evidence({ attribution: "ambiguous", join: "derived", candidates: [bare as never] }),
    );
    expect(checked.candidates[0]).toEqual({
      ...bare,
      version: null,
      artifact: null,
      deploymentId: null,
    });
    const undefinedFields = {
      ...candidate(),
      version: undefined,
      artifact: undefined,
      deploymentId: undefined,
    };
    expect(
      validateEvidence(
        evidence({
          attribution: "ambiguous",
          join: "derived",
          candidates: [undefinedFields as never],
        }),
      ).candidates[0],
    ).toEqual(checked.candidates[0]);
  });

  test("attribution, join and timestamp kinds are known values", () => {
    invalid(() => validateEvidence(evidence({ attribution: "definite" as never })), /attribution/);
    invalid(() => validateEvidence(evidence({ join: "causal" as never })), /join/);
    invalid(
      () =>
        validateEvidence(
          evidence({ candidates: [candidate({ times: [{ kind: "push" as never, at: NOW }] })] }),
        ),
      /timestamp kind/,
    );
  });

  test("versions, digests and ids have their shapes", () => {
    for (const bad of [
      { ...version, versionId: "" },
      { ...version, connectionId: "" },
      { ...version, bindingId: "" },
      { ...version, deploymentId: "" },
    ])
      invalid(
        () => validateEvidence(evidence({ candidates: [candidate({ version: bad })] })),
        /Invalid/,
      );
    for (const bad of ["x", "sha256:", "sha256:XYZ", `SHA256:${"a".repeat(64)}`, "a".repeat(64), 7])
      invalid(
        () =>
          validateEvidence(
            evidence({
              candidates: [
                candidate({ artifact: { packageId: "pkg", version: "1", digest: bad as never } }),
              ],
            }),
          ),
        /artifact digest/,
      );
    invalid(
      () => validateEvidence(evidence({ candidates: [candidate({ deploymentId: "" })] })),
      /deploymentId/,
    );
  });

  test("candidates are listed once, by commit, version, artifact and record", () => {
    const ambiguous = { attribution: "ambiguous" as const, join: "derived" as const };
    invalid(
      () => validateEvidence(evidence({ ...ambiguous, candidates: [candidate(), candidate()] })),
      /listed twice/,
    );
    const packages = [
      candidate({ artifact: { packageId: "a", version: "1", digest: null } }),
      candidate({ artifact: { packageId: "b", version: "1", digest: null } }),
    ];
    expect(
      validateEvidence(evidence({ ...ambiguous, candidates: packages })).candidates,
    ).toHaveLength(2);
    const digests = [
      candidate({ artifact: { packageId: "a", version: "1", digest } }),
      candidate({ artifact: { packageId: "a", version: "1", digest: `sha256:${"b".repeat(64)}` } }),
    ];
    expect(
      validateEvidence(evidence({ ...ambiguous, candidates: digests })).candidates,
    ).toHaveLength(2);
    const bindings = [
      candidate({ version: { ...version, bindingId: "b1" } }),
      candidate({ version: { ...version, bindingId: "b2" } }),
    ];
    expect(
      validateEvidence(evidence({ ...ambiguous, candidates: bindings })).candidates,
    ).toHaveLength(2);
  });

  test("weights are finite shares from 0 to 1; times canonical", () => {
    invalid(
      () => validateEvidence(evidence({ candidates: [candidate({ commit: OID as never })] })),
      /bare SHA/,
    );
    invalid(
      () =>
        validateEvidence(
          evidence({
            candidates: [
              candidate({ times: [{ kind: "deployment", at: "2026-10-12T22:00:00+02:00" }] }),
            ],
          }),
        ),
      /deployment time/,
    );
    expect(
      validateEvidence(
        evidence({
          candidates: [candidate({ times: [{ kind: "deployment", at: "2026-10-12T20:00:00Z" }] })],
        }),
      ).candidates[0]!.times,
    ).toEqual([{ kind: "deployment", at: NOW }]);
    const weighted = evidence({
      attribution: "ambiguous",
      candidates: [candidate({ weight: 0.9 }), candidate({ commit: other, weight: 0.1 })],
    });
    expect(validateEvidence(weighted).candidates.map((c) => c.weight)).toEqual([0.9, 0.1]);
    for (const weight of [-0.1, 1.1, Number.NaN, Infinity, "0.5", null])
      invalid(
        () => validateEvidence(evidence({ candidates: [candidate({ weight: weight as never })] })),
        /evidence weight/,
      );
  });
});

describe("validateProviderDeployment", () => {
  const deployment = (overrides: Partial<ProviderDeployment> = {}): ProviderDeployment => ({
    version: { connectionId: "conn_1", bindingId: "bind_1", versionId: "v2", deploymentId: "d2" },
    deployedAt: "2026-10-12T18:00:00Z",
    exposedFrom: "2026-10-12T18:01:00Z",
    exposedUntil: "2026-10-12T19:00:00Z",
    percentage: 10,
    replaces: "v1",
    link: null,
    ...overrides,
  });

  test("canonical times; a rollback names what it replaced", () => {
    expect(validateProviderDeployment(deployment())).toEqual({
      ...deployment(),
      deployedAt: "2026-10-12T18:00:00.000Z",
      exposedFrom: "2026-10-12T18:01:00.000Z",
      exposedUntil: "2026-10-12T19:00:00.000Z",
    });
    const { replaces: _, ...plain } = deployment({ exposedUntil: null, percentage: null });
    expect(validateProviderDeployment(plain)).not.toHaveProperty("replaces");
    expect(validateProviderDeployment(deployment({ replaces: null })).replaces).toBeNull();
    expect(
      validateProviderDeployment(deployment({ exposedFrom: "2026-10-12T18:00:00Z" })).exposedFrom,
    ).toBe("2026-10-12T18:00:00.000Z");
  });

  test("missing optional fields read as null", () => {
    const loose = {
      ...deployment(),
      exposedFrom: undefined,
      exposedUntil: undefined,
      percentage: undefined,
      link: undefined,
    } as never;
    expect(validateProviderDeployment(loose)).toMatchObject({
      exposedFrom: null,
      exposedUntil: null,
      percentage: null,
      link: null,
    });
  });

  test.each([
    [{ exposedFrom: "2026-10-12T17:59:59Z" }, /before the deployment/],
    [{ exposedUntil: "2026-10-12T18:00:30Z" }, /start before it ends/],
    [{ exposedFrom: null }, /start before it ends/],
    [{ percentage: -1 }, /percentage/],
    [{ percentage: 100.5 }, /percentage/],
    [{ percentage: Number.NaN }, /percentage/],
    [{ percentage: Infinity }, /percentage/],
    [{ percentage: "50" as never }, /percentage/],
    [{ deployedAt: "2026-10-12T18:00:00+00:00" }, /deployedAt/],
    [{ replaces: "" }, /replaces/],
    [{ replaces: "v2" }, /can't replace itself/],
    [{ link: { url: "https://dash.cloudflare.com/abc/x", kind: "other" as never } }, /link kind/],
    [{ link: { url: 7 as never, kind: "detail" } }, /expected a URL/],
    [{ version: null as never }, /version: expected an object/],
  ] as [Partial<ProviderDeployment>, RegExp][])("refuses %j", (overrides, message) =>
    invalid(() => validateProviderDeployment(deployment(overrides)), message),
  );

  test("percentage bounds are inclusive", () => {
    expect(validateProviderDeployment(deployment({ percentage: 0 })).percentage).toBe(0);
    expect(validateProviderDeployment(deployment({ percentage: 100 })).percentage).toBe(100);
  });

  test("links are checked against the connection's prefixes when given", () => {
    const prefixes = ["https://dash.cloudflare.com/abc"];
    const good = { url: "HTTPS://dash.cloudflare.com/abc/workers", kind: "detail" as const };
    expect(validateProviderDeployment(deployment({ link: good }), prefixes).link).toEqual({
      url: "https://dash.cloudflare.com/abc/workers",
      kind: "detail",
    });
    invalid(
      () =>
        validateProviderDeployment(
          deployment({ link: { url: "javascript:alert(1)", kind: "detail" } }),
          prefixes,
        ),
      /https only/,
    );
    invalid(
      () =>
        validateProviderDeployment(
          deployment({ link: { url: "https://dash.cloudflare.com/other", kind: "landing" } }),
          prefixes,
        ),
      /declared prefix/,
    );
  });
});

describe("validateSeries", () => {
  // Six 10-minute buckets, 18:00–19:00.
  const start = "2026-10-12T18:00:00.000Z";
  const series = (overrides: Partial<Series> = {}): Series => ({
    metric: "worker.exceptions",
    bindingId: "bind_1",
    dataset: "workers",
    stability: "beta",
    buckets: { start, bucketMs: 10 * MINUTE, count: 6 },
    points: [0, 1, 2, 3, 4, 5],
    denominator: null,
    quantile: null,
    sampling: "exact",
    coverage: [{ start, end: "2026-10-12T19:00:00.000Z" }],
    expired: null,
    freshThrough: "2026-10-12T18:50:00.000Z",
    ...overrides,
  });

  test("accepts a consistent series", () => {
    expect(validateSeries(series())).toEqual(series());
  });

  test("returns canonical instants", () => {
    const loose = series({
      buckets: { start: "2026-10-12T18:00:00Z", bucketMs: 10 * MINUTE, count: 6 },
      coverage: [{ start: "2026-10-12T18:00:00Z", end: "2026-10-12T19:00:00Z" }],
      freshThrough: "2026-10-12T18:50:00Z",
      expired: null,
    });
    expect(validateSeries(loose)).toEqual(series());
  });

  test("one dense point per bucket", () => {
    invalid(() => validateSeries(series({ points: [0, 1, 2, 3, 4] })), /5 points for 6 buckets/);
    invalid(
      () => validateSeries(series({ points: [0, 1, 2, 3, 4, 5, 6] })),
      /7 points for 6 buckets/,
    );
    invalid(() => validateSeries(series({ points: withHole([0, 1, 2, 3, 4, 5], 2) })), /hole at 2/);
    invalid(() => validateSeries(series({ points: Array(6) })), /hole at 0/);
  });

  test("buckets are aligned and bounded", () => {
    invalid(
      () =>
        validateSeries(
          series({ buckets: { start: "2026-10-12T18:05:00Z", bucketMs: 10 * MINUTE, count: 6 } }),
        ),
      /align/,
    );
    const many = OBSERVABILITY_MAX_BUCKETS + 1;
    invalid(
      () =>
        validateSeries(
          series({
            buckets: { start, bucketMs: MINUTE, count: many },
            points: Array(many).fill(null),
            coverage: [],
          }),
        ),
      /more than/,
    );
    invalid(() => validateSeries(series({ metric: "made.up" as never })), /unknown metric/);
  });

  test("sampling, stability, ids and freshness are known and well formed", () => {
    invalid(
      () => validateSeries(series({ sampling: "Exact" as never, points: [0, 1.5, 2, 3, 4, 5] })),
      /sampling/,
    );
    invalid(() => validateSeries(series({ stability: "alpha" as never })), /stability/);
    invalid(() => validateSeries(series({ dataset: "" })), /dataset/);
    invalid(() => validateSeries(series({ bindingId: "" })), /bindingId/);
    invalid(() => validateSeries(series({ freshThrough: "yesterday" })), /freshThrough/);
    expect(validateSeries(series({ freshThrough: null })).freshThrough).toBeNull();
  });

  test("freshThrough is at most an hour past now", () => {
    expect(validateSeries(series({ freshThrough: "2026-10-12T21:00:00Z" })).freshThrough).toBe(
      "2026-10-12T21:00:00.000Z",
    );
    invalid(
      () => validateSeries(series({ freshThrough: "2026-10-12T21:00:00.001Z" })),
      /freshThrough is in the future/,
    );
    invalid(() => validateSeries(series({ freshThrough: "2099-01-01T00:00:00Z" })), /future/);
  });

  test("malformed shapes are refused, not crashed on", () => {
    invalid(() => validateSeries(series({ coverage: null as never })), /coverage: expected a list/);
    invalid(
      () => validateSeries(series({ buckets: null as never })),
      /buckets: expected an object/,
    );
    invalid(() => validateSeries(series({ points: null as never })), /points: expected a list/);
    invalid(
      () =>
        validateSeries(
          series({
            metric: "http.edge_5xx_rate",
            points: Array(6).fill(null),
            denominator: {} as never,
          }),
        ),
      /denominators: expected a list/,
    );
    invalid(() => validateSeries(null as never), /series: expected an object/);
  });

  test("exact denominators are whole; estimated ones needn't be", () => {
    const rate = {
      metric: "http.edge_5xx_rate" as const,
      points: [0.4, null, null, null, null, null],
    };
    const coverage = [{ start, end: "2026-10-12T18:10:00.000Z" }];
    invalid(
      () =>
        validateSeries(
          series({ ...rate, coverage, sampling: "exact", denominator: [2.5, 0, 0, 0, 0, 0] }),
        ),
      /exact denominators 0 must be a whole number/,
    );
    expect(
      validateSeries(
        series({ ...rate, coverage, sampling: "estimated", denominator: [2.5, 0, 0, 0, 0, 0] }),
      ).points[0],
    ).toBe(0.4);
  });

  test("a zero needs full coverage; partial coverage still allows a count", () => {
    const partial = [{ start: "2026-10-12T18:05:00.000Z", end: "2026-10-12T19:00:00.000Z" }];
    invalid(
      () => validateSeries(series({ coverage: partial })),
      /point 0 is zero without full coverage/,
    );
    expect(
      validateSeries(series({ coverage: partial, points: [1, 1, 2, 3, 4, 5] })).points[0],
    ).toBe(1);
    expect(
      validateSeries(series({ coverage: partial, points: [null, 0, 2, 3, 4, 5] })).points[1],
    ).toBe(0);
  });

  test("touching coverage parts merge, so a zero across the seam is fully covered", () => {
    const seam = "2026-10-12T18:05:00.000Z";
    const parts = [
      { start, end: seam },
      { start: seam, end: "2026-10-12T19:00:00.000Z" },
    ];
    const checked = validateSeries(series({ coverage: parts }));
    expect(checked.points[0]).toBe(0);
    expect(checked.coverage).toEqual([{ start, end: "2026-10-12T19:00:00.000Z" }]);
    invalid(
      () =>
        validateSeries(
          series({
            coverage: [
              { start, end: seam },
              { start: "2026-10-12T18:05:00.001Z", end: "2026-10-12T19:00:00.000Z" },
            ],
          }),
        ),
      /point 0 is zero without full coverage/,
    );
  });

  test("an uncovered bucket has no value", () => {
    const first = [{ start, end: "2026-10-12T18:30:00.000Z" }];
    invalid(() => validateSeries(series({ coverage: first })), /point 3 is outside coverage/);
    expect(
      validateSeries(series({ coverage: first, points: [0, 1, 2, null, null, null] })).coverage,
    ).toEqual(first);
    invalid(() => validateSeries(series({ coverage: [] })), /point 0 is outside coverage/);
    expect(
      validateSeries(series({ coverage: [], points: Array(6).fill(null), sampling: "unknown" }))
        .points,
    ).toEqual(Array(6).fill(null));
  });

  test("coverage is sorted, disjoint and inside the buckets", () => {
    const a = { start, end: "2026-10-12T18:30:00.000Z" };
    const b = { start: "2026-10-12T18:30:00.000Z", end: "2026-10-12T19:00:00.000Z" };
    const c = { start: "2026-10-12T18:40:00.000Z", end: "2026-10-12T19:00:00.000Z" };
    expect(
      validateSeries(series({ coverage: [a, c], points: [0, 1, 2, null, 4, 5] })).coverage,
    ).toEqual([a, c]);
    invalid(() => validateSeries(series({ coverage: [b, a] })), /sorted, disjoint/);
    invalid(
      () => validateSeries(series({ coverage: [a, { ...b, start: "2026-10-12T18:20:00.000Z" }] })),
      /sorted, disjoint/,
    );
    invalid(
      () => validateSeries(series({ coverage: [{ ...b, end: "2026-10-12T19:00:00.001Z" }] })),
      /inside the buckets/,
    );
    invalid(
      () =>
        validateSeries(series({ coverage: [{ start: "2026-10-12T17:59:00.000Z", end: b.end }] })),
      /inside/,
    );
    invalid(
      () => validateSeries(series({ coverage: [{ start: b.end, end: b.end }] })),
      /start must be before end/,
    );
  });

  test("expired buckets have no value and are never covered", () => {
    const expired = { start, end: "2026-10-12T18:20:00.000Z" };
    const live = [{ start: "2026-10-12T18:20:00.000Z", end: "2026-10-12T19:00:00.000Z" }];
    expect(
      validateSeries(series({ expired, coverage: live, points: [null, null, 2, 3, 4, 5] })).expired,
    ).toEqual(expired);
    invalid(
      () => validateSeries(series({ expired, coverage: live, points: [0, null, 2, 3, 4, 5] })),
      /point 0 is past retention/,
    );
    invalid(
      () => validateSeries(series({ expired, points: [null, null, 2, 3, 4, 5] })),
      /can't be covered/,
    );
    invalid(
      () =>
        validateSeries(
          series({
            expired: { start: "2026-10-12T18:10:00.000Z", end: "2026-10-12T18:20:00.000Z" },
            coverage: live,
          }),
        ),
      /start with the buckets/,
    );
  });

  test("exact counts are whole; values are finite and non-negative", () => {
    invalid(
      () => validateSeries(series({ points: [0, 1.5, 2, 3, 4, 5] })),
      /exact points 1 must be a whole number/,
    );
    expect(
      validateSeries(series({ sampling: "estimated", points: [0, 1.5, 2, 3, 4, 5] })).points[1],
    ).toBe(1.5);
    invalid(() => validateSeries(series({ points: [0, -1, 2, 3, 4, 5] })), /non-negative/);
    invalid(
      () => validateSeries(series({ sampling: "estimated", points: [0, Infinity, 2, 3, 4, 5] })),
      /finite/,
    );
  });

  test("a rate without its denominator has no value; rates are 0–1", () => {
    const rate = { metric: "http.origin_5xx_rate" as const, sampling: "estimated" as const };
    invalid(
      () => validateSeries(series({ ...rate, points: [0, 0.1, 0, 0, 0, 0] })),
      /rate 0 has no denominator/,
    );
    expect(validateSeries(series({ ...rate, points: Array(6).fill(null) })).points).toEqual(
      Array(6).fill(null),
    );
    const denominator = [10, 10, 0, null, 10, 10];
    expect(
      validateSeries(series({ ...rate, denominator, points: [0, 0.1, null, null, 0.5, 1] }))
        .denominator,
    ).toEqual(denominator);
    invalid(
      () => validateSeries(series({ ...rate, denominator, points: [0, 0.1, 0, null, 0.5, 1] })),
      /rate 2/,
    );
    invalid(
      () => validateSeries(series({ ...rate, denominator, points: [0, 0.1, null, 0, 0.5, 1] })),
      /rate 3/,
    );
    invalid(
      () => validateSeries(series({ ...rate, denominator, points: [0, 5, null, null, 0.5, 1] })),
      /rate 1 is more than 1/,
    );
    invalid(
      () => validateSeries(series({ ...rate, denominator: [10], points: Array(6).fill(null) })),
      /1 denominators for 6 buckets/,
    );
    invalid(() => validateSeries(series({ denominator })), /only a rate has a denominator/);
  });

  test("denominators are dense, finite and non-negative even where the rate is null", () => {
    const rate = {
      metric: "http.edge_5xx_rate" as const,
      sampling: "estimated" as const,
      points: [0, null, null, null, 0, 0],
    };
    for (const bad of [-3, Infinity, Number.NaN])
      invalid(
        () => validateSeries(series({ ...rate, denominator: [10, bad, 10, 10, 10, 10] })),
        /denominators 1 must be a finite, non-negative number/,
      );
    invalid(
      () => validateSeries(series({ ...rate, denominator: withHole([10, 10, 10, 10, 10, 10], 1) })),
      /denominators has a hole at 1/,
    );
  });

  test("a distribution names its quantile", () => {
    const latency = {
      metric: "latency.cpu" as const,
      sampling: "estimated" as const,
      points: [1, 2, 3, 4, 5, 6],
    };
    expect(validateSeries(series({ ...latency, quantile: 0.95 })).quantile).toBe(0.95);
    invalid(() => validateSeries(series({ ...latency, quantile: null })), /needs a quantile/);
    invalid(() => validateSeries(series({ ...latency, quantile: 0 })), /needs a quantile/);
    invalid(() => validateSeries(series({ ...latency, quantile: 1.5 })), /needs a quantile/);
    invalid(() => validateSeries(series({ quantile: 0.5 })), /only a distribution/);
  });
});

describe("ratePoints", () => {
  test("a value only where both counts are known and the denominator is positive", () => {
    expect(ratePoints([1, 0, 3, null, 2], [10, 10, 0, 5, null])).toEqual([
      0.1,
      0,
      null,
      null,
      null,
    ]);
  });

  test("no denominator series: no rate, never zero", () => {
    expect(ratePoints([0, 1, 2], null)).toEqual([null, null, null]);
  });

  test("lengths must match", () => {
    invalid(() => ratePoints([1, 2], [1]), /differ in length/);
  });
});

describe("cursorRequestDigest", () => {
  const interval = { start: "2026-10-12T18:00:00.000Z", end: "2026-10-12T19:00:00.000Z" };
  const request = {
    repoId: "repo_1",
    connectionId: "conn_1",
    bindingId: "bind_1",
    dataset: "workers",
    interval,
    fingerprint: "fp_1",
    limit: 20,
  };

  test("canonical: key order, instant spelling and scope don't matter", () => {
    const digest = cursorRequestDigest("occurrences", request);
    expect(digest).toBe(
      JSON.stringify([
        "occurrences",
        { dataset: "workers", fingerprint: "fp_1", interval, limit: 20 },
      ]),
    );
    const reordered = {
      limit: 20,
      fingerprint: "fp_1",
      interval: { end: "2026-10-12T19:00:00Z", start: "2026-10-12T18:00:00Z" },
      dataset: "workers",
      cursor: "abc",
      bindingId: "other",
    };
    expect(cursorRequestDigest("occurrences", reordered)).toBe(digest);
    expect(cursorRequestDigest("occurrences", { ...request, versionId: undefined })).toBe(digest);
  });

  test("any difference in what is asked changes it", () => {
    const digest = cursorRequestDigest("occurrences", request);
    for (const changed of [
      { ...request, fingerprint: "fp_2" },
      { ...request, versionId: "v1" },
      { ...request, limit: 21 },
      { ...request, dataset: "traces" },
      { ...request, interval: { ...interval, end: "2026-10-12T19:00:00.001Z" } },
    ])
      expect(cursorRequestDigest("occurrences", changed)).not.toBe(digest);
    expect(cursorRequestDigest("traces", request)).not.toBe(digest);
  });

  test("the default page limit is applied", () => {
    const { limit: _, ...unlimited } = request;
    expect(cursorRequestDigest("occurrences", unlimited)).toBe(
      cursorRequestDigest("occurrences", { ...request, limit: OBSERVABILITY_PAGE_DEFAULT }),
    );
  });

  test("series carry their own filters and no limit", () => {
    const series = { dataset: "workers", interval, metric: "http.requests", bucketMs: 600_000 };
    expect(cursorRequestDigest("series", series)).toContain('"metric":"http.requests"');
    expect(cursorRequestDigest("series", { ...series, quantile: 0.95 })).not.toBe(
      cursorRequestDigest("series", series),
    );
    invalid(() => cursorRequestDigest("series", { ...series, limit: 10 }), /no limit/);
  });

  test("refuses unknown fields, bad values and missing essentials", () => {
    invalid(
      () => cursorRequestDigest("occurrences", { ...request, sql: "SELECT 1" }),
      /unknown field "sql"/,
    );
    invalid(() => cursorRequestDigest("logs" as never, request), /read kind/);
    invalid(() => cursorRequestDigest("occurrences", { ...request, limit: 500 }), /limit/);
    invalid(() => cursorRequestDigest("occurrences", { ...request, metric: "made.up" }), /metric/);
    const { dataset: _, ...noDataset } = request;
    invalid(() => cursorRequestDigest("occurrences", noDataset), /dataset and an interval/);
  });
});

describe("checkCursorBinding", () => {
  const issuedAt = "2026-10-12T19:30:00.000Z";
  const expected: Omit<CursorBinding, "issuedAt"> = {
    principalId: "acc_1",
    authorizationVersion: "7",
    repoId: "repo_1",
    connectionId: "conn_1",
    bindingId: "bind_1",
    request: cursorRequestDigest("error-groups", {
      dataset: "workers",
      interval: { start: "2026-10-12T18:00:00Z", end: "2026-10-12T19:00:00Z" },
    }),
  };
  const binding: CursorBinding = { ...expected, issuedAt };

  test("a matching, fresh binding continues", () => {
    expect(checkCursorBinding(expected, { ...binding }, NOW)).toBeNull();
  });

  test.each([
    ["principalId", "acc_2"],
    ["authorizationVersion", "8"],
    ["repoId", "repo_2"],
    ["connectionId", "conn_2"],
    ["bindingId", "bind_2"],
    ["request", "other"],
  ] as const)("a different %s fails closed", (field, value) => {
    expect(checkCursorBinding(expected, { ...binding, [field]: value }, NOW)).toBe(
      "cursor_invalid",
    );
  });

  test("older than the maximum age is expired", () => {
    const at = (ms: number) => ({
      ...binding,
      issuedAt: new Date(Date.parse(NOW) - ms).toISOString(),
    });
    expect(checkCursorBinding(expected, at(OBSERVABILITY_CURSOR_MAX_AGE_MS), NOW)).toBeNull();
    expect(checkCursorBinding(expected, at(OBSERVABILITY_CURSOR_MAX_AGE_MS + 1), NOW)).toBe(
      "cursor_expired",
    );
    expect(OBSERVABILITY_CURSOR_MAX_AGE_MS).toBe(HOUR);
  });

  test("a mismatch wins over age; a future or malformed issuedAt is invalid", () => {
    expect(
      checkCursorBinding(
        expected,
        { ...binding, repoId: "repo_2", issuedAt: "2026-10-11T00:00:00Z" },
        NOW,
      ),
    ).toBe("cursor_invalid");
    expect(
      checkCursorBinding(expected, { ...binding, issuedAt: "2026-10-12T20:01:00.000Z" }, NOW),
    ).toBeNull();
    expect(
      checkCursorBinding(expected, { ...binding, issuedAt: "2026-10-12T20:01:00.001Z" }, NOW),
    ).toBe("cursor_invalid");
    for (const bad of ["yesterday", 0, null])
      expect(checkCursorBinding(expected, { ...binding, issuedAt: bad }, NOW)).toBe(
        "cursor_invalid",
      );
  });

  test("malformed, padded or inherited bindings fail closed", () => {
    const { request: _, ...missing } = binding;
    for (const actual of [null, undefined, "cursor", 7, [], missing, { ...binding, extra: "x" }])
      expect(checkCursorBinding(expected, actual, NOW)).toBe("cursor_invalid");
    expect(checkCursorBinding(expected, { ...binding, authorizationVersion: 7 }, NOW)).toBe(
      "cursor_invalid",
    );
    const inherited = Object.assign(Object.create(binding), {
      a: 1,
      b: 2,
      c: 3,
      d: 4,
      e: 5,
      f: 6,
      g: 7,
    });
    expect(checkCursorBinding(expected, inherited, NOW)).toBe("cursor_invalid");
    const proto = JSON.parse(
      '{"__proto__":{"principalId":"acc_1"},"a":1,"b":2,"c":3,"d":4,"e":5,"f":6}',
    ) as unknown;
    expect(checkCursorBinding(expected, proto, NOW)).toBe("cursor_invalid");
  });

  test("the expected binding must be complete", () => {
    invalid(
      () => checkCursorBinding({ ...expected, principalId: "" }, binding, NOW),
      /principalId/,
    );
    invalid(() => checkCursorBinding({ ...expected, request: "" }, binding, NOW), /request/);
  });
});

describe("observationBindingCheck", () => {
  const binding: ServiceBinding = {
    id: "bind_1",
    connectionId: "conn_1",
    repoId: "repo_1",
    service: "api",
    environment: "production",
  };
  const ref = {
    bindingId: "bind_1",
    connectionId: "conn_1",
    repoId: "repo_1",
    service: "api",
    environment: "production",
  };

  test("an unchanged binding re-reads; a deleted one is not configured", () => {
    expect(observationBindingCheck(ref, binding)).toBeNull();
    expect(observationBindingCheck(ref, null)).toBe("not_configured");
  });

  test.each([
    ["repoId", "repo_2"],
    ["service", "api-v2"],
    ["environment", "staging"],
    ["connectionId", "conn_2"],
  ] as const)("a binding whose %s changed is binding_changed", (field, value) => {
    expect(observationBindingCheck(ref, { ...binding, [field]: value })).toBe("binding_changed");
  });

  test("only compares a binding with its own reference", () => {
    invalid(() => observationBindingCheck(ref, { ...binding, id: "bind_2" }), /its own binding/);
  });
});

describe("validateLinkPrefixes", () => {
  test("accepts normalized https URLs to an account path", () => {
    const prefixes = ["https://dash.cloudflare.com/abc", "https://dash.cloudflare.com/abc/"];
    expect(validateLinkPrefixes(prefixes)).toEqual(prefixes);
    expect(validateLinkPrefixes([])).toEqual([]);
  });

  test.each([
    "https://dash.cloudflare.com",
    "https://dash.cloudflare.com/",
    "https:",
    "https:/",
    "https://",
    "http://dash.cloudflare.com/abc",
    "https://Dash.cloudflare.com/abc",
    "https://dash.cloudflare.com:443/abc",
    "https://user@dash.cloudflare.com/abc",
    "https://@dash.cloudflare.com/abc",
    "https://dash.cloudflare.com/abc?x=1",
    "https://dash.cloudflare.com/abc#x",
    "https://dash.cloudflare.com/abc/..",
    "https://dash.cloudflare.com/abc/./",
    "https://dash.cloudflare.com/abc/../other",
    "https://dash.cloudflare.com/abc%2Fx",
    "https://dash.cloudflare.com/abc%5cx",
    "https://bücher.example/abc",
    "https://dash.cloudflare.com/ab c",
    "dash.cloudflare.com/abc",
    "",
  ])("refuses %j", (prefix) =>
    invalid(() => validateLinkPrefixes([prefix]), /Invalid link prefix/),
  );

  test("refuses non-strings and non-lists", () => {
    invalid(() => validateLinkPrefixes([7 as never]), /Invalid link prefix/);
    invalid(
      () => validateLinkPrefixes("https://dash.cloudflare.com/abc" as never),
      /expected a list/,
    );
  });
});

describe("safeProviderLink", () => {
  const prefixes = ["https://dash.cloudflare.com/abc"];

  test("accepts an https URL under a declared prefix", () => {
    expect(safeProviderLink("https://dash.cloudflare.com/abc/workers/view/api", prefixes)).toBe(
      "https://dash.cloudflare.com/abc/workers/view/api",
    );
    expect(safeProviderLink("https://dash.cloudflare.com/abc", prefixes)).toBe(
      "https://dash.cloudflare.com/abc",
    );
    expect(safeProviderLink("https://dash.cloudflare.com/abc?x=1#y", prefixes)).toBe(
      "https://dash.cloudflare.com/abc?x=1#y",
    );
    expect(safeProviderLink("HTTPS://DASH.CLOUDFLARE.COM/abc/x", prefixes)).toBe(
      "https://dash.cloudflare.com/abc/x",
    );
    expect(safeProviderLink("https://dash.cloudflare.com:443/abc/x", prefixes)).toBe(
      "https://dash.cloudflare.com/abc/x",
    );
    expect(safeProviderLink("https://dash.cloudflare.com/abc/./x", prefixes)).toBe(
      "https://dash.cloudflare.com/abc/x",
    );
    expect(
      safeProviderLink("https://dash.cloudflare.com/abc/x", ["https://dash.cloudflare.com/abc/"]),
    ).toBe("https://dash.cloudflare.com/abc/x");
  });

  test("a trailing-slash prefix doesn't match the bare path", () => {
    invalid(
      () =>
        safeProviderLink("https://dash.cloudflare.com/abc", ["https://dash.cloudflare.com/abc/"]),
      /declared prefix/,
    );
  });

  test.each([
    ["http://dash.cloudflare.com/abc/x", /https only/],
    ["javascript:alert(1)", /https only/],
    ["https://user:pass@dash.cloudflare.com/abc/x", /credentials/],
    ["https://token@dash.cloudflare.com/abc/x", /credentials/],
    ["https://%75ser@dash.cloudflare.com/abc/x", /credentials/],
    ["https://:@dash.cloudflare.com/abc/x", /credentials/],
    ["https://@dash.cloudflare.com/abc/x", /credentials/],
    ["https://dash.cloud\nflare.com/abc/x", /whitespace or control/],
    [" https://dash.cloudflare.com/abc/x", /whitespace or control/],
    ["https://dash.cloudflare.com/abc/x\t", /whitespace or control/],
    ["https://dash.cloudflare.com/abc/..%2Fother", /encoded/],
    ["https://dash.cloudflare.com/abc/%2F%2Fevil.example", /encoded/],
    ["https://dash.cloudflare.com/abc%2F..%2Fother", /encoded/],
    ["https://dash.cloudflare.com/abc/x%5c..%5cother", /encoded/],
    ["https://dash.cloudflare.com/abc/../other", /declared prefix/],
    ["https://dash.cloudflare.com/abc/%2e%2e/other", /declared prefix/],
    ["https://dash.cloudflare.com/abc/.%2E/other", /declared prefix/],
    ["https://dash.cloudflare.com/abc\\..\\other", /declared prefix/],
    ["https://dash.cloudflare.com/abc;x", /declared prefix/],
    ["https://dash.cloudflare.com/%61bc/x", /declared prefix/],
    ["https://dash.cloudflare.com/abcdef", /declared prefix/],
    ["https://dash.cloudflare.com/other/abc", /declared prefix/],
    ["https://dash.cloudflare.com./abc/x", /declared prefix/],
    ["https://dash.cloudflare.com.evil.example/abc", /declared prefix/],
    ["https://evil.example/https://dash.cloudflare.com/abc", /declared prefix/],
    ["https://dash.cloudflare.com:8443/abc/x", /declared prefix/],
    ["/relative/path", /not an absolute URL/],
  ])("refuses %j", (url, message) => invalid(() => safeProviderLink(url, prefixes), message));

  test("backslash authority tricks are refused", () => {
    invalid(
      () => safeProviderLink("https:\\\\user@dash.cloudflare.com\\abc", prefixes),
      /credentials/,
    );
    expect(safeProviderLink("https:\\\\dash.cloudflare.com\\abc\\x", prefixes)).toBe(
      "https://dash.cloudflare.com/abc/x",
    );
  });

  test("declared prefixes are validated: a bare origin or a malformed one is refused", () => {
    const url = "https://dash.cloudflare.com/abc/x";
    for (const prefix of [
      "https://dash.cloudflare.com",
      "https://dash.cloudflare.com/",
      "https://Dash.cloudflare.com/abc",
      "https://dash.cloudflare.com/abc?x=1",
      "https:",
    ])
      invalid(() => safeProviderLink(url, [prefix]), /Invalid link prefix/);
    invalid(() => safeProviderLink(url, []), /declared prefix/);
  });

  test("hosts are compared as lowercase punycode", () => {
    const url = "https://bücher.example/abc/x";
    expect(safeProviderLink(url, ["https://xn--bcher-kva.example/abc"])).toBe(
      "https://xn--bcher-kva.example/abc/x",
    );
    invalid(() => safeProviderLink(url, ["https://bücher.example/abc"]), /Invalid link prefix/);
  });
});
