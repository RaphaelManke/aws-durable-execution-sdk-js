# Plugin Architecture Design

## Overview

The AWS Durable Execution SDK Plugin Architecture enables extension of the SDK's functionality without modifying core code. This design uses an **Interceptor Pattern** to provide lifecycle hooks for all durable operations.

## Goals

1. **Extensibility**: Allow developers to add custom functionality (observability, logging, metrics, etc.)
2. **Non-Breaking**: Maintain backward compatibility with existing code
3. **Type Safety**: Preserve TypeScript type safety throughout the plugin system
4. **Performance**: Minimal overhead when no plugins are registered
5. **Composability**: Support multiple plugins working together

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     User Application                         │
│  const context = await withDurableExecution(handler, {      │
│    plugins: [otelPlugin, loggingPlugin]                     │
│  });                                                         │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                   DurableContext                             │
│  - step()    - invoke()    - wait()                         │
│  - map()     - parallel()  - runInChildContext()            │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                 PluginManager                                │
│  - registerPlugin(plugin)                                    │
│  - executeHooks(hookType, context, operation)               │
└─────────────────────┬───────────────────────────────────────┘
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
   ┌────────┐   ┌────────┐   ┌────────┐
   │Plugin 1│   │Plugin 2│   │Plugin 3│
   └────────┘   └────────┘   └────────┘
```

## Core Components

### 1. Plugin Interface

```typescript
interface DurablePlugin {
  name: string;
  version?: string;

  // Lifecycle hooks
  onOperationStart?(context: OperationContext): void | Promise<void>;
  onOperationSuccess?(
    context: OperationContext,
    result: unknown,
  ): void | Promise<void>;
  onOperationError?(
    context: OperationContext,
    error: Error,
  ): void | Promise<void>;
  onOperationComplete?(context: OperationContext): void | Promise<void>;
}

interface OperationContext {
  operationType: OperationType;
  operationId: string;
  operationName?: string;
  parentId?: string;
  executionArn: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}
```

### 2. Plugin Manager

The PluginManager orchestrates plugin execution:

```typescript
class PluginManager {
  private plugins: DurablePlugin[] = [];

  registerPlugin(plugin: DurablePlugin): void;
  unregisterPlugin(pluginName: string): void;

  async executeOnOperationStart(context: OperationContext): Promise<void>;
  async executeOnOperationSuccess(
    context: OperationContext,
    result: unknown,
  ): Promise<void>;
  async executeOnOperationError(
    context: OperationContext,
    error: Error,
  ): Promise<void>;
  async executeOnOperationComplete(context: OperationContext): Promise<void>;
}
```

### 3. Operation Interceptor

Each operation handler is wrapped with an interceptor:

```typescript
function withPluginInterceptor<T>(
  operation: () => Promise<T>,
  context: OperationContext,
  pluginManager: PluginManager,
): Promise<T> {
  return async () => {
    await pluginManager.executeOnOperationStart(context);

    try {
      const result = await operation();
      await pluginManager.executeOnOperationSuccess(context, result);
      return result;
    } catch (error) {
      await pluginManager.executeOnOperationError(context, error);
      throw error;
    } finally {
      await pluginManager.executeOnOperationComplete(context);
    }
  };
}
```

## Supported Operations

All durable execution operations support plugins:

1. **step** - Execute a durable step with retry
2. **invoke** - Invoke another durable function
3. **runInChildContext** - Execute in isolated child context
4. **wait** - Pause execution for duration
5. **waitForCondition** - Wait for condition to be met
6. **createCallback** - Create external callback
7. **waitForCallback** - Wait for external callback
8. **map** - Process items with durable operations
9. **parallel** - Execute branches in parallel

## Configuration

Plugins are configured when creating the durable execution handler:

```typescript
export const handler = withDurableExecution(
  async (event, context) => {
    // Your durable function logic
  },
  {
    plugins: [otelTracingPlugin, metricsPlugin, customLoggingPlugin],
  },
);
```

## Plugin Execution Order

1. Plugins are executed in registration order
2. `onOperationStart` hooks execute before the operation
3. `onOperationSuccess` hooks execute after successful completion
4. `onOperationError` hooks execute on error (before rethrowing)
5. `onOperationComplete` hooks always execute (success or error)

## Error Handling

- Plugin errors are logged but do not affect operation execution
- If a plugin hook throws, it's caught and logged
- Operation continues even if plugin fails (fail-safe)
- Critical plugin errors can be configured to terminate execution

## Performance Considerations

1. **Zero-cost when disabled**: If no plugins registered, minimal overhead
2. **Async hooks**: Plugin hooks are async to support I/O operations
3. **Parallel execution**: Independent plugins can execute concurrently
4. **Lazy initialization**: Plugins initialized only when needed

## Example Use Cases

### 1. OpenTelemetry Tracing

```typescript
const otelPlugin: DurablePlugin = {
  name: "otel-tracing",
  onOperationStart: async (ctx) => {
    const span = tracer.startSpan(ctx.operationType, {
      attributes: {
        "operation.id": ctx.operationId,
        "execution.arn": ctx.executionArn,
      },
    });
    ctx.metadata!.span = span;
  },
  onOperationComplete: async (ctx) => {
    const span = ctx.metadata?.span;
    span?.end();
  },
};
```

### 2. Custom Metrics

```typescript
const metricsPlugin: DurablePlugin = {
  name: "cloudwatch-metrics",
  onOperationStart: async (ctx) => {
    ctx.metadata!.startTime = Date.now();
  },
  onOperationSuccess: async (ctx) => {
    const duration = Date.now() - ctx.metadata!.startTime;
    await cloudwatch.putMetric({
      MetricName: "OperationDuration",
      Value: duration,
      Dimensions: [{ Name: "OperationType", Value: ctx.operationType }],
    });
  },
};
```

### 3. Custom Logging

```typescript
const loggingPlugin: DurablePlugin = {
  name: "structured-logging",
  onOperationStart: async (ctx) => {
    logger.info("Operation started", {
      operationType: ctx.operationType,
      operationId: ctx.operationId,
      executionArn: ctx.executionArn,
    });
  },
  onOperationError: async (ctx, error) => {
    logger.error("Operation failed", {
      operationType: ctx.operationType,
      operationId: ctx.operationId,
      error: error.message,
    });
  },
};
```

## Migration Path

For existing code:

1. No changes required - plugins are opt-in
2. Add plugins to configuration when ready
3. Plugins work alongside existing functionality

## Security Considerations

1. Plugins execute in the same process as the durable function
2. Plugins have access to operation context but not sensitive data by default
3. Plugin code should be reviewed for security issues
4. Plugins should not modify operation inputs/outputs
5. Consider sandboxing for third-party plugins

## Future Enhancements

1. **Plugin Context Injection**: Allow plugins to add context to operations
2. **Conditional Execution**: Support enabling/disabling plugins based on conditions
3. **Plugin Dependencies**: Support dependencies between plugins
4. **Plugin Registry**: Central registry for discovering plugins
5. **Performance Monitoring**: Built-in plugin performance tracking

## Decision Log

### Why Interceptor Pattern over Middleware?

- **Type Safety**: Maintains operation signatures
- **Clarity**: Clear separation between core logic and plugins
- **Performance**: Less overhead than middleware chain
- **Compatibility**: Easier to integrate with existing code

### Why Async Hooks?

- **Flexibility**: Supports I/O operations (metrics, logging, tracing)
- **Non-blocking**: Doesn't block operation execution unnecessarily
- **Future-proof**: Allows for complex plugin logic

### Why Fail-Safe Error Handling?

- **Reliability**: Operation execution shouldn't fail due to plugin errors
- **Debugging**: Plugin errors are logged for debugging
- **Production**: Safer for production environments
