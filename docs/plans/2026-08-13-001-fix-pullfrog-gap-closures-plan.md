---
title: "fix: Close Pullfrog-identified gaps in review robustness, quality, and approval correctness"
type: fix
status: active
date: 2026-08-13
origin: "Architecture comparison against pullfrog/pullfrog (open-source). Findings persisted to Engram topic donmerge-pullfrog-comparison (obs #7094)."
---

# Close Pullfrog-Identified Gaps in DonMerge Review Pipeline

## Overview

DonMerge's code-review pipeline (`CodeReviewWorkflow` → `publishReview`) trusts LLM output and GitHub's responses more than it should. A deep comparison against the open-source `pullfrog/pullfrog` project surfaced eight concrete gaps where Pullfrog is mechanically more robust. This plan closes seven of them inside DonMerge's existing architecture (hosted Cloudflare Worker + structured-JSON LLM contract). The eighth — agent-driven specialist subagent fanout — is an architectural migration and is explicitly deferred.

The work is grouped into four phases: foundation (shared patch cache), publish-time robustness (anchor validation, transient retry, dropped-comment reporting), output-quality guards (degenerate body, empty-submission skip), and correct approval semantics (outstanding-threads gate, reviewed-SHA metadata).

---

## Problem Frame

DonMerge publishes one PR review per workflow run via `POST /repos/{o}/{r}/pulls/{n}/reviews`. Today:

- A single inline comment anchored to a line outside a diff hunk makes GitHub return **422 and sinks the entire review** — the structured summary, the other valid comments, everything. There is no pre-validation.
- The LLM occasionally emits a degenerate `summary` (placeholder-like, or empty). It is published verbatim to a customer PR with no guardrail.
- A run with zero findings still POSTs an empty `COMMENT`/`APPROVE` review. GitHub accepts empty `APPROVE` but an empty `COMMENT` 422s.
- GitHub's transient "internal error" 422 on the reviews endpoint is treated identically to a validation 422, so a flaky GitHub moment fails the whole review instead of retrying.
- DonMerge can set `approved=true` on a PR that still has **unresolved DonMerge-originated review threads** from a prior run, as long as the current diff is clean. This is an approval-correctness bug.
- The reviewed `head_sha` and base ref are not surfaced in the posted review body, so a reader cannot tell whether findings are stale after a push.
- `listFiles` and review-thread fetches happen in separate workflow steps without sharing state, costing redundant API calls within one run.

Pullfrog solves each of these mechanically. DonMerge can adopt the same defenses without changing its core architecture (the structured-JSON contract stays; the agent-driven MCP model does not).

---

## Requirements Trace

- R1. A review must never fail end-to-end because a single inline comment targets a line outside a diff hunk.
- R2. Invalid-anchor comments must be dropped before the POST, and the drop must be visible to the author and to DonMerge operators.
- R3. A degenerate or placeholder `summary` must not be published verbatim; a safe fallback must be used instead.
- R4. A run with no findings must not POST an empty `COMMENT` review that GitHub 422s; it should still complete the check run.
- R5. GitHub's transient 422 "internal error" on the reviews endpoint must be retried with bounded backoff and must not be confused with a validation 422.
- R6. DonMerge must not set `approved=true` while any unresolved review thread it originated remains open on the PR (outdated threads count as unresolved).
- R7. The posted review body must carry a metadata marker pinning the reviewed `head_sha` and base ref so staleness is visible.
- R8. PR file patches and review threads fetched in earlier workflow steps must be reused by later steps within the same run instead of re-fetched.

**Origin acceptance examples (carried from the comparison analysis):**
- AE1 (covers R1, R2): A PR diff where one LLM comment targets a context-only line → that comment is dropped, the rest of the review posts, and the check-run summary lists the dropped comment.
- AE2 (covers R6): A PR with one open DonMerge thread from a prior run and a clean new diff → the new review is published as `COMMENT`/`REQUEST_CHANGES` (not `APPROVE`) until the prior thread is resolved.

---

## Scope Boundaries

- This plan touches only the code-review publish path (`CodeReviewWorkflow` step 4 and its collaborators in `src/workflows/code-review/github-api.ts`). The triage workflow, webhook parsing, sandbox/Flue runtime, and multi-model fallback are out of scope.
- The structured-JSON LLM contract (`REVIEW_OUTPUT_SCHEMA`) is **not** changed. All guards operate on the already-parsed `ReviewResult`, not on raw LLM output.
- Multi-tenant config, D1 schema, and the fingerprint/identity dedup system are untouched. These gaps are orthogonal to dedup.

### Deferred to Follow-Up Work

- **Agent-driven specialist subagent fanout (Pullfrog's `reviewfrog` model):** adopting MCP tools + parallel read-only specialists is a migration toward Pullfrog's architecture, not a gap closure. It conflicts with DonMerge's structured-JSON contract and would require rethinking the sandbox/Flue integration. Tracked separately if pursued.
- **`approveAfterFix` proactive approval:** automatically posting an APPROVE after a fix run resolves all threads. Depends on a fix-run flow DonMerge does not yet have end-to-end; revisit when that flow lands.

---

## Context & Research

### Relevant Code and Patterns

- `src/workflows/code-review/code-review-workflow.ts` — the 4-step `CodeReviewWorkflow`; step 4 `publishReview()` (around line 650) is where every gap manifests. Intermediate data between steps is carried in serializable objects (`LlmReviewResult`, `preparedFiles`).
- `src/workflows/code-review/github-api.ts` — `publishReview()` builds the payload and POSTs; `fetchPreviousDonMergeComments()` fetches all review comments and filters by `donmerge`/`DonMerge` author login; `completeCheckRun()` builds the check-run summary; `attachCommentMeta()` / `parseCommentMeta()` show the existing HTML-marker pattern to extend for R7.
- `src/workflows/code-review/fingerprint.ts` — `MARKER_PREFIX` / `attachFingerprint()` pattern; R7's metadata marker should mirror this style.
- `src/workflows/code-review/types.ts` — `ReviewResult` (`approved`, `summary`, `lineComments`, `criticalIssues`, `suggestions`, `prSummary`); `ReviewComment` carries `path`, `line`, `side`, `severity`.
- `src/workflows/code-review/issue-store.ts` / `issue-matcher.ts` — existing dedup state; the outstanding-threads gate (R6) reuses `fetchPreviousDonMergeComments` output, not the DO store.
- Existing tests live under `src/workflows/code-review/__tests__/` and use vitest; pure-function helpers (e.g. `issue-identity`, `fingerprint`) are tested in isolation, which is the pattern to follow for the new pure helpers.

### Institutional Learnings

- (Engram `donmerge-pullfrog-comparison`) Pullfrog's three dedup mechanisms (session-level SHA-keyed dedup, outstanding-thread approval gate, agent-driven IncrementalReview) are complementary; DonMerge already has fingerprint dedup, so only the outstanding-thread approval gate transfers cleanly.
- (Engram `Add safety timeouts to Flue LLM queries`) A `withTimeout` wrapper pattern already exists for LLM calls; the transient-422 retry wrapper (R5) should follow the same defensive style.
- (Engram `Corrige re-reviews con payload fresco por comentario`) Workflow instance IDs are deterministic per comment; the publish step runs once per instance, so retry wrappers must be idempotent-safe (re-POSTing a review creates a second review — see Risks).

### External References

- Pullfrog source (cloned locally at `/tmp/pi-github-repos/pullfrog/pullfrog`): `mcp/review.ts` (`validateInlineComments`, `isTransientReviewError`, `isDegenerateReviewBody`, `reviewSkipDecision`, `duplicateReviewDecision`), `mcp/reviewComments.ts` (`countOutstandingPullfrogThreads` via GraphQL `reviewThreads` walk). These are reference implementations to adapt, not copy — DonMerge uses REST + raw `fetch`, not Octokit.

---

## Key Technical Decisions

- **Adapt, don't port.** Pullfrog's reference code uses Octokit + GraphQL + `arktype`. DonMerge uses raw `fetch` + REST + Zod-style schemas. Rewrite the logic in DonMerge's idiom; do not introduce Octokit/GraphQL/arktype dependencies.
- **Anchor validation is pure and lives in a new module.** `comment-anchors.ts` exports `commentableLinesForFile(patch)` and `validateInlineComments(comments, map)` as pure functions (mirroring `issue-identity.ts` structure), so they are trivially testable from fixtures.
- **Transient-422 detection is a predicate, not a status-code check alone.** Match Pullfrog's `isTransientReviewError`: HTTP 422 **and** body matches `/internal error occurred, please try again/i`. Everything else 422 is a real validation failure and must surface, not retry.
- **The approval gate overrides, not blocks.** When `approved === true` and outstanding DonMerge threads exist, set `approved = false` and downgrade the review event to `COMMENT` (do not throw). A thrown error would fail the run and lose all the valid new findings; a downgrade still publishes the review and the check-run, just non-approving. (This differs from Pullfrog, which throws — Pullfrog's agent can recover by resolving threads; DonMerge's workflow cannot.)
- **Reviewed-SHA metadata extends the existing per-comment marker style**, but lives once in the review body (not per comment), because the SHA is review-scoped.
- **Patch cache threads through workflow intermediate state**, not a new DO or KV. The `prepare-files` step already fetches `listFiles`; carry the patches forward in `PreparedFiles` instead of re-fetching.

---

## Open Questions

### Resolved During Planning

- *Where does anchor validation run?* Inside `publishReview()` in `github-api.ts`, after building `uniqueLineComments` and before constructing the POST payload. This keeps it next to the code that consumes the result.
- *What does the degenerate-body guard do on hit?* Replace the summary with a safe fallback (`"🤠 DonMerge completed the review but produced limited output. See check-run details."`) and log a warning. Do not throw — the review still posts with any valid inline comments.
- *Does the empty-submission skip apply to APPROVE?* No. An empty APPROVE is legitimate (GitHub accepts it and it signals "no issues"). The skip applies only when the event would be `COMMENT` with no body and no comments (which 422s).

### Deferred to Implementation

- Exact backoff schedule for the transient-422 retry (Pullfrog uses `[1000, 3000]` ms; confirm against Cloudflare Workflow step CPU/limit budgets).
- Whether `countOutstandingDonmergeThreads` should walk via REST pagination (simpler, matches existing `fetchPreviousDonMergeComments`) or a single GraphQL query (fewer calls). REST pagination reuses existing infra and the existing author-login filter; GraphQL is more efficient on large PRs. Decide during implementation against a representative large PR.
- Whether dropped-comment reporting should also write to the D1 memory system (for operator dashboards) or only the check-run summary. Start with check-run summary only; add D1 if operators ask.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

The publish step today is a linear sequence: match issues → filter comments → POST review → complete check run. The gaps insert guards at three points in that sequence:

```
                        ┌─ R8: patches threaded from step 2 (no re-fetch) ─┐
                        ▼                                                   │
step 4 publishReview:                                                         │
  match issues (existing)                                                     │
  filter comments (existing)                                                  │
  ──► [R5] wrap POST in retry-with-bail (transient 422 only)                 │
  ──► [R1/R2] validateInlineComments(comments, patchMap) ──► drop invalid     │
  ──► [R3] isDegenerateReviewBody(summary) ──► replace with fallback          │
  ──► [R4] reviewSkipDecision(...) ──► skip POST if empty COMMENT             │
  ──► [R6] if approved: countOutstandingDonmergeThreads ──► downgrade         │
  ──► [R7] attach reviewed-sha metadata to body                               │
  POST review (or skip)                                                       │
  complete check run (with dropped-comments note if any)                      │
```

Each guard is a pure predicate + a small mutation at the call site. None changes the `ReviewResult` shape or the LLM contract. The only new external dependency is the patch map (R8), which is data already fetched earlier in the same run.

---

## Implementation Units

- [ ] U1. **Thread PR file patches through workflow steps (patch cache)**

**Goal:** Eliminate redundant `listFiles` fetches within a single review run by carrying the file patches from the `prepare-files` step into the `publish-review` step.

**Requirements:** R8

**Dependencies:** None (foundational for U2)

**Files:**
- Modify: `src/workflows/code-review/code-review-workflow.ts` (step 2 return shape; step 4 consumption)
- Modify: `src/workflows/code-review/types.ts` (extend `PreparedFiles` / intermediate type with a patches field)
- Test: `src/workflows/code-review/__tests__/code-review-workflow.test.ts` (or the existing workflow test file)

**Approach:**
- Extend the serializable intermediate data passed from step 2 to step 4 with a `filePatches: Array<{ filename: string; patch?: string }>` field.
- Step 2 (`prepare-files`) already calls `listFiles`; capture the patches there.
- Step 4 reads patches from the intermediate state instead of re-fetching.
- Keep `fetchPreviousDonMergeComments` as-is (it fetches comments, not patches).

**Patterns to follow:**
- Existing intermediate-data passing between steps in `code-review-workflow.ts` (the `LlmReviewResult` / `PreparedFiles` objects).

**Test scenarios:**
- Happy path: step 2 fetches patches → step 4 receives them → no second `listFiles` call is made (assert via a fetch spy / counter).
- Edge case: file with no patch (binary/rename) → entry present with `patch: undefined` → downstream anchor validation treats it as no-commentable-lines.
- Error path: `listFiles` 5xx in step 2 → step 2 fails as today (no behavior change); step 4 never runs.

**Verification:**
- A single review run makes exactly one `listFiles` call against the GitHub API (verifiable via logs or a counter in a test harness).

---

- [ ] U2. **Comment anchor pre-validation (`validateInlineComments`)**

**Goal:** Drop inline comments that target lines outside a diff hunk before the POST, so a single bad anchor can never sink the whole review.

**Requirements:** R1, R2

**Dependencies:** U1 (needs the patch map)

**Files:**
- Create: `src/workflows/code-review/comment-anchors.ts`
- Create: `src/workflows/code-review/__tests__/comment-anchors.test.ts`
- Modify: `src/workflows/code-review/github-api.ts` (`publishReview` calls validation before building the payload; return dropped comments for reporting)
- Modify: `src/workflows/code-review/types.ts` (add a `DroppedComment` type)

**Approach:**
- `commentableLinesForFile(patch)` parses a unified-diff patch into `{ LEFT: Set<number>, RIGHT: Set<number> }` of valid anchor lines (lines inside `@@` hunks: `+`/context on RIGHT, `-`/context on LEFT; `\ No newline` skipped).
- `validateInlineComments(comments, map)` returns `{ valid, dropped }` where each `dropped` entry carries `{ path, line, side, reason }`. Reasons: file not in diff; file has no textual patch (binary/rename/mode); line not in hunk; `start_line > line` (inverted range); `start_line` outside hunk.
- In `publishReview`, build the commentable map from the threaded patches (U1), validate `uniqueLineComments`, keep only `valid`, and surface `dropped` to the caller (U4 reports it).

**Execution note:** Test the pure helpers first from fixture patches; then add an integration test that drives `publishReview` with one valid + one invalid comment and asserts the review still posts with only the valid one.

**Patterns to follow:**
- Pure-function + normalization style of `issue-identity.ts` (`normalizeCodeSnippet`, etc.).

**Test scenarios:**
- Happy path: comment on an added line (`+`) on RIGHT side → valid.
- Happy path: comment on a context line (` `) on both sides → valid on both.
- Edge case: comment on a removed line (`-`) → valid on LEFT, invalid on RIGHT.
- Edge case: file present but `patch: undefined` (binary) → dropped with reason "no textual diff".
- Edge case: file not in diff map at all → dropped with reason "file not in PR diff".
- Edge case: `start_line` 44, `line` 42 (inverted) → dropped with reason "start_line after line".
- Error path: comment whose `line` is 0 / undefined → dropped with a clear reason (does not throw).
- Integration: `publishReview` with a 422-prone comment + a valid comment → POST contains only the valid comment and succeeds.

**Verification:**
- A review whose LLM produced one bad-anchor comment posts successfully with the remaining comments; the dropped comment appears in the check-run summary (wired in U4).

---

- [ ] U3. **Transient-422 retry with bail around the review POST**

**Goal:** Distinguish GitHub's transient "internal error" 422 from real validation 422s and retry only the transient kind with bounded backoff.

**Requirements:** R5

**Dependencies:** None (independent; composes with U2 since U2 removes most validation 422s)

**Files:**
- Create: `src/workflows/code-review/github-retry.ts`
- Create: `src/workflows/code-review/__tests__/github-retry.test.ts`
- Modify: `src/workflows/code-review/github-api.ts` (`publishReview` POST wrapped; `githubFetch` surfaces status + body for the predicate)

**Approach:**
- `isTransientGitHubError(err)`: true iff HTTP 422 **and** body matches `/internal error occurred, please try again/i`. Attach the parsed status/body to thrown errors in `githubFetch` so the predicate can read them (today the error is a string message; enrich it).
- `withBoundedRetry(fn, { delays, bail })`: runs `fn`, retries on non-bailed errors up to `delays.length` times with the given backoff. `bail(err)` returns true for errors that should fail fast (everything that is not transient).
- In `publishReview`, wrap the POST call in `withBoundedRetry` with `bail = err => !isTransientGitHubError(err)`.

**Execution note:** Characterize current `githubFetch` error shape first (it throws `Error` with a string today); the retry wrapper needs structured access to status/body. Add a small typed error or attach fields.

**Patterns to follow:**
- The `withTimeout` wrapper already used for Flue LLM queries (Engram `Add safety timeouts to Flue LLM queries`).

**Test scenarios:**
- Happy path: POST succeeds first try → no retry, result returned.
- Happy path: POST 422s with transient body once, then succeeds → retried once, succeeds.
- Error path: POST 422s with transient body for all attempts → throws after `delays.length + 1` attempts with a message naming the transient nature.
- Error path: POST 422s with a validation body (e.g. "invalid line numbers") → `bail` returns true → fails immediately, no retry.
- Error path: POST 500 → not transient (not 422) → fails immediately.
- Edge case: delays array empty → single attempt, no retry.

**Verification:**
- A flaky GitHub moment (one transient 422) no longer fails the review; a real validation 422 still fails fast with the original message.

---

- [ ] U4. **Report dropped comments in check-run summary and review body**

**Goal:** Make dropped comments (from U2) visible to the PR author and to DonMerge operators.

**Requirements:** R2

**Dependencies:** U2 (produces the dropped list)

**Files:**
- Modify: `src/workflows/code-review/github-api.ts` (`publishReview` returns dropped list; `completeCheckRun` appends a note; `publishReview` also appends a short note to the review body when non-empty)
- Modify: `src/workflows/code-review/code-review-workflow.ts` (thread dropped list from `publishReview` to `completeCheckRun`)
- Test: `src/workflows/code-review/__tests__/github-api.test.ts`

**Approach:**
- `publishReview` returns `{ droppedComments?: DroppedComment[] }` in addition to posting.
- If `droppedComments.length > 0`, append a collapsible/short note to the review body: `**Note:** N inline comment(s) dropped (anchored outside the diff): <list>`. Cap the list at ~10 entries with an "...and X more" tail to stay under GitHub's ~65KB body limit.
- `completeCheckRun` also includes the dropped count in its summary text when present.

**Patterns to follow:**
- `buildDonmergeSection()` formatting style in `github-api.ts`.

**Test scenarios:**
- Happy path: zero dropped → review body unchanged, check-run summary unchanged.
- Happy path: 2 dropped → review body appended with a note listing both; check-run summary mentions "2 comments dropped".
- Edge case: 15 dropped → note shows first 10 + "...and 5 more".
- Integration: end-to-end run with one bad-anchor comment → review posts, body carries the note, check-run summary mentions the drop.

**Verification:**
- A PR author can see, in the posted review, which of DonMerge's findings were dropped and why.

---

- [ ] U5. **Degenerate review-body guard (`isDegenerateReviewBody`)**

**Goal:** Prevent placeholder-like or empty LLM summaries from publishing verbatim to a customer PR.

**Requirements:** R3

**Dependencies:** None

**Files:**
- Create: `src/workflows/code-review/review-body-guard.ts`
- Create: `src/workflows/code-review/__tests__/review-body-guard.test.ts`
- Modify: `src/workflows/code-review/github-api.ts` (`publishReview` checks the summary before building the payload)

**Approach:**
- `isDegenerateReviewBody(body)`: true if trimmed length below a floor (e.g. 20 chars) **and** it matches a placeholder pattern (`/test|placeholder|foo|bar|asdf|dummy|lorem/i`), OR trimmed length is 0. Adapt Pullfrog's verdict-marker exception: DonMerge's structured summary has no verdict markers, so the floor + pattern is the signal.
- On hit: replace `review.summary` with a safe fallback (`"🤠 DonMerge completed the review but produced limited output. See the check-run for details."`), log a warning with the original summary redacted/truncated, and continue publishing (do not throw — valid inline comments should still post).
- This guards the `summary` field specifically (the review body). Per-comment bodies are already structured by the prompt and lower-risk.

**Patterns to follow:**
- Predicate + small-replacement style; logging conventions in `github-api.ts` (`console.error` / `console.warn` with structured context).

**Test scenarios:**
- Happy path: normal 2-sentence summary → unchanged.
- Happy path: summary `"test"` → replaced with fallback.
- Happy path: summary `""` → replaced with fallback.
- Happy path: summary `"placeholder review"` → replaced with fallback.
- Edge case: summary `"Testing the auth flow"` (contains "test" but is substantive, > floor) → unchanged (the floor protects real reviews).
- Edge case: summary that is exactly at the floor length → boundary handled consistently.
- Integration: `publishReview` with a degenerate summary + valid comments → review posts with fallback body and the valid comments.

**Verification:**
- No placeholder or empty summary ever reaches `POST /reviews` verbatim.

---

- [ ] U6. **Skip empty `COMMENT` submissions (no-op guard)**

**Goal:** Avoid GitHub 422 on empty `COMMENT` reviews when a run finds nothing to say, while still completing the check run as success.

**Requirements:** R4

**Dependencies:** None (interacts with U5 but independent)

**Files:**
- Create: or extend `review-body-guard.ts` with `reviewSkipDecision(params)`
- Create: extend `__tests__/review-body-guard.test.ts`
- Modify: `src/workflows/code-review/github-api.ts` (`publishReview` consults the skip decision)
- Modify: `src/workflows/code-review/code-review-workflow.ts` (step 4 still completes the check run when the POST is skipped)

**Approach:**
- `reviewSkipDecision({ approved, body, hasComments })`: returns `{ kind: "no-issues", reason }` when `!approved && !body && !hasComments`; returns `{ kind: "empty-downgraded-approve", reason }` is N/A for DonMerge today (no approval opt-in toggle) — keep the shape for parity but it won't fire. Returns `null` to submit normally.
- On skip: do not POST the review; still call `completeCheckRun` with success (approved=true, empty findings). Log the skip reason.
- Empty `APPROVE` (approved=true, no body, no comments) is **not** skipped — GitHub accepts it and it is the legitimate "no issues" signal.

**Patterns to follow:**
- Decision-return shape mirrors Pullfrog's `reviewSkipDecision` (adapted to DonMerge's flatter `ReviewResult`).

**Test scenarios:**
- Happy path: approved=true, no body, no comments → not skipped (POSTs empty APPROVE).
- Happy path: approved=false, body present → not skipped.
- Happy path: approved=false, comments present → not skipped.
- Happy path: approved=false, no body, no comments → skipped; check run still completes as success.
- Integration: a run where the LLM returns `approved=false, lineComments=[], criticalIssues=[], summary=""` → no review POSTed, check run shows success with "no issues".

**Verification:**
- No empty `COMMENT` review is ever POSTed (which would 422); "no issues" runs still report success via the check run.

---

- [ ] U7. **Outstanding-threads approval gate (`countOutstandingDonmergeThreads`)**

**Goal:** Never set `approved=true` while any unresolved, DonMerge-originated review thread remains open on the PR (outdated threads count as unresolved).

**Requirements:** R6

**Dependencies:** None (reuses `fetchPreviousDonMergeComments` infra); conceptually pairs with U6

**Files:**
- Create: `src/workflows/code-review/approval-gate.ts`
- Create: `src/workflows/code-review/__tests__/approval-gate.test.ts`
- Modify: `src/workflows/code-review/github-api.ts` (`countOutstandingDonmergeThreads` using REST pagination; `publishReview` consults the gate)
- Modify: `src/workflows/code-review/code-review-workflow.ts` (thread the gate result into the publish step, or call inside `publishReview`)

**Approach:**
- `countOutstandingDonmergeThreads(previousComments)`: from the already-fetched `activePreviousComments` (step 2 fetches them), count entries where `!resolved` and the author is DonMerge. (The fetch already filters by author and sets `resolved` via the `✅ **Fixed!**` reply marker.) This avoids a new API call — reuse the data already in hand.
- In step 4, after computing `filteredResult` and before `publishReview`: if `filteredResult.approved === true` and `countOutstandingDonmergeThreads(activePreviousComments) > 0`, set `filteredResult.approved = false` and log the override. The review event then becomes `COMMENT` (the existing `approved ? 'COMMENT' : 'REQUEST_CHANGES'` logic in `publishReview` already maps `approved=false` → `REQUEST_CHANGES`; confirm whether a non-approving-but-clean review should be `COMMENT` instead of `REQUEST_CHANGES` — see Open Questions).
- Do not throw. The review still posts with all valid findings; only the verdict is downgraded.

**Execution note:** Decide during implementation whether a downgrade because of outstanding threads should produce `REQUEST_CHANGES` (blocks merge) or `COMMENT` (non-blocking). `COMMENT` is safer — the new diff is clean, only prior threads are open. Default to `COMMENT` unless the outstanding threads are `critical` severity.

**Patterns to follow:**
- The existing `withBlockingApproval()` helper in the publish step (it already overrides approval based on findings); add the outstanding-threads override alongside it.

**Test scenarios:**
- Happy path: approved=true, zero outstanding threads → stays approved.
- Happy path: approved=true, 2 outstanding unresolved DonMerge threads → downgraded to approved=false; review posts as COMMENT (or REQUEST_CHANGES per decision).
- Happy path: approved=false already → no change regardless of outstanding threads.
- Edge case: outstanding thread is marked `[OUTDATED]` by GitHub → still counted as unresolved (GitHub's outdated ≠ resolved; DonMerge's `resolved` flag is set only by the `✅ **Fixed!**` reply, so outdated-but-unreplied threads correctly stay counted). Verify the `resolved` derivation in `fetchPreviousDonMergeComments` does not treat outdated as resolved.
- Edge case: all outstanding threads are from human reviewers (not DonMerge) → not counted → approval stands.
- Integration: a re-review where the prior run left a critical thread open and the new diff is clean → new review is non-approving.

**Verification:**
- It is impossible for DonMerge to post an `APPROVE`/clean-check-run while a DonMerge-originated thread it raised is still unresolved on the PR.

---

- [ ] U8. **Reviewed-SHA metadata in the review body**

**Goal:** Pin the reviewed `head_sha` and base ref in the posted review body so a reader can tell whether findings are stale after a push.

**Requirements:** R7

**Dependencies:** None

**Files:**
- Modify: `src/workflows/code-review/github-api.ts` (`publishReview` prepends a metadata HTML comment to the body; mirror the `MARKER_PREFIX` style from `fingerprint.ts`)
- Test: `src/workflows/code-review/__tests__/github-api.test.ts`

**Approach:**
- Define `REVIEW_META_PREFIX = '<!-- DONMERGE_REVIEW:'` and a `buildReviewMeta({ headSha, baseRef, reviewedAt })` helper returning `<!-- DONMERGE_REVIEW: {...} -->\n\n`.
- Prepend it to `review.summary` in `publishReview`. HTML comments are invisible in rendered markdown but parseable.
- Keep it distinct from the per-comment `DONMERGE:` fingerprint marker (which is per-comment); this is per-review.

**Patterns to follow:**
- `attachFingerprint()` / `parseFingerprint()` in `fingerprint.ts`.

**Test scenarios:**
- Happy path: review body starts with the metadata comment containing headSha and baseRef.
- Happy path: metadata comment is invisible in rendered markdown (it is an HTML comment).
- Edge case: very long sha → included in full (GitHub accepts it).
- Integration: end-to-end run → posted review body begins with the metadata comment.

**Verification:**
- Every posted DonMerge review carries a machine-readable marker of which commit it was written against.

---

## System-Wide Impact

- **Interaction graph:** All changes are inside `CodeReviewWorkflow` step 4 and `github-api.ts`. The webhook handler, queue consumer, sandbox/Flue runtime, triage workflow, and memory system are untouched. The check-run and PR-description writes gain optional extra fields (dropped-comments note) but their contracts do not change.
- **Error propagation:** New guards (U2, U5, U6) convert would-be-fatal errors (422, empty POST) into graceful degradation: the review still posts (partially) or the check-run still completes. The transient-422 retry (U3) adds a bounded retry loop that must not mask persistent failures — the `bail` predicate is the safety valve.
- **State lifecycle risks:** The retry wrapper (U3) must be careful not to double-post reviews. GitHub's `POST /reviews` is **not idempotent** — a retry after a partial success creates a second review. Mitigation: only retry when the POST threw before any 2xx; once the response body is received, do not retry. The `withBoundedRetry` wrapper retries the whole `fn`, so as long as `githubFetch` throws on non-2xx (it does), a successful post is never retried.
- **API surface parity:** The `POST /api/v1/review` push-API path eventually calls the same `CodeReviewWorkflow`, so it inherits all guards for free. No separate change needed.
- **Integration coverage:** The end-to-end behavior (bad anchor no longer sinks review; clean diff with prior open thread no longer approves) must be verified with integration tests that drive `publishReview` with realistic `ReviewResult` + `activePreviousComments` fixtures, not just unit tests of the pure helpers.
- **Unchanged invariants:** The structured-JSON LLM contract, the fingerprint/identity dedup system, the multi-model fallback chain, and the multi-tenant D1 config are all explicitly unchanged. The new guards operate strictly downstream of the existing dedup and filtering.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Retry wrapper double-posts a review on transient 422 | `githubFetch` throws on non-2xx before any side effect is observable; retry only runs when the call threw. Add an integration test asserting exactly one review exists after a one-transient-422-then-success sequence. |
| Approval downgrade (U7) surprises users who expect approval on clean diffs | Default the downgrade to `COMMENT` (non-blocking), not `REQUEST_CHANGES`. Log the override clearly. The check-run summary should note "approval withheld: N prior DonMerge threads unresolved". |
| Anchor validation (U2) drops a comment the author considered valid | Dropped comments are always reported (U4) with a reason, so the author sees what was dropped and why; no silent loss. |
| Patch threading (U1) increases step 2 → step 4 serialized payload size | Patches can be large on big PRs. If payload size becomes a concern, pass only `{ filename, commentableLines }` (the precomputed sets) instead of raw patches — smaller and directly consumable by U2. Decide during implementation. |
| Degenerate-body floor (U5) too aggressive, rejects real short summaries | Floor calibrated to ~20 chars (Pullfrog's calibration); real DonMerge summaries are 1-2 sentences and always clear the floor. Add a regression test with the shortest realistic summary. |
| REST pagination for `countOutstandingDonmergeThreads` (U7) on huge PRs | Reuse already-fetched `activePreviousComments` (step 2 fetches them with `per_page=100`); no new pagination walk needed. If a PR has >100 prior comments, the existing fetch is already paginated/paged — confirm and extend if necessary. |

---

## Phased Delivery

### Phase 1 — Foundation
- U1 (patch cache). Unblocks U2.

### Phase 2 — Publish-time robustness
- U2 (anchor validation), U3 (transient retry), U4 (dropped reporting). U2 depends on U1; U3 and U4 compose with U2.

### Phase 3 — Output-quality guards
- U5 (degenerate body), U6 (empty-submission skip). Independent of Phase 2; can land in parallel.

### Phase 4 — Correct approval semantics
- U7 (outstanding-threads gate), U8 (reviewed-SHA metadata). U7 is the highest-value unit in the plan; U8 is lightweight polish.

Each unit is independently shippable behind the phase ordering. Phase 2 is the highest-risk/highest-value cluster; Phase 4's U7 closes the most consequential correctness gap.

---

## Documentation / Operational Notes

- Update `docs/ARCHITECTURE.md` "Code Review Pipeline" section to mention the new publish-time guards (anchor validation, transient retry, approval gate) once landed.
- The check-run summary gains a "dropped comments" line and, when approval is withheld, a "prior threads unresolved" line — these are user-visible behavior changes worth noting in any release notes.
- No new env vars or D1 migrations required. No new external dependencies (no Octokit/GraphQL/arktype introduced).
- Rollout: all units are behind the existing deploy path (`wrangler deploy`). No feature flag needed, but U7 (approval gate) is the one behavior change that could surprise users — consider landing it last and announcing it.

---

## Sources & References

- **Origin analysis:** Engram observation #7094 (`donmerge-pullfrog-comparison`) — the deep comparison that surfaced these gaps.
- **Reference implementation:** `pullfrog/pullfrog` (cloned at `/tmp/pi-github-repos/pullfrog/pullfrog`), specifically `mcp/review.ts` and `mcp/reviewComments.ts`.
- Related DonMerge code: `src/workflows/code-review/code-review-workflow.ts` (step 4), `src/workflows/code-review/github-api.ts` (`publishReview`, `fetchPreviousDonMergeComments`, `completeCheckRun`), `src/workflows/code-review/fingerprint.ts` (marker pattern to extend).
- Related Engram learnings: `Add safety timeouts to Flue LLM queries` (wrapper pattern), `Corrige re-reviews con payload fresco por comentario` (workflow idempotency), `DonMerge LLM architecture: dual flow` (OpenAI coupling points).
