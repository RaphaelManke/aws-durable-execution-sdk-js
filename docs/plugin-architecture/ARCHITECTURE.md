# Plugin Architecture - Detailed Architecture

## System Architecture

### High-Level Component Diagram

```
┌────────────────────────────────────────────────────────────────────┐
│                          Application Layer                          │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  Lambda Handler with Durable Execution                       │ │
│  │  withDurableExecution(handler, { plugins: [...] })          │ │
│  └──────────────────────────────────────────────────────────────┘ │
└────────────────────────────────┬───────────────────────────────────┘
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────────┐
│                        SDK Core Layer                               │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │                   DurableContext                              │ │
│  │  ┌────────┐ ┌────────┐ ┌──────┐ ┌──────────┐ ┌─────────┐  │ │
│  │  │  step  │ │ invoke │ │ wait │ │   map    │ │parallel │  │ │
│  │  └────┬───┘ └───┬────┘ └──┬───┘ └────┬─────┘ └────┬────┘  │ │
│  └───────┼─────────┼─────────┼──────────┼───────────┼─────────┘ │
│          │         │         │          │           │            │
│          └─────────┴─────────┴──────────┴───────────┘            │
│                              │                                     │
│                              ▼                                     │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │            Operation Interceptor Wrapper                     │ │
│  │                                                              │ │
│  │    intercept(operation) {                                   │ │
│  │      → beforeOperation hooks                                │ │
│  │      → execute operation                                    │ │
│  │      → afterOperation hooks                                 │ │
│  │    }                                                        │ │
│  └──────────────────────────────────────────────────────────────┘ │
└────────────────────────────────┬───────────────────────────────────┘
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────────┐
│                        Plugin System Layer                          │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │                     Plugin Manager                           │ │
│  │                                                              │ │
│  │  • Register/Unregister plugins                              │ │
│  │  • Execute hooks in order                                   │ │
│  │  • Handle plugin errors                                     │ │
│  │  • Manage plugin lifecycle                                  │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                              │                                      │
│              ┌───────────────┼───────────────┐                     │
│              ▼               ▼               ▼                     │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐              │
│  │   Plugin 1   │ │   Plugin 2   │ │   Plugin 3   │              │
│  │              │ │              │ │              │              │
│  │ • onStart    │ │ • onStart    │ │ • onStart    │              │
│  │ • onSuccess  │ │ • onSuccess  │ │ • onSuccess  │              │
│  │ • onError    │ │ • onError    │ │ • onError    │              │
│  │ • onComplete │ │ • onComplete │ │ • onComplete │              │
│  └──────────────┘ └──────────────┘ └──────────────┘              │
└────────────────────────────────────────────────────────────────────┘
```

## Sequence Diagram - Operation with Plugins

```
User Code          DurableContext    Interceptor    PluginManager    Plugin1    Plugin2
    │                    │               │               │              │          │
    │─step("myStep")────>│               │               │              │          │
    │                    │               │               │              │          │
    │                    │─execute()────>│               │              │          │
    │                    │               │               │              │          │
    │                    │               │─onStart()────>│              │          │
    │                    │               │               │              │          │
    │                    │               │               │─hook()──────>│          │
    │                    │               │               │              │          │
    │                    │               │               │─hook()──────────────────>│
    │                    │               │               │              │          │
    │                    │               │<─complete────│              │          │
    │                    │               │               │              │          │
    │                    │               │─[execute operation]          │          │
    │                    │               │               │              │          │
    │                    │               │─onSuccess()──>│              │          │
    │                    │               │               │              │          │
    │                    │               │               │─hook()──────>│          │
    │                    │               │               │              │          │
    │                    │               │               │─hook()──────────────────>│
    │                    │               │               │              │          │
    │                    │               │<─complete────│              │          │
    │                    │               │               │              │          │
    │                    │               │─onComplete()─>│              │          │
    │                    │               │               │              │          │
    │                    │               │               │─hook()──────>│          │
    │                    │               │               │              │          │
    │                    │               │               │─hook()──────────────────>│
    │                    │               │               │              │          │
    │                    │<─result──────│               │              │          │
    │                    │               │               │              │          │
    │<─result───────────│               │               │              │          │
```

## Data Flow

### Operation Context Creation

```
Operation Invocation
       │
       ▼
Create OperationContext {
  operationType: "STEP" | "INVOKE" | "WAIT" | ...
  operationId: "1" | "1-1" | "2" | ...
  operationName?: string
  parentId?: string
  executionArn: string
  timestamp: Date
  metadata: {}  // For plugin use
}
       │
       ▼
Pass to Plugin Manager
```

### Plugin Hook Execution

```
Plugin Manager receives hook request
       │
       ▼
For each registered plugin:
  │
  ├─ Check if hook implemented
  │
  ├─ Execute hook with context
  │
  ├─ Catch and log errors
  │
  └─ Continue to next plugin
       │
       ▼
Return to operation
```

## Component Interactions

### 1. Plugin Registration

```typescript
// During withDurableExecution initialization
const durableExecution = withDurableExecution(handler, {
  plugins: [plugin1, plugin2],
});

// Plugin Manager
pluginManager = new PluginManager();
config.plugins?.forEach((plugin) => {
  pluginManager.registerPlugin(plugin);
});
```

### 2. Operation Interception

```typescript
// In DurableContextImpl methods
step<T>(...args) {
  return this.withPluginInterceptor(
    () => this.executeStep(...args),
    {
      operationType: OperationType.STEP,
      operationId: this.createStepId(),
      // ... other context
    }
  );
}
```

### 3. Hook Execution

```typescript
// In withPluginInterceptor
async withPluginInterceptor<T>(
  operation: () => Promise<T>,
  context: OperationContext
): Promise<T> {
  await this.pluginManager.executeOnOperationStart(context);

  try {
    const result = await operation();
    await this.pluginManager.executeOnOperationSuccess(context, result);
    return result;
  } catch (error) {
    await this.pluginManager.executeOnOperationError(context, error);
    throw error;
  } finally {
    await this.pluginManager.executeOnOperationComplete(context);
  }
}
```

## State Management

### Plugin Manager State

```typescript
class PluginManager {
  private plugins: Map<string, DurablePlugin> = new Map();
  private executionCache: Map<string, OperationExecution> = new Map();

  // Track active operations for nested contexts
  private activeOperations: Stack<OperationContext> = new Stack();
}
```

### Operation Context State

```typescript
interface OperationContext {
  // Immutable operation metadata
  readonly operationType: OperationType;
  readonly operationId: string;
  readonly executionArn: string;
  readonly timestamp: Date;

  // Mutable plugin data
  metadata: Record<string, unknown>;
}
```

## Error Handling Architecture

```
Plugin Hook Execution
       │
       ▼
Try Execute Hook
       │
       ├─ Success ────────────> Continue
       │
       └─ Error
          │
          ▼
       Log Error {
         pluginName,
         hookName,
         operationContext,
         error
       }
          │
          ▼
       Continue Execution
       (Fail-safe)
```

## Performance Optimization Strategies

### 1. Lazy Initialization

```typescript
class PluginManager {
  private _initialized = false;

  private ensureInitialized() {
    if (!this._initialized) {
      this.initialize();
      this._initialized = true;
    }
  }
}
```

### 2. Early Exit

```typescript
async executeOnOperationStart(context: OperationContext): Promise<void> {
  // Early exit if no plugins
  if (this.plugins.size === 0) return;

  // Execute hooks
  await this.executeHooks('onOperationStart', context);
}
```

### 3. Hook Batching

```typescript
// Execute independent plugin hooks in parallel
async executeHooks(hookName: string, ...args: unknown[]): Promise<void> {
  const promises = Array.from(this.plugins.values())
    .filter(plugin => plugin[hookName])
    .map(plugin => this.safeExecuteHook(plugin, hookName, ...args));

  await Promise.all(promises);
}
```

## Extension Points

### Future Plugin Capabilities

1. **Context Injection**

   ```typescript
   interface DurablePlugin {
     injectContext?(context: OperationContext): Record<string, unknown>;
   }
   ```

2. **Operation Transformation**

   ```typescript
   interface DurablePlugin {
     transformInput?(input: unknown): unknown;
     transformOutput?(output: unknown): unknown;
   }
   ```

3. **Conditional Execution**
   ```typescript
   interface DurablePlugin {
     shouldExecute?(context: OperationContext): boolean;
   }
   ```

## Integration Points

### 1. DurableContext Integration

```typescript
class DurableContextImpl {
  constructor(
    // ... existing params
    private pluginManager: PluginManager,
  ) {}

  private withPluginInterceptor<T>(
    operation: () => Promise<T>,
    context: OperationContext,
  ): Promise<T> {
    return this.pluginManager.intercept(operation, context);
  }
}
```

### 2. Handler Integration

```typescript
export function withDurableExecution<TEvent, TResult>(
  handler: DurableExecutionHandler<TEvent, TResult>,
  config?: DurableExecutionConfig,
): DurableLambdaHandler<TEvent, TResult> {
  // Initialize plugin manager
  const pluginManager = new PluginManager();
  config?.plugins?.forEach((plugin) => {
    pluginManager.registerPlugin(plugin);
  });

  // Pass to context creation
  // ...
}
```

## Testing Strategy

### Unit Tests

- Plugin Manager functionality
- Hook execution order
- Error handling
- Performance with/without plugins

### Integration Tests

- Multiple plugins interaction
- Real-world plugin examples (OTEL, metrics)
- Nested operations with plugins
- Plugin error scenarios

### Performance Tests

- Overhead measurement
- Scalability with multiple plugins
- Memory usage
- Latency impact

## Security Architecture

### Isolation

- Plugins execute in same process (no sandboxing initially)
- Future: Consider isolate/worker threads for untrusted plugins

### Access Control

- Plugins receive read-only operation context
- Metadata object is mutable but isolated per operation
- No direct access to internal SDK state

### Audit Trail

- All plugin actions logged
- Operation context includes plugin metadata
- Failed plugin hooks recorded

## Deployment Considerations

### Package Structure

```
@aws/durable-execution-sdk-js
├── core (existing functionality)
├── plugins
│   ├── types
│   ├── manager
│   └── interceptor
└── examples
    └── plugins
        ├── otel-tracing
        ├── cloudwatch-metrics
        └── custom-logging
```

### Versioning

- Plugin API version tracked
- Breaking changes require major version bump
- Backward compatibility maintained

### Documentation

- Plugin development guide
- Example plugins repository
- API reference
- Migration guide
