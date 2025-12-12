import { OperationContext } from "./operation-context";

/**
 * Plugin interface for extending AWS Durable Execution SDK functionality
 *
 * @remarks
 * Plugins can hook into the lifecycle of durable operations to add observability,
 * logging, metrics, tracing, or other cross-cutting concerns without modifying
 * the core SDK.
 *
 * All hook methods are optional and async to support I/O operations.
 * Plugin errors are caught and logged but do not affect operation execution.
 *
 * @example
 * ```typescript
 * const loggingPlugin: DurablePlugin = {
 *   name: 'logging-plugin',
 *   version: '1.0.0',
 *   onOperationStart: async (context) => {
 *     console.log(`Starting ${context.operationType} operation`);
 *   },
 *   onOperationSuccess: async (context, result) => {
 *     console.log(`Operation ${context.operationId} succeeded`);
 *   }
 * };
 * ```
 *
 * @public
 */
export interface DurablePlugin {
  /**
   * Unique plugin identifier
   * Must be unique across all registered plugins
   */
  name: string;

  /**
   * Plugin version (semver recommended)
   * Used for compatibility checking and debugging
   */
  version?: string;

  /**
   * Called once when the plugin is registered
   * Use this to initialize resources, clients, or connections
   *
   * @remarks
   * This method is called synchronously during plugin registration.
   * Any errors thrown will prevent the plugin from being registered.
   *
   * @example
   * ```typescript
   * initialize: async () => {
   *   await connectToMetricsService();
   * }
   * ```
   */
  initialize?(): Promise<void> | void;

  /**
   * Called when the execution completes or Lambda is shutting down
   * Use this to clean up resources, flush buffers, or close connections
   *
   * @remarks
   * This method is called during Lambda shutdown.
   * Errors are logged but do not prevent shutdown.
   *
   * @example
   * ```typescript
   * shutdown: async () => {
   *   await flushMetrics();
   *   await closeConnections();
   * }
   * ```
   */
  shutdown?(): Promise<void> | void;

  /**
   * Called before a durable operation begins execution
   *
   * @param context - Operation context with metadata
   *
   * @remarks
   * - Called even during replay mode (check context.isReplay)
   * - Errors are caught and logged but do not affect execution
   * - Use context.metadata to store data for later hooks
   *
   * @example
   * ```typescript
   * onOperationStart: async (context) => {
   *   if (!context.isReplay) {
   *     context.metadata.startTime = Date.now();
   *     await startTrace(context);
   *   }
   * }
   * ```
   */
  onOperationStart?(context: OperationContext): void | Promise<void>;

  /**
   * Called after a durable operation completes successfully
   *
   * @param context - Operation context
   * @param result - Result returned by the operation (type is unknown)
   *
   * @remarks
   * - Only called on successful completion
   * - Called before onOperationComplete
   * - Result is the actual return value but typed as unknown
   * - Do not modify the result
   *
   * @example
   * ```typescript
   * onOperationSuccess: async (context, result) => {
   *   const duration = Date.now() - context.metadata.startTime;
   *   await recordMetric('operation.duration', duration);
   * }
   * ```
   */
  onOperationSuccess?(
    context: OperationContext,
    result: unknown,
  ): void | Promise<void>;

  /**
   * Called when a durable operation throws an error
   *
   * @param context - Operation context
   * @param error - Error thrown by the operation
   *
   * @remarks
   * - Only called on error
   * - Called before onOperationComplete
   * - The error is rethrown after all hooks execute
   * - Cannot prevent error propagation
   *
   * @example
   * ```typescript
   * onOperationError: async (context, error) => {
   *   await logError({
   *     operationId: context.operationId,
   *     error: error.message,
   *     timestamp: new Date()
   *   });
   * }
   * ```
   */
  onOperationError?(
    context: OperationContext,
    error: Error,
  ): void | Promise<void>;

  /**
   * Always called after an operation completes (success or error)
   *
   * @param context - Operation context
   *
   * @remarks
   * - Guaranteed to execute after onOperationSuccess or onOperationError
   * - Called even if previous hooks failed
   * - Use for cleanup or finalization
   *
   * @example
   * ```typescript
   * onOperationComplete: async (context) => {
   *   const span = context.metadata.span;
   *   if (span) {
   *     span.end();
   *   }
   * }
   * ```
   */
  onOperationComplete?(context: OperationContext): void | Promise<void>;
}
