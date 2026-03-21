# DonMerge Issue Tracking System - Implementation Plan

## Overview

Transform DonMerge from a comment-based system to an issue-tracking system where findings are first-class entities with stable identities and explicit lifecycle states.

## Goal

- No duplicate comments for the same issue
- Correct partial-resolve behavior
- Ability to detect reintroduced issues
- Stable identity across code movement and LLM wording changes

---

## Architecture

### Issue Identity Model

Each finding has a structured identity:

```typescript
interface IssueIdentity {
  ruleId: string;           // e.g., "inverted-condition-check"
  entityType: 'method' | 'function' | 'class' | 'variable' | 'module';
  symbolName: string;       // e.g., "BookingService.confirm"
  filePath: string;         // e.g., "api/src/services/booking.ts"
  snippetHash: string;      // hash of normalized code snippet
}
```

### Fingerprint Strategy

```text
logicalKey  = ruleId + entityType + symbolName
anchorKey   = filePath + snippetHash
fingerprint = hash(logicalKey + anchorKey)
```

### Matching Priority

1. Exact `fingerprint` match
2. Exact `logicalKey` match (same rule + same symbol)
3. Same `filePath` + high snippet/context overlap
4. (Optional) Semantic similarity fallback

### Issue Lifecycle

```
new → open → fixed → reintroduced → open → ...
         ↓
      dismissed (user marked won't fix)
```

States:
- `new` — First time seen, post comment
- `open` — Still present in latest commit, don't repost
- `fixed` — Not found in latest commit, post "Fixed!" reply
- `reintroduced` — Was fixed, now appears again, post new comment

### Stored Issue Record

```typescript
interface TrackedIssue {
  id: string;                    // internal ID
  fingerprint: string;           // full fingerprint
  logicalKey: string;            // rule + entity + symbol
  anchorKey: string;             // file + snippet hash
  
  repo: string;
  prNumber: number;
  
  ruleId: string;
  entityType: string;
  symbolName: string;
  filePath: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  
  severity: 'critical' | 'suggestion';
  body: string;                  // comment body
  
  status: 'new' | 'open' | 'fixed' | 'reintroduced' | 'dismissed';
  
  githubCommentId: number;       // original review comment ID
  resolutionReplyId?: number;    // "Fixed!" reply ID
  
  firstSeenCommit: string;       // commit SHA
  lastSeenCommit: string;        // commit SHA
  fixedCommit?: string;          // commit SHA when marked fixed
  
  createdAt: string;
  updatedAt: string;
}
```

---

## Implementation Phases

### Phase 1: Structured Issue Schema

**Goal:** Update types and LLM output to include structured identity fields.

**Tasks:**

1. **Update ReviewComment type**
   - File: `src/workflows/code-review/types.ts`
   - Add fields: `ruleId`, `entityType`, `symbolName`, `codeSnippet`

2. **Update LLM output schema**
   - File: `src/workflows/code-review/prompts/schema.ts`
   - Add structured fields to lineComment schema

3. **Update prompt templates**
   - File: `src/workflows/code-review/prompts/templates.ts`
   - Add instructions for extracting:
     - `ruleId`: kebab-case identifier for the issue type
     - `entityType`: method/function/class/variable/module
     - `symbolName`: the containing symbol (e.g., `ClassName.methodName`)
     - `codeSnippet`: short normalized code context

4. **Add TrackedIssue type**
   - File: `src/workflows/code-review/types.ts`
   - Define the full issue record type

5. **Add issue identity utilities**
   - File: `src/workflows/code-review/issue-identity.ts` (new)
   - Functions:
     - `generateFingerprint(identity)`
     - `generateLogicalKey(identity)`
     - `generateAnchorKey(identity)`
     - `normalizeCodeSnippet(snippet)`
     - `extractSymbolFromCode(code, line)` — best-effort symbol extraction

**Verification:**
- LLM returns structured fields in test PR
- Fingerprints are stable across paraphrased comments

---

### Phase 2: Issue Storage in Durable Object

**Goal:** Persist tracked issues per PR in ReviewProcessor storage.

**Tasks:**

1. **Add storage keys**
   - File: `src/workflows/code-review/processor.ts`
   - Add: `STATE_KEYS.issues = 'trackedIssues'`

2. **Add issue CRUD operations**
   - File: `src/workflows/code-review/issue-store.ts` (new)
   - Functions:
     - `loadTrackedIssues(storage): Promise<TrackedIssue[]>`
     - `saveTrackedIssues(storage, issues): Promise<void>`
     - `findIssueByFingerprint(issues, fingerprint): TrackedIssue | undefined`
     - `findIssueByLogicalKey(issues, logicalKey): TrackedIssue | undefined`
     - `findIssueByAnchorOverlap(issues, filePath, snippetHash): TrackedIssue | undefined`

3. **Add issue matching logic**
   - File: `src/workflows/code-review/issue-matcher.ts` (new)
   - Function: `matchCurrentFindingsToStored(current, stored): MatchResult`
   - Returns:
     - `newIssues` — not matched, status = new
     - `persistingIssues` — matched, status = open
     - `resolvedIssues` — previously open, not in current
     - `reintroducedIssues` — previously fixed, now in current

**Verification:**
- Unit test matching logic with sample issues
- Storage persists across alarm retries

---

### Phase 3: Lifecycle Transitions

**Goal:** Implement lifecycle state transitions and GitHub actions.

**Tasks:**

1. **Implement lifecycle transitions**
   - File: `src/workflows/code-review/issue-lifecycle.ts` (new)
   - Functions:
     - `transitionToNew(issue): TrackedIssue`
     - `transitionToOpen(issue, currentCommit): TrackedIssue`
     - `transitionToFixed(issue, fixedCommit): TrackedIssue`
     - `transitionToReintroduced(issue, currentCommit): TrackedIssue`

2. **Update GitHub API for lifecycle**
   - File: `src/workflows/code-review/github-api.ts`
   - Functions:
     - `postNewIssueComment(owner, repo, prNumber, issue, token)` — create review comment
     - `postResolutionReply(owner, repo, prNumber, issue, token)` — reply "Fixed!"
     - `postReintroducedComment(owner, repo, prNumber, issue, token)` — new thread for reintroduced

3. **Wire lifecycle into processor**
   - File: `src/workflows/code-review/processor.ts`
   - In review processing:
     - Load stored issues
     - Match current findings to stored
     - Apply transitions
     - Post only `new` and `reintroduced` comments
     - Post `fixed` replies for resolved
     - Save updated issues

**Verification:**
- New issue → comment posted
- Persisting issue → no new comment
- Fixed issue → "Fixed!" reply
- Reintroduced issue → new comment

---

### Phase 4: Comment-to-Issue Reconciliation

**Goal:** On first run after upgrade, reconcile existing GitHub comments to tracked issues.

**Tasks:**

1. **Add reconciliation logic**
   - File: `src/workflows/code-review/issue-reconcile.ts` (new)
   - Function: `reconcileExistingComments(comments, currentFindings): TrackedIssue[]`
   - For each existing DonMerge comment:
     - Parse fingerprint from body
     - Extract issue identity from comment (fallback to deriving from body)
     - Create tracked issue with status = open

2. **Wire reconciliation into processor**
   - File: `src/workflows/code-review/processor.ts`
   - On first run (no stored issues):
     - Fetch previous comments
     - Reconcile to tracked issues
     - Save to storage

**Verification:**
- Existing PRs get issues tracked on first re-run
- No duplicate comments after upgrade

---

### Phase 5: Testing & Validation

**Goal:** Comprehensive testing of all scenarios.

**Test Scenarios:**

1. **New issue**
   - Create PR with issue
   - Verify comment posted
   - Verify issue stored with status = new

2. **Persisting issue**
   - Push new commit, issue still present
   - Verify NO new comment
   - Verify issue status = open

3. **Fixed issue**
   - Push commit that fixes issue
   - Verify "Fixed!" reply
   - Verify issue status = fixed

4. **Partial fix**
   - PR with 2 issues
   - Fix only one
   - Verify one "Fixed!" reply
   - Verify one issue remains open (no new comment)

5. **Reintroduced issue**
   - Fix issue, get "Fixed!"
   - Re-introduce the same issue
   - Verify new comment posted
   - Verify issue status = reintroduced

6. **Line movement**
   - Issue on line 50
   - Add code above, issue moves to line 60
   - Verify same thread (matched by logical key)

7. **Wording change**
   - LLM paraphrases issue comment
   - Verify same thread (matched by logical key)

**Verification:**
- All test scenarios pass manually
- No duplicate comments in any scenario

---

## File Changes Summary

### New Files
- `src/workflows/code-review/issue-identity.ts` — fingerprint and key generation
- `src/workflows/code-review/issue-store.ts` — storage CRUD
- `src/workflows/code-review/issue-matcher.ts` — matching logic
- `src/workflows/code-review/issue-lifecycle.ts` — state transitions
- `src/workflows/code-review/issue-reconcile.ts` — upgrade reconciliation

### Modified Files
- `src/workflows/code-review/types.ts` — add structured types
- `src/workflows/code-review/prompts/schema.ts` — update LLM schema
- `src/workflows/code-review/prompts/templates.ts` — update prompt
- `src/workflows/code-review/processor.ts` — wire everything together
- `src/workflows/code-review/github-api.ts` — lifecycle-aware posting
- `README-CODE-REVIEW.md` — document new behavior

---

## Recommended Execution Order

1. Phase 1 — Structured schema (foundation)
2. Phase 2 — Issue storage (persistence)
3. Phase 3 — Lifecycle transitions (behavior)
4. Phase 4 — Reconciliation (upgrade path)
5. Phase 5 — Testing (validation)

---

## Estimated Effort

| Phase | Tasks | Complexity |
|-------|-------|------------|
| Phase 1 | 5 | Medium |
| Phase 2 | 3 | Medium |
| Phase 3 | 3 | High |
| Phase 4 | 2 | Medium |
| Phase 5 | 7 scenarios | High |

---

## Success Criteria

- [ ] No duplicate comments for same issue across commits
- [ ] Partial resolve works correctly (fix one of two issues)
- [ ] Reintroduced issues get new comments
- [ ] Line movement doesn't cause duplicates
- [ ] Wording changes don't cause duplicates
- [ ] Upgrade from old system works without duplicates
- [ ] All test scenarios pass

---

## Notes

- Start with Phase 1 and Phase 2 to get the foundation in place
- Phase 3 is where the real behavior change happens
- Can ship incrementally: Phases 1-3 first, then Phase 4-5
- Consider adding a debug mode to log matching decisions
