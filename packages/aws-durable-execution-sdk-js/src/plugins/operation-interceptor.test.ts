import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  withPluginInterceptor,
  withDurablePluginInterceptor,
  OperationInfo,
} from "./operation-interceptor";
import { PluginManager } from "./plugin-manager";
import { DurablePlugin } from "./types";
import { OperationType } from "@aws-sdk/client-lambda";

describe("Operation Interceptor", () => {
  let pluginManager: PluginManager;

  beforeEach(() => {
    pluginManager = new PluginManager();
  });

  const createMockOperationInfo = (): OperationInfo => ({
    operationType: OperationType.STEP,
    operationId: "1",
    operationName: "test-operation",
    executionArn: "arn:aws:lambda:us-east-1:123456789012:function:test",
    requestId: "test-request-id",
    isReplay: false,
    executionMode: "EXECUTION",
    depth: 0,
    path: "1",
  });

  describe("withPluginInterceptor", () => {
    it("should execute operation and call hooks in order", async () => {
      const callOrder: string[] = [];

      const plugin: DurablePlugin = {
        name: "test-plugin",
        onOperationStart: async () => {
          callOrder.push("start");
        },
        onOperationSuccess: async () => {
          callOrder.push("success");
        },
        onOperationComplete: async () => {
          callOrder.push("complete");
        },
      };

      await pluginManager.registerPlugin(plugin);

      const operation = async () => {
        callOrder.push("operation");
        return "result";
      };

      const result = await withPluginInterceptor(
        operation,
        createMockOperationInfo(),
        pluginManager,
      );

      expect(result).toBe("result");
      expect(callOrder).toEqual(["start", "operation", "success", "complete"]);
    });

    it("should execute onOperationError when operation throws", async () => {
      const callOrder: string[] = [];
      let capturedError: Error | undefined;

      const plugin: DurablePlugin = {
        name: "test-plugin",
        onOperationStart: async () => {
          callOrder.push("start");
        },
        onOperationError: async (ctx, error) => {
          callOrder.push("error");
          capturedError = error;
        },
        onOperationComplete: async () => {
          callOrder.push("complete");
        },
      };

      await pluginManager.registerPlugin(plugin);

      const operationError = new Error("Operation failed");
      const operation = async () => {
        callOrder.push("operation");
        throw operationError;
      };

      await expect(
        withPluginInterceptor(
          operation,
          createMockOperationInfo(),
          pluginManager,
        ),
      ).rejects.toThrow("Operation failed");

      expect(callOrder).toEqual(["start", "operation", "error", "complete"]);
      expect(capturedError).toBe(operationError);
    });

    it("should not call onOperationSuccess when operation fails", async () => {
      const successHook = jest.fn();

      const plugin: DurablePlugin = {
        name: "test-plugin",
        onOperationSuccess: successHook as any,
      };

      await pluginManager.registerPlugin(plugin);

      const operation = async () => {
        throw new Error("Operation failed");
      };

      await expect(
        withPluginInterceptor(
          operation,
          createMockOperationInfo(),
          pluginManager,
        ),
      ).rejects.toThrow();

      expect(successHook).not.toHaveBeenCalled();
    });

    it("should always call onOperationComplete", async () => {
      const completeHook = jest.fn();

      const plugin: DurablePlugin = {
        name: "test-plugin",
        onOperationComplete: completeHook as any,
      };

      await pluginManager.registerPlugin(plugin);

      // Test with successful operation
      const successOperation = async () => "success";
      await withPluginInterceptor(
        successOperation,
        createMockOperationInfo(),
        pluginManager,
      );
      expect(completeHook).toHaveBeenCalledTimes(1);

      // Test with failing operation
      const failOperation = async () => {
        throw new Error("Failed");
      };
      await expect(
        withPluginInterceptor(
          failOperation,
          createMockOperationInfo(),
          pluginManager,
        ),
      ).rejects.toThrow();
      expect(completeHook).toHaveBeenCalledTimes(2);
    });

    it("should pass operation result to onOperationSuccess", async () => {
      let capturedResult: unknown;

      const plugin: DurablePlugin = {
        name: "test-plugin",
        onOperationSuccess: async (ctx, result) => {
          capturedResult = result;
        },
      };

      await pluginManager.registerPlugin(plugin);

      const expectedResult = { data: "test", count: 42 };
      const operation = async () => expectedResult;

      await withPluginInterceptor(
        operation,
        createMockOperationInfo(),
        pluginManager,
      );

      expect(capturedResult).toEqual(expectedResult);
    });

    it("should create operation context with correct data", async () => {
      let capturedContext: any;

      const plugin: DurablePlugin = {
        name: "test-plugin",
        onOperationStart: async (ctx) => {
          capturedContext = ctx;
        },
      };

      await pluginManager.registerPlugin(plugin);

      const operationInfo: OperationInfo = {
        operationType: OperationType.CHAINED_INVOKE,
        operationId: "2",
        operationName: "custom-operation",
        parentId: "1",
        executionArn: "arn:aws:lambda:us-east-1:123456789012:function:test",
        requestId: "request-123",
        isReplay: true,
        executionMode: "REPLAY",
        depth: 2,
        path: "1.2",
      };

      const operation = async () => "result";
      await withPluginInterceptor(operation, operationInfo, pluginManager);

      expect(capturedContext).toMatchObject({
        operationType: OperationType.CHAINED_INVOKE,
        operationId: "2",
        operationName: "custom-operation",
        parentId: "1",
        executionArn: "arn:aws:lambda:us-east-1:123456789012:function:test",
        requestId: "request-123",
        isReplay: true,
        executionMode: "REPLAY",
        depth: 2,
        path: "1.2",
      });
      expect(capturedContext.timestamp).toBeInstanceOf(Date);
      expect(capturedContext.metadata).toEqual({});
    });

    it("should support multiple plugins", async () => {
      const plugin1Start = jest.fn();
      const plugin2Start = jest.fn();

      await pluginManager.registerPlugin({
        name: "plugin1",
        onOperationStart: plugin1Start,
      });
      await pluginManager.registerPlugin({
        name: "plugin2",
        onOperationStart: plugin2Start,
      });

      const operation = async () => "result";
      await withPluginInterceptor(
        operation,
        createMockOperationInfo(),
        pluginManager,
      );

      expect(plugin1Start).toHaveBeenCalled();
      expect(plugin2Start).toHaveBeenCalled();
    });

    it("should handle plugin errors without affecting operation", async () => {
      const plugin: DurablePlugin = {
        name: "error-plugin",
        onOperationStart: async () => {
          throw new Error("Plugin hook failed");
        },
      };

      await pluginManager.registerPlugin(plugin);

      const operation = async () => "success";
      const result = await withPluginInterceptor(
        operation,
        createMockOperationInfo(),
        pluginManager,
      );

      // Operation should succeed despite plugin error
      expect(result).toBe("success");
    });
  });

  describe("withDurablePluginInterceptor", () => {
    it("should execute durable operation and call hooks", async () => {
      const callOrder: string[] = [];

      const plugin: DurablePlugin = {
        name: "test-plugin",
        onOperationStart: async () => {
          callOrder.push("start");
        },
        onOperationSuccess: async () => {
          callOrder.push("success");
        },
        onOperationComplete: async () => {
          callOrder.push("complete");
        },
      };

      await pluginManager.registerPlugin(plugin);

      const operation = () => {
        callOrder.push("operation");
        return Promise.resolve("result") as any; // Mock DurablePromise
      };

      const result = await withDurablePluginInterceptor(
        operation,
        createMockOperationInfo(),
        pluginManager,
      );

      expect(result).toBe("result");
      expect(callOrder).toEqual(["start", "operation", "success", "complete"]);
    });

    it("should handle durable operation errors", async () => {
      const errorHook = jest.fn();

      const plugin: DurablePlugin = {
        name: "test-plugin",
        onOperationError: errorHook as any,
      };

      await pluginManager.registerPlugin(plugin);

      const operation = () => {
        return Promise.reject(new Error("Durable operation failed")) as any;
      };

      await expect(
        withDurablePluginInterceptor(
          operation,
          createMockOperationInfo(),
          pluginManager,
        ),
      ).rejects.toThrow("Durable operation failed");

      expect(errorHook).toHaveBeenCalled();
    });
  });

  describe("metadata sharing", () => {
    it("should allow plugins to share data via metadata", async () => {
      let startMetadata: any;
      let completeMetadata: any;

      const plugin: DurablePlugin = {
        name: "test-plugin",
        onOperationStart: async (ctx) => {
          ctx.metadata.startTime = Date.now();
          ctx.metadata.pluginData = "test-data";
          startMetadata = ctx.metadata;
        },
        onOperationComplete: async (ctx) => {
          completeMetadata = ctx.metadata;
        },
      };

      await pluginManager.registerPlugin(plugin);

      const operation = async () => "result";
      await withPluginInterceptor(
        operation,
        createMockOperationInfo(),
        pluginManager,
      );

      // Metadata should be shared across hooks
      expect(completeMetadata).toBe(startMetadata);
      expect(completeMetadata.startTime).toBeDefined();
      expect(completeMetadata.pluginData).toBe("test-data");
    });
  });
});
