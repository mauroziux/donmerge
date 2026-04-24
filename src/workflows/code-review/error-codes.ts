/** Error codes for DonMerge review failures */
export const ErrorCode = {
  /** LLM prompt/model failure (Flue errors, model response parsing, etc.) */
  LLM_FAILURE: 'DM-E001',
  /** Review exceeded maximum retry attempts */
  MAX_ATTEMPTS: 'DM-E002',
  /** GitHub API interaction failed */
  GITHUB_API: 'DM-E003',
  /** Invalid review output after all retries */
  INVALID_OUTPUT: 'DM-E004',
  /** Internal/unknown error */
  INTERNAL: 'DM-E005',
  /** API quota or rate limit exceeded */
  QUOTA_LIMIT: 'DM-E006',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Human-readable descriptions for each error code (for internal use / docs) */
export const ErrorCodeDescriptions: Record<ErrorCode, string> = {
  [ErrorCode.LLM_FAILURE]:
    'The AI model failed to process the review. This may be a temporary issue with the model or API.',
  [ErrorCode.MAX_ATTEMPTS]: 'The review exceeded the maximum retry attempts.',
  [ErrorCode.GITHUB_API]: 'A GitHub API request failed during the review.',
  [ErrorCode.INVALID_OUTPUT]:
    'The AI model produced invalid output after all retry attempts.',
  [ErrorCode.INTERNAL]:
    'An unexpected internal error occurred during the review.',
  [ErrorCode.QUOTA_LIMIT]:
    'The AI model API quota or rate limit has been exceeded. Please check billing and try again later.',
};
