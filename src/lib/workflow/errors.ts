/**
 * Non-retryable error for validation failures.
 * Used when input is invalid, missing required fields, or fails validation rules.
 *
 * The Cloudflare base class (`OpenStoryWorkflowEntrypoint`) detects this type
 * at the `runImpl` boundary and re-throws it as a `NonRetryableError` so the
 * workflow engine fails the instance immediately instead of retrying.
 *
 * @example
 * throw new WorkflowValidationError('Script is too short (minimum 50 characters)');
 */
export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowValidationError';
  }
}
