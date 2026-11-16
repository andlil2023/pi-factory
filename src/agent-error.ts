/** Agent invocation failure, independent of the process runner. */
export class AgentExecutionError extends Error {
  readonly role: 'implementer' | 'reviewer';
  readonly retryable: boolean;
  constructor(role: 'implementer' | 'reviewer', retryable: boolean, message: string) {
    super(`${role}: ${message}`);
    this.role = role;
    this.retryable = retryable;
    this.name = 'AgentExecutionError';
  }
}
