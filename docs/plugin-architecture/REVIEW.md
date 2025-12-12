# Plugin Architecture - Critical Review

## Review Date: 2025-12-12

## Strengths

### 1. Type Safety ✅

- Strong TypeScript interfaces maintain type safety
- OperationContext provides structured metadata
- Plugin interface is clear and well-defined

### 2. Non-Breaking ✅

- Opt-in via configuration
- Existing code works without changes
- Backward compatible

### 3. Fail-Safe Design ✅

- Plugin errors don't break operations
- Graceful degradation
- Suitable for production use

### 4. Extensibility ✅

- Supports multiple plugins
- Clear lifecycle hooks
- Metadata sharing between hooks

### 5. Performance Conscious ✅

- Zero-cost when disabled
- Early exit strategies
- Async execution support

## Critical Issues & Solutions

### Issue 1: Replay Mode Interaction ⚠️

**Problem:**
During replay mode, operations return cached results without executing. Plugins might still fire hooks, causing:

- Duplicate telemetry
- Incorrect metrics (counting replayed operations)
- Misleading traces

**Solution:**
Add execution mode to OperationContext:

```typescript
interface OperationContext {
  // ... existing fields
  executionMode: "REPLAY" | "EXECUTION";
  isReplay: boolean; // Convenience flag
}
```

**Implementation:**

```typescript
// Plugins can check replay mode
onOperationStart: async (context) => {
  if (context.isReplay) {
    // Skip telemetry during replay
    return;
  }
  await sendTelemetry(context);
};
```

**Decision:** ✅ IMPLEMENT - Critical for accurate observability

---

### Issue 2: Nested Context Handling ⚠️

**Problem:**
With `runInChildContext`, `map`, and `parallel`, we have nested operation contexts. The current design doesn't clearly show:

- Parent-child relationships
- Operation hierarchy
- Full execution path

**Solution:**
Enhance OperationContext with hierarchy tracking:

```typescript
interface OperationContext {
  // ... existing fields
  parentId?: string;
  rootId: string;
  depth: number;
  path: string; // e.g., "1.2.3" for operation 3 in context 2 in operation 1
}
```

**Implementation:**

```typescript
// Build execution tree for better observability
onOperationStart: async (context) => {
  const span = tracer.startSpan(context.operationType, {
    attributes: {
      "operation.path": context.path,
      "operation.depth": context.depth,
    },
  });
  if (context.parentId) {
    // Link to parent span
    span.setParentContext(getParentContext(context.parentId));
  }
};
```

**Decision:** ✅ IMPLEMENT - Important for nested context tracing

---

### Issue 3: Async Hook Error Handling 🤔

**Problem:**
Current design catches and logs plugin errors, but:

- No visibility into which plugin failed
- No plugin health tracking
- Hard to debug production issues

**Solution:**
Enhanced error handling with metrics:

```typescript
class PluginManager {
  private pluginErrors = new Map<string, number>();

  private async safeExecuteHook(
    plugin: DurablePlugin,
    hookName: string,
    ...args: unknown[]
  ): Promise<void> {
    try {
      await plugin[hookName]?.(...args);
    } catch (error) {
      // Track errors per plugin
      const errorCount = (this.pluginErrors.get(plugin.name) || 0) + 1;
      this.pluginErrors.set(plugin.name, errorCount);

      // Log with context
      console.error("Plugin hook failed", {
        pluginName: plugin.name,
        hookName,
        error: error.message,
        totalErrors: errorCount,
      });

      // Optional: Disable plugin after threshold
      if (errorCount > 10) {
        console.warn(`Disabling plugin ${plugin.name} due to repeated errors`);
        this.disablePlugin(plugin.name);
      }
    }
  }
}
```

**Decision:** ✅ IMPLEMENT - Better debugging and reliability

---

### Issue 4: Hook Execution Performance 🤔

**Problem:**
If many plugins are registered, sequential hook execution could add latency:

- 10 plugins × 5ms each = 50ms overhead per operation
- Compounds with nested operations
- May impact cold starts

**Solution:**
Parallel hook execution for independent plugins:

```typescript
class PluginManager {
  async executeOnOperationStart(context: OperationContext): Promise<void> {
    if (this.plugins.size === 0) return;

    // Execute all plugin hooks in parallel
    const promises = Array.from(this.plugins.values()).map((plugin) =>
      this.safeExecuteHook(plugin, "onOperationStart", context),
    );

    await Promise.all(promises);
  }
}
```

**Performance Testing Needed:**

- Measure overhead with 0, 1, 5, 10 plugins
- Test with slow plugins (100ms hooks)
- Verify parallel execution benefit

**Decision:** ✅ IMPLEMENT - Parallel execution with monitoring

---

### Issue 5: Plugin Initialization ⚠️

**Problem:**
Plugins may need async initialization (clients, connections):

- No lifecycle management
- Initialization happens on first use
- No graceful shutdown

**Solution:**
Add plugin lifecycle methods:

```typescript
interface DurablePlugin {
  // ... existing hooks

  /**
   * Called once when plugin is registered
   */
  initialize?(): Promise<void>;

  /**
   * Called when execution completes or Lambda terminates
   */
  shutdown?(): Promise<void>;
}
```

**Implementation:**

```typescript
class PluginManager {
  async registerPlugin(plugin: DurablePlugin): Promise<void> {
    if (plugin.initialize) {
      await plugin.initialize();
    }
    this.plugins.set(plugin.name, plugin);
  }

  async shutdownAll(): Promise<void> {
    const promises = Array.from(this.plugins.values())
      .filter((plugin) => plugin.shutdown)
      .map((plugin) => plugin.shutdown!());

    await Promise.allSettled(promises); // Don't fail if one fails
  }
}

// Call on Lambda completion
process.on("beforeExit", async () => {
  await pluginManager.shutdownAll();
});
```

**Decision:** ✅ IMPLEMENT - Essential for resource management

---

### Issue 6: Result/Input Access 🚨

**Problem:**
Current design only passes `unknown` result to `onOperationSuccess`:

- No type information
- Can't inspect operation inputs
- Limited observability value

**Should We Expose Results/Inputs?**

**Option A: Expose Both (More Observable)** ✅

```typescript
interface OperationContext {
  // ... existing
  input?: unknown;
  inputMetadata?: {
    type: string;
    size?: number;
  };
}

onOperationSuccess?(
  context: OperationContext,
  result: unknown,
  resultMetadata?: {
    type: string;
    size?: number;
  }
): void | Promise<void>;
```

**Pros:**

- Better observability (can log input/output types, sizes)
- Useful for metrics (payload size tracking)
- Enables validation plugins

**Cons:**

- Privacy concerns (plugins see all data)
- Memory overhead (storing inputs)
- Security risk (sensitive data exposure)

**Option B: Metadata Only (Safer)** 🤔
Only expose metadata, not actual values:

```typescript
onOperationSuccess?(
  context: OperationContext,
  resultInfo: { type: string; size?: number }
): void | Promise<void>;
```

**Decision:** ✅ OPTION A with opt-out

- Default: Only expose metadata (type, size)
- Config flag: `exposeData: true` for full access
- Document security implications

---

### Issue 7: Plugin Ordering 🤔

**Problem:**
Plugin execution order matters for:

- Tracing parent-child relationships
- Context propagation
- Dependency between plugins

**Solution:**
Add priority system:

```typescript
interface DurablePlugin {
  // ... existing
  priority?: number; // Higher = earlier execution (default: 0)
}

class PluginManager {
  registerPlugin(plugin: DurablePlugin): void {
    this.plugins.set(plugin.name, plugin);
    // Sort by priority
    this.sortedPlugins = Array.from(this.plugins.values()).sort(
      (a, b) => (b.priority || 0) - (a.priority || 0),
    );
  }
}
```

**Decision:** ⚠️ DEFER - Add if needed, YAGNI for MVP

---

### Issue 8: Operation Cancellation ⚠️

**Problem:**
If operation is cancelled/terminated:

- Plugins still execute onComplete
- May send incorrect metrics
- Should distinguish cancellation from error

**Solution:**
Add cancellation awareness:

```typescript
interface OperationContext {
  // ... existing
  cancelled?: boolean;
}

onOperationCancelled?(context: OperationContext): void | Promise<void>;
```

**Decision:** ⚠️ DEFER - Add when SDK supports cancellation

---

### Issue 9: Testing Support 🤔

**Problem:**
How do users test their plugins?

- Need mock OperationContext
- Need to simulate hook execution
- Need to verify plugin behavior

**Solution:**
Provide testing utilities:

```typescript
// Test utilities
export function createMockOperationContext(
  overrides?: Partial<OperationContext>,
): OperationContext {
  return {
    operationType: "STEP",
    operationId: "1",
    operationName: "test-op",
    executionArn: "arn:aws:lambda:us-east-1:123456789012:function:test",
    timestamp: new Date(),
    metadata: {},
    isReplay: false,
    executionMode: "EXECUTION",
    ...overrides,
  };
}

export class PluginTester {
  constructor(private plugin: DurablePlugin) {}

  async testOperationStart(context?: Partial<OperationContext>) {
    const ctx = createMockOperationContext(context);
    await this.plugin.onOperationStart?.(ctx);
    return ctx;
  }

  // ... other test helpers
}
```

**Decision:** ✅ IMPLEMENT - Essential for adoption

---

## Performance Analysis

### Estimated Overhead

**Scenario 1: No Plugins**

- Overhead: ~0.1ms (existence check)
- Impact: Negligible

**Scenario 2: 3 Plugins (typical)**

- Per hook: ~0.5ms overhead
- Per operation: ~2ms total (4 hooks)
- 100 operations: +200ms
- Impact: Moderate, acceptable

**Scenario 3: 10 Plugins (heavy)**

- Per hook: ~2ms overhead
- Per operation: ~8ms total
- 100 operations: +800ms
- Impact: High, may need optimization

**Mitigation:**

1. Parallel execution ✅
2. Sampling for metrics plugins
3. Async fire-and-forget for non-critical hooks
4. Plugin budget/timeout

---

## Security Analysis

### Threat Model

**Threat 1: Malicious Plugin**

- **Risk:** Plugin could leak data, DoS, or compromise execution
- **Mitigation:**
  - Document security implications
  - Recommend code review
  - Future: Plugin sandboxing

**Threat 2: Data Exposure**

- **Risk:** Plugins see operation inputs/outputs
- **Mitigation:**
  - Opt-in data exposure
  - Metadata-only by default
  - Document privacy implications

**Threat 3: Performance Attack**

- **Risk:** Slow plugin degrades performance
- **Mitigation:**
  - Timeout per hook
  - Disable on repeated errors
  - Monitor hook duration

---

## Revised Architecture Decisions

### ✅ Changes to Implement

1. **Add replay mode awareness** - Critical for observability
2. **Enhance operation context hierarchy** - Better tracing
3. **Add plugin lifecycle (init/shutdown)** - Resource management
4. **Parallel hook execution** - Performance
5. **Better error handling** - Reliability
6. **Testing utilities** - Developer experience
7. **Metadata-first result access** - Security + observability

### ⚠️ Deferred Features

1. **Plugin priority system** - YAGNI for MVP
2. **Cancellation hooks** - Wait for SDK support
3. **Plugin composition API** - Can be userland

### 🚫 Rejected Ideas

1. **Plugin transformation of inputs/outputs** - Too risky
2. **Sync hooks** - Limits plugin capabilities
3. **Plugin dependencies** - Adds complexity

---

## Final Architecture Score

| Criterion        | Score | Notes                        |
| ---------------- | ----- | ---------------------------- |
| Type Safety      | 9/10  | Strong TypeScript support    |
| Performance      | 7/10  | Good with optimizations      |
| Security         | 7/10  | Needs data exposure controls |
| Extensibility    | 9/10  | Flexible plugin system       |
| Usability        | 8/10  | Clear API, good docs         |
| Testability      | 8/10  | With test utilities          |
| Production Ready | 8/10  | With improvements            |

**Overall: 8/10** - Strong design with identified improvements

---

## Implementation Priority

### Phase 1: Core (Must Have)

1. Plugin interface & types
2. Plugin manager with basic hooks
3. Operation interceptor
4. Integration with DurableContext

### Phase 2: Reliability (Should Have)

1. Replay mode awareness
2. Plugin lifecycle (init/shutdown)
3. Enhanced error handling
4. Parallel hook execution

### Phase 3: Developer Experience (Nice to Have)

1. Testing utilities
2. Example plugins
3. Documentation
4. Plugin development guide

### Phase 4: Advanced (Future)

1. Plugin priority
2. Cancellation hooks
3. Performance monitoring
4. Plugin registry

---

## Acceptance Criteria

### Core Functionality

- [ ] Plugins can be registered via config
- [ ] All operation types support plugin hooks
- [ ] Hooks execute in correct order
- [ ] Plugin errors don't break operations
- [ ] Zero overhead when no plugins registered

### Reliability

- [ ] Replay mode properly handled
- [ ] Nested contexts tracked correctly
- [ ] Plugin errors logged and monitored
- [ ] Resource cleanup on shutdown
- [ ] No memory leaks

### Performance

- [ ] <1ms overhead with no plugins
- [ ] <5ms overhead with 3 plugins
- [ ] Parallel hook execution
- [ ] No blocking operations

### Developer Experience

- [ ] Clear plugin API documentation
- [ ] Example plugins provided
- [ ] Testing utilities available
- [ ] TypeScript types exported
- [ ] Migration guide for existing users

### Security

- [ ] Plugin data access documented
- [ ] Metadata-only by default
- [ ] Security best practices documented
- [ ] No sensitive data in logs

---

## Conclusion

The plugin architecture is **sound and implementable** with the following critical changes:

1. Add replay mode awareness
2. Implement plugin lifecycle
3. Enhance error handling
4. Parallel hook execution
5. Provide testing utilities

With these improvements, the architecture achieves:

- ✅ Non-breaking extension
- ✅ Production-ready reliability
- ✅ Good performance characteristics
- ✅ Strong developer experience

**Recommendation: PROCEED with implementation following Phase 1-3 plan**
