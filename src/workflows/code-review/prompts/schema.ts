/**
 * JSON schema definition for LLM output validation.
 * Defines the expected structure of review results.
 */

/**
 * JSON schema for the review output (used in prompt).
 * Uses structured PR summary for rich, parseable output.
 */
export const REVIEW_OUTPUT_SCHEMA = `{
  "approved": boolean,
  "summary": "1-2 sentence overall review summary",
  "prSummary": {
    "overview": "1-2 sentences describing what this PR does",
    "keyChanges": ["list of 3-5 main changes or additions"],
    "codeQuality": "Brief assessment: clean/well-structured/needs improvement/etc",
    "testingNotes": "Observations about test coverage or testing needs",
    "riskAssessment": "Low/Medium/High risk with brief explanation"
  },
  "lineComments": [
    {
      "path": "exact file path from diff",
      "line": number (exact line from diff),
      "side": "LEFT" or "RIGHT",
      "issueKey": "stable kebab-case identifier for this finding in this file",
      "ruleId": "kebab-case rule identifier (e.g., inverted-response-check)",
      "entityType": "method" | "function" | "class" | "variable" | "module",
      "symbolName": "fully-qualified symbol name (e.g., BookingService.confirm)",
      "codeSnippet": "short normalized snippet around the issue",
      "body": "Full comment with Issue, Suggestion, and AI Prompt sections",
      "severity": "critical" or "suggestion"
    }
  ],
  "resolvedComments": [list of previous comment IDs that are now fixed],
  "criticalIssues": ["brief summary of each critical issue"],
  "suggestions": ["brief summary of each suggestion"],
  "fileSummaries": [
    {
      "path": "exact file path from diff",
      "changeType": "added" or "modified" or "deleted" or "renamed",
      "summary": "1 sentence describing what changed in this file"
    }
  ]
}`;
