# Plugin Development Guide

## Quick Start

### Creating Your First Plugin

```typescript
import { DurablePlugin, OperationContext } from "@aws/durable-execution-sdk-js";

const myFirstPlugin: DurablePlugin = {
  name: "my-first-plugin",
  version: "1.0.0",

  onOperationStart: async (context: OperationContext) => {
    console.log(`Starting ${context.operationType} operation`);
  },

  onOperationSuccess: async (context: OperationContext, result: unknown) => {
    console.log(`Operation ${context.operationId} succeeded`);
  },

  onOperationError: async (context: OperationContext, error: Error) => {
    console.error(`Operation ${context.operationId} failed:`, error.message);
  },

  onOperationComplete: async (context: OperationContext) => {
    console.log(`Operation ${context.operationId} completed`);
  },
};

export default myFirstPlugin;
```

### Using Your Plugin

```typescript
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import myFirstPlugin from "./my-first-plugin";

export const handler = withDurableExecution(
  async (event, context) => {
    const result = await context.step("process", async () => {
      return "Hello, World!";
    });
    return result;
  },
  {
    plugins: [myFirstPlugin],
  },
);
```

## Plugin Interface

### Core Interface

```typescript
interface DurablePlugin {
  /**
   * Unique plugin identifier
   */
  name: string;

  /**
   * Plugin version (semver recommended)
   */
  version?: string;

  /**
   * Called before operation execution
   * @param context - Operation context with metadata
   */
  onOperationStart?(context: OperationContext): void | Promise<void>;

  /**
   * Called after successful operation execution
   * @param context - Operation context
   * @param result - Operation result
   */
  onOperationSuccess?(
    context: OperationContext,
    result: unknown,
  ): void | Promise<void>;

  /**
   * Called when operation throws an error
   * @param context - Operation context
   * @param error - Error thrown by operation
   */
  onOperationError?(
    context: OperationContext,
    error: Error,
  ): void | Promise<void>;

  /**
   * Always called after operation (success or error)
   * @param context - Operation context
   */
  onOperationComplete?(context: OperationContext): void | Promise<void>;
}
```

### Operation Context

```typescript
interface OperationContext {
  /**
   * Type of durable operation (STEP, INVOKE, WAIT, etc.)
   */
  operationType: OperationType;

  /**
   * Unique identifier for this operation instance
   */
  operationId: string;

  /**
   * Optional operation name provided by user
   */
  operationName?: string;

  /**
   * Parent operation ID (for nested contexts)
   */
  parentId?: string;

  /**
   * Durable execution ARN
   */
  executionArn: string;

  /**
   * Operation start timestamp
   */
  timestamp: Date;

  /**
   * Mutable metadata storage for plugins
   * Use this to share data between hooks
   */
  metadata: Record<string, unknown>;
}

enum OperationType {
  STEP = "STEP",
  INVOKE = "INVOKE",
  WAIT = "WAIT",
  WAIT_FOR_CONDITION = "WAIT_FOR_CONDITION",
  CALLBACK = "CALLBACK",
  WAIT_FOR_CALLBACK = "WAIT_FOR_CALLBACK",
  CHILD_CONTEXT = "CHILD_CONTEXT",
  MAP = "MAP",
  PARALLEL = "PARALLEL",
}
```

## Hook Lifecycle

### Execution Order

1. **onOperationStart** - Before operation begins
2. **[Operation Executes]**
3. **onOperationSuccess** - If operation succeeds (before onComplete)
4. **onOperationError** - If operation fails (before onComplete)
5. **onOperationComplete** - Always executes last

### Example: Timing Plugin

```typescript
const timingPlugin: DurablePlugin = {
  name: "timing",

  onOperationStart: async (context) => {
    // Store start time in metadata
    context.metadata.startTime = Date.now();
  },

  onOperationComplete: async (context) => {
    // Calculate duration
    const startTime = context.metadata.startTime as number;
    const duration = Date.now() - startTime;
    console.log(`${context.operationType} took ${duration}ms`);
  },
};
```

## Common Patterns

### 1. Distributed Tracing Plugin

```typescript
import { trace, context as otelContext } from "@opentelemetry/api";

const tracingPlugin: DurablePlugin = {
  name: "otel-tracing",
  version: "1.0.0",

  onOperationStart: async (context) => {
    const tracer = trace.getTracer("durable-execution");
    const span = tracer.startSpan(context.operationType, {
      attributes: {
        "operation.id": context.operationId,
        "operation.name": context.operationName || "unnamed",
        "execution.arn": context.executionArn,
      },
    });

    // Store span for later use
    context.metadata.span = span;
    context.metadata.otelContext = otelContext.active();
  },

  onOperationSuccess: async (context, result) => {
    const span = context.metadata.span as any;
    if (span) {
      span.setStatus({ code: 0 }); // OK
      span.setAttribute("result.type", typeof result);
    }
  },

  onOperationError: async (context, error) => {
    const span = context.metadata.span as any;
    if (span) {
      span.setStatus({ code: 2, message: error.message }); // ERROR
      span.recordException(error);
    }
  },

  onOperationComplete: async (context) => {
    const span = context.metadata.span as any;
    if (span) {
      span.end();
    }
  },
};

export default tracingPlugin;
```

### 2. Metrics Collection Plugin

```typescript
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";

const cloudwatch = new CloudWatchClient({});

const metricsPlugin: DurablePlugin = {
  name: "cloudwatch-metrics",
  version: "1.0.0",

  onOperationStart: async (context) => {
    context.metadata.startTime = Date.now();

    // Count operation starts
    await cloudwatch.send(
      new PutMetricDataCommand({
        Namespace: "DurableExecution",
        MetricData: [
          {
            MetricName: "OperationStarted",
            Value: 1,
            Unit: "Count",
            Dimensions: [
              { Name: "OperationType", Value: context.operationType },
            ],
          },
        ],
      }),
    );
  },

  onOperationSuccess: async (context) => {
    const duration = Date.now() - (context.metadata.startTime as number);

    await cloudwatch.send(
      new PutMetricDataCommand({
        Namespace: "DurableExecution",
        MetricData: [
          {
            MetricName: "OperationDuration",
            Value: duration,
            Unit: "Milliseconds",
            Dimensions: [
              { Name: "OperationType", Value: context.operationType },
              { Name: "Status", Value: "Success" },
            ],
          },
          {
            MetricName: "OperationSuccess",
            Value: 1,
            Unit: "Count",
            Dimensions: [
              { Name: "OperationType", Value: context.operationType },
            ],
          },
        ],
      }),
    );
  },

  onOperationError: async (context, error) => {
    const duration = Date.now() - (context.metadata.startTime as number);

    await cloudwatch.send(
      new PutMetricDataCommand({
        Namespace: "DurableExecution",
        MetricData: [
          {
            MetricName: "OperationDuration",
            Value: duration,
            Unit: "Milliseconds",
            Dimensions: [
              { Name: "OperationType", Value: context.operationType },
              { Name: "Status", Value: "Error" },
            ],
          },
          {
            MetricName: "OperationError",
            Value: 1,
            Unit: "Count",
            Dimensions: [
              { Name: "OperationType", Value: context.operationType },
              { Name: "ErrorType", Value: error.name },
            ],
          },
        ],
      }),
    );
  },
};

export default metricsPlugin;
```

### 3. Structured Logging Plugin

```typescript
import { Logger } from "@aws-lambda-powertools/logger";

const logger = new Logger({ serviceName: "durable-execution" });

const structuredLoggingPlugin: DurablePlugin = {
  name: "powertools-logging",
  version: "1.0.0",

  onOperationStart: async (context) => {
    logger.addContext({
      operationId: context.operationId,
      operationType: context.operationType,
      executionArn: context.executionArn,
    });

    logger.info("Operation started", {
      operationName: context.operationName,
      parentId: context.parentId,
    });
  },

  onOperationSuccess: async (context, result) => {
    logger.info("Operation succeeded", {
      operationId: context.operationId,
      resultType: typeof result,
    });
  },

  onOperationError: async (context, error) => {
    logger.error("Operation failed", {
      operationId: context.operationId,
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
    });
  },

  onOperationComplete: async (context) => {
    logger.removeKeys(["operationId", "operationType"]);
  },
};

export default structuredLoggingPlugin;
```

### 4. Audit Trail Plugin

```typescript
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

const dynamodb = new DynamoDBClient({});
const AUDIT_TABLE = process.env.AUDIT_TABLE_NAME!;

const auditPlugin: DurablePlugin = {
  name: "audit-trail",
  version: "1.0.0",

  onOperationStart: async (context) => {
    await dynamodb.send(
      new PutItemCommand({
        TableName: AUDIT_TABLE,
        Item: {
          pk: { S: `EXECUTION#${context.executionArn}` },
          sk: {
            S: `OP#${context.timestamp.toISOString()}#${context.operationId}`,
          },
          operationType: { S: context.operationType },
          operationId: { S: context.operationId },
          operationName: { S: context.operationName || "unnamed" },
          status: { S: "STARTED" },
          timestamp: { S: context.timestamp.toISOString() },
        },
      }),
    );
  },

  onOperationSuccess: async (context, result) => {
    await dynamodb.send(
      new PutItemCommand({
        TableName: AUDIT_TABLE,
        Item: {
          pk: { S: `EXECUTION#${context.executionArn}` },
          sk: { S: `OP#${new Date().toISOString()}#${context.operationId}` },
          operationType: { S: context.operationType },
          operationId: { S: context.operationId },
          status: { S: "SUCCESS" },
          timestamp: { S: new Date().toISOString() },
        },
      }),
    );
  },

  onOperationError: async (context, error) => {
    await dynamodb.send(
      new PutItemCommand({
        TableName: AUDIT_TABLE,
        Item: {
          pk: { S: `EXECUTION#${context.executionArn}` },
          sk: { S: `OP#${new Date().toISOString()}#${context.operationId}` },
          operationType: { S: context.operationType },
          operationId: { S: context.operationId },
          status: { S: "ERROR" },
          errorMessage: { S: error.message },
          timestamp: { S: new Date().toISOString() },
        },
      }),
    );
  },
};

export default auditPlugin;
```

### 5. Custom X-Ray Tracing

```typescript
import * as AWSXRay from "aws-xray-sdk-core";

const xrayPlugin: DurablePlugin = {
  name: "xray-tracing",
  version: "1.0.0",

  onOperationStart: async (context) => {
    const segment = AWSXRay.getSegment();
    const subsegment = segment?.addNewSubsegment(context.operationType);

    if (subsegment) {
      subsegment.addAnnotation("operationId", context.operationId);
      subsegment.addAnnotation("operationType", context.operationType);
      if (context.operationName) {
        subsegment.addAnnotation("operationName", context.operationName);
      }

      context.metadata.xraySubsegment = subsegment;
    }
  },

  onOperationSuccess: async (context, result) => {
    const subsegment = context.metadata.xraySubsegment as any;
    if (subsegment) {
      subsegment.addMetadata("result", { type: typeof result });
    }
  },

  onOperationError: async (context, error) => {
    const subsegment = context.metadata.xraySubsegment as any;
    if (subsegment) {
      subsegment.addError(error);
    }
  },

  onOperationComplete: async (context) => {
    const subsegment = context.metadata.xraySubsegment as any;
    if (subsegment) {
      subsegment.close();
    }
  },
};

export default xrayPlugin;
```

## Best Practices

### 1. Error Handling

Always handle errors gracefully in your plugins:

```typescript
const safePlugin: DurablePlugin = {
  name: "safe-plugin",

  onOperationStart: async (context) => {
    try {
      // Your plugin logic
      await riskyOperation();
    } catch (error) {
      // Log error but don't throw
      console.error("Plugin error:", error);
    }
  },
};
```

### 2. Performance

Minimize latency in plugin hooks:

```typescript
const performantPlugin: DurablePlugin = {
  name: "performant-plugin",

  onOperationStart: async (context) => {
    // Fire and forget for non-critical operations
    void sendMetricsAsync(context).catch(console.error);

    // Or use batching
    metricsBatch.add(context);
  },
};
```

### 3. State Management

Use context.metadata for hook-to-hook state:

```typescript
const statefulPlugin: DurablePlugin = {
  name: "stateful-plugin",

  onOperationStart: async (context) => {
    context.metadata.pluginState = {
      startTime: Date.now(),
      requestId: generateId(),
    };
  },

  onOperationComplete: async (context) => {
    const state = context.metadata.pluginState as any;
    // Use state from onOperationStart
  },
};
```

### 4. Type Safety

Use TypeScript for better type safety:

```typescript
interface MyPluginMetadata {
  startTime: number;
  traceId: string;
}

const typeSafePlugin: DurablePlugin = {
  name: "type-safe-plugin",

  onOperationStart: async (context) => {
    const metadata: MyPluginMetadata = {
      startTime: Date.now(),
      traceId: generateTraceId(),
    };
    context.metadata.myPlugin = metadata;
  },

  onOperationComplete: async (context) => {
    const metadata = context.metadata.myPlugin as MyPluginMetadata;
    const duration = Date.now() - metadata.startTime;
    console.log(`Trace ${metadata.traceId} took ${duration}ms`);
  },
};
```

### 5. Testing

Test your plugins thoroughly:

```typescript
import { describe, it, expect, jest } from "@jest/globals";

describe("MyPlugin", () => {
  it("should track operation timing", async () => {
    const plugin = myTimingPlugin;
    const context: OperationContext = {
      operationType: "STEP",
      operationId: "1",
      executionArn: "arn:...",
      timestamp: new Date(),
      metadata: {},
    };

    await plugin.onOperationStart?.(context);

    // Simulate operation
    await new Promise((resolve) => setTimeout(resolve, 100));

    await plugin.onOperationComplete?.(context);

    expect(context.metadata.duration).toBeGreaterThanOrEqual(100);
  });
});
```

## Plugin Configuration

### Environment-Based Configuration

```typescript
interface PluginConfig {
  enabled: boolean;
  logLevel?: string;
  endpoint?: string;
}

function createPlugin(config: PluginConfig): DurablePlugin {
  if (!config.enabled) {
    // Return no-op plugin
    return { name: "disabled-plugin" };
  }

  return {
    name: "configurable-plugin",
    onOperationStart: async (context) => {
      // Use config
      if (config.logLevel === "debug") {
        console.debug("Operation starting", context);
      }
    },
  };
}

// Usage
const plugin = createPlugin({
  enabled: process.env.ENABLE_PLUGIN === "true",
  logLevel: process.env.LOG_LEVEL,
  endpoint: process.env.METRICS_ENDPOINT,
});
```

### Plugin Factory Pattern

```typescript
interface MetricsPluginOptions {
  namespace: string;
  sampleRate?: number;
}

function createMetricsPlugin(options: MetricsPluginOptions): DurablePlugin {
  const sampleRate = options.sampleRate || 1.0;

  return {
    name: "metrics-plugin",
    onOperationStart: async (context) => {
      // Sample based on rate
      if (Math.random() > sampleRate) return;

      // Send metric
      await sendMetric(options.namespace, context);
    },
  };
}

// Usage
const metricsPlugin = createMetricsPlugin({
  namespace: "MyApp/DurableExecution",
  sampleRate: 0.1, // Sample 10% of operations
});
```

## Advanced Patterns

### Conditional Plugin Execution

```typescript
const conditionalPlugin: DurablePlugin = {
  name: "conditional-plugin",

  onOperationStart: async (context) => {
    // Only trace specific operation types
    if (
      context.operationType === "STEP" ||
      context.operationType === "INVOKE"
    ) {
      await startTracing(context);
    }
  },
};
```

### Plugin Composition

```typescript
function composePlugins(...plugins: DurablePlugin[]): DurablePlugin {
  return {
    name: "composed-plugin",

    onOperationStart: async (context) => {
      for (const plugin of plugins) {
        await plugin.onOperationStart?.(context);
      }
    },

    onOperationSuccess: async (context, result) => {
      for (const plugin of plugins) {
        await plugin.onOperationSuccess?.(context, result);
      }
    },

    // ... other hooks
  };
}

// Usage
const composedPlugin = composePlugins(
  loggingPlugin,
  metricsPlugin,
  tracingPlugin,
);
```

### Async Initialization

```typescript
class AsyncPlugin implements DurablePlugin {
  name = "async-plugin";
  private client?: SomeClient;

  async initialize() {
    this.client = await createClient();
  }

  async onOperationStart(context: OperationContext) {
    if (!this.client) {
      await this.initialize();
    }
    await this.client.track(context);
  }
}

// Usage
const plugin = new AsyncPlugin();
await plugin.initialize(); // Initialize before use
```

## Debugging Plugins

### Debug Logging

```typescript
const DEBUG = process.env.DEBUG_PLUGINS === "true";

const debugPlugin: DurablePlugin = {
  name: "debug-plugin",

  onOperationStart: async (context) => {
    if (DEBUG) {
      console.log("[DEBUG] Operation Start:", JSON.stringify(context, null, 2));
    }
  },
};
```

### Plugin Inspector

```typescript
const inspectorPlugin: DurablePlugin = {
  name: "plugin-inspector",

  onOperationStart: async (context) => {
    console.log("=== Plugin Hook: onOperationStart ===");
    console.log("Operation Type:", context.operationType);
    console.log("Operation ID:", context.operationId);
    console.log("Timestamp:", context.timestamp);
    console.log("Metadata:", context.metadata);
  },

  onOperationSuccess: async (context, result) => {
    console.log("=== Plugin Hook: onOperationSuccess ===");
    console.log("Result Type:", typeof result);
    console.log("Result Value:", result);
  },

  onOperationError: async (context, error) => {
    console.log("=== Plugin Hook: onOperationError ===");
    console.log("Error:", error);
  },

  onOperationComplete: async (context) => {
    console.log("=== Plugin Hook: onOperationComplete ===");
    console.log("Final Metadata:", context.metadata);
  },
};
```

## Common Pitfalls

### ❌ Don't: Modify Operation Results

```typescript
// BAD - Don't try to modify results
const badPlugin: DurablePlugin = {
  name: "bad-plugin",
  onOperationSuccess: async (context, result) => {
    (result as any).modified = true; // Don't do this!
  },
};
```

### ❌ Don't: Throw Errors

```typescript
// BAD - Don't throw errors from hooks
const badPlugin: DurablePlugin = {
  name: "bad-plugin",
  onOperationStart: async (context) => {
    if (!config.apiKey) {
      throw new Error("API key required"); // Don't do this!
    }
  },
};
```

### ✅ Do: Handle Errors Gracefully

```typescript
// GOOD - Handle errors internally
const goodPlugin: DurablePlugin = {
  name: "good-plugin",
  onOperationStart: async (context) => {
    try {
      if (!config.apiKey) {
        console.warn("API key not configured, skipping tracking");
        return;
      }
      await sendTracking(context);
    } catch (error) {
      console.error("Failed to send tracking:", error);
    }
  },
};
```

## Publishing Your Plugin

### Package Structure

```
my-durable-plugin/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   └── plugin.ts
├── dist/
│   ├── index.js
│   └── index.d.ts
├── README.md
└── examples/
    └── usage.ts
```

### package.json

```json
{
  "name": "@myorg/durable-execution-plugin-example",
  "version": "1.0.0",
  "description": "Example plugin for AWS Durable Execution SDK",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "peerDependencies": {
    "@aws/durable-execution-sdk-js": "^1.0.0"
  },
  "keywords": ["aws", "durable-execution", "plugin", "observability"]
}
```

### Documentation

Include comprehensive documentation:

- Installation instructions
- Configuration options
- Usage examples
- Troubleshooting guide

## Support and Resources

- [SDK Documentation](../api-reference/index.md)
- [Example Plugins](../../packages/aws-durable-execution-sdk-js-examples/src/plugins/)
- [GitHub Issues](https://github.com/RaphaelManke/aws-durable-execution-sdk-js/issues)
