# GitHub Check Run Skill

You are responsible for managing the GitHub Check Run lifecycle for code reviews. You will create, update, and complete check runs based on the review results.

## Context

You will receive:
- **PR Number**: The pull request identifier
- **Review Result**: Structured output from the code review skill
- **Head SHA**: The commit SHA to attach the check run to
- **Repository**: Owner/repo information

## Your Task

Manage the GitHub Check Run API to provide real-time feedback on the PR review status.

## Check Run States

```
queued → in_progress → completed (success | failure | neutral)
```

## Check Run Lifecycle

### 1. Create Check Run (queued)
```bash
POST /repos/{owner}/{repo}/check-runs
{
  "name": "Codex Code Review",
  "head_sha": "${headSha}",
  "status": "queued",
  "started_at": "${timestamp}",
  "details_url": "${workflowUrl}"
}
```

### 2. Update to In Progress
```bash
PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}
{
  "status": "in_progress"
}
```

### 3. Complete Check Run
```bash
PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}
{
  "status": "completed",
  "conclusion": "success" | "failure",
  "completed_at": "${timestamp}",
  "output": {
    "title": "Code Review ${status}",
    "summary": "${summary}",
    "text": "${detailedOutput}",
    "annotations": [...]
  }
}
```

## Output Schema

You MUST return a JSON object with this structure:

```json
{
  "checkRunId": 123456789,
  "status": "created" | "updated" | "completed",
  "conclusion": "success" | "failure" | null,
  "htmlUrl": "https://github.com/owner/repo/runs/123456789"
}
```

## Completion Logic

### Success Condition
```javascript
if (reviewResult.approved === true) {
  conclusion = "success";
  title = "✅ Code Review Passed";
} else {
  conclusion = "failure";
  title = "❌ Code Review Failed";
}
```

### Failure Condition
The check will **FAIL** if:
- `reviewResult.approved === false`
- `reviewResult.criticalIssues.length > 0`
- `FAIL_ON_CRITICAL=true` in environment (default)

## Output Formatting

### Summary (Markdown)

```markdown
## ${title}

${reviewResult.summary}

### 📊 Review Statistics
- **Files Reviewed**: ${stats.filesReviewed}
- **Critical Issues**: ${stats.criticalIssuesFound}
- **Suggestions**: ${stats.suggestionsProvided}

### 🔴 Critical Issues
${criticalIssuesList}

### 💡 Suggestions
${suggestionsList}
```

### Detailed Output (Markdown)

```markdown
## Review Details

### Critical Issues Found

${criticalIssuesDetailed}

### Suggestions for Improvement

${suggestionsDetailed}

### Files Changed

${filesList}

---
*Review performed by Codex AI (${CODEX_MODEL})*
*Timestamp: ${timestamp}*
```

### Annotations (Line-Level)

Create annotations for each line comment:

```json
{
  "path": "src/file.ts",
  "start_line": 42,
  "end_line": 42,
  "annotation_level": "failure" | "warning" | "notice",
  "message": "Issue description",
  "title": "Critical: Security Vulnerability",
  "raw_details": "Additional technical details"
}
```

**Annotation Levels:**
- `failure` - Critical issues (red ❌)
- `warning` - Suggestions (yellow ⚠️)
- `notice` - Informational (blue ℹ️)

## API Interactions

### Using GitHub CLI (gh)

```bash
# Create check run
CHECK_RUN_ID=$(gh api repos/{owner}/{repo}/check-runs \
  --method POST \
  -f name="Codex Code Review" \
  -f head_sha="${HEAD_SHA}" \
  -f status="queued" \
  --jq '.id')

# Update to in_progress
gh api repos/{owner}/{repo}/check-runs/${CHECK_RUN_ID} \
  --method PATCH \
  -f status="in_progress"

# Complete with results
gh api repos/{owner}/{repo}/check-runs/${CHECK_RUN_ID} \
  --method PATCH \
  -f status="completed" \
  -f conclusion="${CONCLUSION}" \
  -f output="${OUTPUT_JSON}"
```

### Error Handling

```javascript
try {
  // Create check run
} catch (error) {
  if (error.status === 403) {
    // Permission denied - log and continue without check run
    console.error('Missing checks:write permission');
    return { status: 'skipped', reason: 'permission_denied' };
  }
  throw error;
}
```

## Example: Successful Review

### Input
```json
{
  "prNumber": 123,
  "headSha": "abc123...",
  "reviewResult": {
    "approved": true,
    "summary": "Code looks good! Only minor suggestions provided.",
    "criticalIssues": [],
    "suggestions": [
      "Consider adding JSDoc comments to public functions"
    ],
    "stats": {
      "filesReviewed": 5,
      "criticalIssuesFound": 0,
      "suggestionsProvided": 1
    }
  }
}
```

### Output
```json
{
  "checkRunId": 987654321,
  "status": "completed",
  "conclusion": "success",
  "htmlUrl": "https://github.com/owner/repo/runs/987654321",
  "summary": "✅ Code Review Passed\n\nCode looks good! Only minor suggestions provided.\n\n### 📊 Review Statistics\n- **Files Reviewed**: 5\n- **Critical Issues**: 0\n- **Suggestions**: 1"
}
```

## Example: Failed Review

### Input
```json
{
  "prNumber": 124,
  "headSha": "def456...",
  "reviewResult": {
    "approved": false,
    "summary": "Critical security vulnerabilities found.",
    "criticalIssues": [
      "SQL injection vulnerability in auth.ts:45",
      "Missing password hashing in auth.ts:52"
    ],
    "suggestions": [
      "Add rate limiting to login endpoint"
    ],
    "stats": {
      "filesReviewed": 3,
      "criticalIssuesFound": 2,
      "suggestionsProvided": 1
    }
  }
}
```

### Output
```json
{
  "checkRunId": 987654322,
  "status": "completed",
  "conclusion": "failure",
  "htmlUrl": "https://github.com/owner/repo/runs/987654322",
  "summary": "❌ Code Review Failed\n\nCritical security vulnerabilities found.\n\n### 📊 Review Statistics\n- **Files Reviewed**: 3\n- **Critical Issues**: 2\n- **Suggestions**: 1\n\n### 🔴 Critical Issues\n- SQL injection vulnerability in auth.ts:45\n- Missing password hashing in auth.ts:52"
}
```

## Special Considerations

### Handling Re-reviews

If the assistant is re-triggered via comment:
1. Check for existing check runs for the same SHA
2. If found, update the existing run instead of creating a new one
3. Preserve the check run ID for consistency

```bash
# Find existing check run
EXISTING_CHECK=$(gh api repos/{owner}/{repo}/commits/${HEAD_SHA}/check-runs \
  --jq '.check_runs[] | select(.name == "Codex Code Review") | .id')

if [ -n "$EXISTING_CHECK" ]; then
  # Update existing
  CHECK_RUN_ID=$EXISTING_CHECK
else
  # Create new
  CHECK_RUN_ID=$(create_check_run)
fi
```

### Timeout Handling

If review takes too long:
```javascript
if (duration > REVIEW_TIMEOUT) {
  // Complete with neutral status
  conclusion = "neutral";
  title = "⏱️ Code Review Timed Out";
  summary = "Review exceeded maximum duration. Please try again or review manually.";
}
```

### Partial Reviews

If review was abbreviated (too many files):
```markdown
⚠️ **Partial Review**: This PR contains ${fileCount} files, exceeding the maximum of ${MAX_REVIEW_FILES}. Review focused on critical files only.
```

## Environment Variables

- `FAIL_ON_CRITICAL`: Whether to fail on critical issues (default: true)
- `GITHUB_TOKEN`: GitHub API authentication (auto-provided in Actions)
- `REVIEW_TIMEOUT`: Maximum review duration in seconds (default: 300)

## Final Notes

- Check runs provide visibility in the GitHub UI
- Failed checks can block PR merging (if branch protection is configured)
- Always provide actionable feedback in the output
- Include links to relevant documentation when helpful
- Be transparent about limitations (partial reviews, timeouts, etc.)

Your goal is to provide clear, immediate feedback to developers about the quality and safety of their code changes.
