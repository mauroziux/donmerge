# DonMerge Production Validation — 2026-08-21

## Scope

This record documents the production validation after the AI Gateway timeout incident and the subsequent review-execution refactor.

- Target repository: `tableoltd/rms`
- Initial incident PR: [#3707](https://github.com/tableoltd/rms/pull/3707)
- Production Worker: `tableo-assitant-worker`
- Latest deployed version: `7bc47f82-b4de-4a03-9166-2b3fa3dce5f2`
- Source commit: `7443d95 refactor(review): isolate model retry policy`

## Timeline

1. PR #3707 exposed `DM-E001` failures caused by slow AI Gateway/provider responses.
2. Commit `e4d8688` increased the LLM timeout and Workflow timeout and added direct-provider fallback.
3. The review execution seam was deepened in `7443d95`:
   - `review-model-runner.ts` owns model ordering, output validation, one format-repair retry, and fallback.
   - Exhausted model failures do not replay the entire durable step.
   - Unclassified sandbox/infrastructure errors remain Workflow-retryable.
4. Production was deployed as version `7bc47f82-b4de-4a03-9166-2b3fa3dce5f2`.
5. A fresh `@donmerge` comment on #3707 completed in 7m15s with no `DM-E001`. The check correctly reported a real FSM issue in `SyrveWebhookService.php:419-421`.
6. Fifteen open PRs created after #3707 were retriggered.
7. Six checks initially returned `DM-E005`. A second rerun completed all six successfully.

## Open PR rerun results

### Initial rerun

| Result | PRs |
|---|---|
| Review completed with no blocking finding | #3806, #3837, #3899, #3902 |
| Review completed with findings | #3721, #3730, #3797, #3853, #3876 |
| `DM-E005` | #3877, #3889, #3891, #3895, #3896, #3906 |

### Follow-up rerun of `DM-E005` PRs

All six completed successfully:

| PR | Result summary |
|---|---|
| #3877 | Review completed; approval remains withheld by an unresolved prior DonMerge thread. The review also surfaced an ownership/IDOR concern for cancellation authorization. |
| #3889 | Review completed; review notes remain about cross-restaurant scoping, policy authorization, soft-deleted restaurant search, and a possible null relation. |
| #3891 | Review completed with no blocking correctness, security, or data-integrity issue. |
| #3895 | Review completed with non-blocking notes around CSP/PDF viewing, `documents_count`, and a UUID backfill race. |
| #3896 | Review completed with the same non-blocking document-download notes as #3895. |
| #3906 | Review completed with low-impact edge-path notes around abandoned alerts and a possible TOCTOU double-fire. |

The initial `DM-E005` results did not reproduce deterministically: the follow-up runs completed successfully without a Worker code change. Live tailing showed Sandbox/Workflow activity and canceled Sandbox cleanup, but no conclusive application exception identifying a permanent root cause. Treat the initial failures as transient production failures under burst load/provider conditions, not as a proven concurrency root cause.

## Earlier completed findings

The first review pass also produced these actionable findings:

- **#3721:** possible null-safe dereference regression in `GoogleServer::cancelBooking`.
- **#3730:** locale-dependent comparison for untitled campaign detection.
- **#3797:** widget edit-session fallback clobbering and empty UUID token risk.
- **#3853:** migration gap between existing public-disk PDFs and new private-disk downloads.
- **#3876:** PR description/diff mismatch, inverted Slack alert condition, and unbounded 401 retry recursion.
- **#3707:** direct booking status persistence bypasses the booking FSM, state history, guards, and observer side effects.

These are findings in the target repository and are separate from DonMerge infrastructure health.

## Latest CI audit: PR #3923

PR #3923 did not execute the normal CI workflow because it targeted the feature branch `fix/tab-3041-quick-start-guide-amend-to-6-steps`, not one of the branches configured in `.github/workflows/ci.yml`:

```yaml
on:
  pull_request:
    branches: [develop, master, sandbox]
```

The PR was merged into that feature branch in commit `3e65c4ba57e15837d609ce747a528567f6f778c9` before any CI run was created. The only check recorded directly on #3923 was external CodeSmith, marked `skipped`.

The merge commit then became the head of PR #3919, which did run code quality and DonMerge successfully. Its full MariaDB and Pacific/Auckland suites were skipped because #3919 targets `develop`; those suites are intentionally gated by `github.base_ref == 'master'` in `ci.yml`.

This is configuration behavior, not a DonMerge failure. It is a coverage gap only if nested PRs targeting feature branches are expected to receive CI before merging. The current decision is to leave this behavior unchanged; no CI workflow change was requested or made.

## Current pending work

1. Fix or explicitly disposition the review findings in `tableoltd/rms`.
2. Resolve or dismiss the outstanding DonMerge thread on #3877, then rerun DonMerge if an approving result is required.
3. Leave the stacked-PR CI behavior unchanged unless the team later requests broader coverage.
4. Monitor future `DM-E005` occurrences. If they recur, add a durable correlation ID and structured attempt/provider logs around model execution and Sandbox lifecycle before changing retry policy again.
5. No DonMerge code change or redeploy is currently required from this validation.

## Verification evidence

- DonMerge check on #3707 completed successfully as an execution, with a real review finding.
- All six follow-up `DM-E005` reruns completed successfully.
- Earlier source verification: `npm run typecheck`, `npm test -- --run` (1096 tests), `git diff --check`, and `npx wrangler deploy --dry-run` passed before production deployment.
