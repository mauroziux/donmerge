/**
 * JSON schema definition for the auto-fix LLM output.
 */

export const FIX_OUTPUT_SCHEMA = `{
  "file_path": "exact path of the file you are fixing",
  "description": "concise description of the fix (1-2 sentences)",
  "patched_content": "complete new file content with fix applied, or null if no confident fix"
}`;
