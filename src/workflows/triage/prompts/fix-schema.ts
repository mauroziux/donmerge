/**
 * JSON schema definition for the auto-fix LLM output.
 */

export const FIX_OUTPUT_SCHEMA = `{
  "file_path": "exact path of the file you are fixing",
  "description": "concise description of the fix (1-2 sentences)",
  "edits": [
    {
      "search": "2-5 lines of the ORIGINAL code to find (must be an exact substring of the source)",
      "replace": "the corrected code to put in its place",
      "description": "what this edit does"
    }
  ]
}`;
