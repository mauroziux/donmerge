/**
 * JSON schema definition for Sentry triage LLM output.
 */

export const TRIAGE_OUTPUT_SCHEMA = `{
  "root_cause": "Clear, specific description of the root cause",
  "stack_trace_summary": "Brief summary of the key stack trace frames",
  "affected_files": ["list of file paths involved in the error"],
  "suggested_fix": "Concrete, actionable description of how to fix the issue",
  "confidence": "high" | "medium" | "low",
  "severity": "critical" | "error" | "warning"
}`;
