import { OperationType } from "@aws-sdk/client-lambda";

/**
 * Context information for a durable operation that is passed to plugin hooks
 *
 * @public
 */
export interface OperationContext {
  /**
   * Type of durable operation being executed
   */
  operationType: OperationType;

  /**
   * Unique identifier for this operation instance within the execution
   * Format: stepId from the durable context (e.g., "1", "2", "1-1")
   */
  operationId: string;

  /**
   * Optional user-provided name for the operation
   */
  operationName?: string;

  /**
   * Parent operation ID for nested contexts
   * Undefined for root-level operations
   */
  parentId?: string;

  /**
   * Durable execution ARN for this Lambda invocation
   */
  executionArn: string;

  /**
   * Timestamp when the operation started
   */
  timestamp: Date;

  /**
   * Whether this operation is executing in replay mode
   * In replay mode, the operation returns a cached result without executing
   */
  isReplay: boolean;

  /**
   * The execution mode for this operation
   * - REPLAY: Operation is replaying from history
   * - EXECUTION: Operation is executing for the first time
   */
  executionMode: "REPLAY" | "EXECUTION";

  /**
   * Request ID for this Lambda invocation
   */
  requestId: string;

  /**
   * Hierarchy depth in nested contexts (0 for root)
   */
  depth: number;

  /**
   * Full path to this operation in the execution tree
   * Format: "1.2.3" for operation 3 in context 2 in operation 1
   */
  path: string;

  /**
   * Mutable metadata storage for plugins to share data between hooks
   * Each plugin should namespace its metadata using its name as a key
   *
   * @example
   * ```typescript
   * onOperationStart: async (context) => {
   *   context.metadata['my-plugin'] = { startTime: Date.now() };
   * }
   * ```
   */
  metadata: Record<string, unknown>;
}
