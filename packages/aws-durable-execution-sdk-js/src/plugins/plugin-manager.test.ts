import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { PluginManager } from "./plugin-manager";
import { DurablePlugin, OperationContext } from "./types";
import { OperationType } from "@aws-sdk/client-lambda";

describe("PluginManager", () => {
  let pluginManager: PluginManager;

  beforeEach(() => {
    pluginManager = new PluginManager();
  });

  const createMockContext = (): OperationContext => ({
    operationType: OperationType.STEP,
    operationId: "1",
    operationName: "test-operation",
    executionArn: "arn:aws:lambda:us-east-1:123456789012:function:test",
    timestamp: new Date(),
    isReplay: false,
    executionMode: "EXECUTION",
    requestId: "test-request-id",
    depth: 0,
    path: "1",
    metadata: {},
  });

  describe("registerPlugin", () => {
    it("should register a plugin successfully", async () => {
      const plugin: DurablePlugin = {
        name: "test-plugin",
        version: "1.0.0",
      };

      await pluginManager.registerPlugin(plugin);

      expect(pluginManager.getPlugin("test-plugin")).toBe(plugin);
      expect(pluginManager.getPlugins()).toHaveLength(1);
    });

    it("should call initialize on plugin registration", async () => {
      const initializeMock = jest.fn<() => Promise<void>>();
      const plugin: DurablePlugin = {
        name: "test-plugin",
        initialize: initializeMock,
      };

      await pluginManager.registerPlugin(plugin);

      expect(initializeMock).toHaveBeenCalledTimes(1);
    });

    it("should throw error if plugin with same name already registered", async () => {
      const plugin1: DurablePlugin = { name: "test-plugin" };
      const plugin2: DurablePlugin = { name: "test-plugin" };

      await pluginManager.registerPlugin(plugin1);

      await expect(pluginManager.registerPlugin(plugin2)).rejects.toThrow(
        "Plugin 'test-plugin' is already registered",
      );
    });

    it("should throw error if plugin initialization fails", async () => {
      const plugin: DurablePlugin = {
        name: "test-plugin",
        initialize: async () => {
          throw new Error("Init failed");
        },
      };

      await expect(pluginManager.registerPlugin(plugin)).rejects.toThrow(
        "Init failed",
      );
      expect(pluginManager.getPlugin("test-plugin")).toBeUndefined();
    });
  });

  describe("unregisterPlugin", () => {
    it("should unregister a plugin", async () => {
      const plugin: DurablePlugin = { name: "test-plugin" };
      await pluginManager.registerPlugin(plugin);

      const result = pluginManager.unregisterPlugin("test-plugin");

      expect(result).toBe(true);
      expect(pluginManager.getPlugin("test-plugin")).toBeUndefined();
    });

    it("should return false if plugin not found", () => {
      const result = pluginManager.unregisterPlugin("non-existent");
      expect(result).toBe(false);
    });
  });

  describe("executeOnOperationStart", () => {
    it("should execute onOperationStart for all plugins", async () => {
      const hook1 = jest.fn<(context: any) => Promise<void>>();
      const hook2 = jest.fn<(context: any) => Promise<void>>();

      await pluginManager.registerPlugin({
        name: "plugin1",
        onOperationStart: hook as any1 as any,
      });
      await pluginManager.registerPlugin({
        name: "plugin2",
        onOperationStart: hook as any2 as any,
      });

      const context = createMockContext();
      await pluginManager.executeOnOperationStart(context);

      expect(hook1).toHaveBeenCalledWith(context);
      expect(hook2).toHaveBeenCalledWith(context);
    });

    it("should do nothing if no plugins registered", async () => {
      const context = createMockContext();
      await expect(
        pluginManager.executeOnOperationStart(context),
      ).resolves.not.toThrow();
    });

    it("should continue if plugin hook throws error", async () => {
      const hook1 = jest.fn().mockRejectedValue(new Error("Hook failed"));
      const hook2 = jest.fn();

      await pluginManager.registerPlugin({
        name: "plugin1",
        onOperationStart: hook as any1 as any,
      });
      await pluginManager.registerPlugin({
        name: "plugin2",
        onOperationStart: hook as any2 as any,
      });

      const context = createMockContext();
      await pluginManager.executeOnOperationStart(context);

      expect(hook1).toHaveBeenCalled();
      expect(hook2).toHaveBeenCalled();
    });

    it("should track plugin errors", async () => {
      const hook = jest.fn().mockRejectedValue(new Error("Hook failed"));

      await pluginManager.registerPlugin({
        name: "error-plugin",
        onOperationStart: hook as any,
      });

      const context = createMockContext();
      await pluginManager.executeOnOperationStart(context);

      const errorStats = pluginManager.getErrorStats();
      expect(errorStats.get("error-plugin")).toBe(1);
    });

    it("should disable plugin after error threshold", async () => {
      const hook = jest.fn().mockRejectedValue(new Error("Hook failed"));

      await pluginManager.registerPlugin({
        name: "error-plugin",
        onOperationStart: hook as any,
      });

      const context = createMockContext();

      // Execute 11 times to exceed threshold (10)
      for (let i = 0; i < 11; i++) {
        await pluginManager.executeOnOperationStart(context);
      }

      const disabledPlugins = pluginManager.getDisabledPlugins();
      expect(disabledPlugins).toContain("error-plugin");

      // Hook should not be called after disable
      hook.mockClear();
      await pluginManager.executeOnOperationStart(context);
      expect(hook).not.toHaveBeenCalled();
    });
  });

  describe("executeOnOperationSuccess", () => {
    it("should execute onOperationSuccess with result", async () => {
      const hook = jest.fn();
      await pluginManager.registerPlugin({
        name: "plugin1",
        onOperationSuccess: hook as any,
      });

      const context = createMockContext();
      const result = { data: "test" };
      await pluginManager.executeOnOperationSuccess(context, result);

      expect(hook).toHaveBeenCalledWith(context, result);
    });

    it("should handle plugin errors gracefully", async () => {
      const hook = jest.fn().mockRejectedValue(new Error("Hook failed"));
      await pluginManager.registerPlugin({
        name: "error-plugin",
        onOperationSuccess: hook as any,
      });

      const context = createMockContext();
      await expect(
        pluginManager.executeOnOperationSuccess(context, "result"),
      ).resolves.not.toThrow();
    });
  });

  describe("executeOnOperationError", () => {
    it("should execute onOperationError with error", async () => {
      const hook = jest.fn();
      await pluginManager.registerPlugin({
        name: "plugin1",
        onOperationError: hook as any,
      });

      const context = createMockContext();
      const error = new Error("Operation failed");
      await pluginManager.executeOnOperationError(context, error);

      expect(hook).toHaveBeenCalledWith(context, error);
    });
  });

  describe("executeOnOperationComplete", () => {
    it("should execute onOperationComplete", async () => {
      const hook = jest.fn();
      await pluginManager.registerPlugin({
        name: "plugin1",
        onOperationComplete: hook as any,
      });

      const context = createMockContext();
      await pluginManager.executeOnOperationComplete(context);

      expect(hook).toHaveBeenCalledWith(context);
    });
  });

  describe("shutdownAll", () => {
    it("should call shutdown on all plugins", async () => {
      const shutdown1 = jest.fn();
      const shutdown2 = jest.fn();

      await pluginManager.registerPlugin({
        name: "plugin1",
        shutdown: shutdown as any1,
      });
      await pluginManager.registerPlugin({
        name: "plugin2",
        shutdown: shutdown as any2,
      });

      await pluginManager.shutdownAll();

      expect(shutdown1).toHaveBeenCalledTimes(1);
      expect(shutdown2).toHaveBeenCalledTimes(1);
    });

    it("should handle shutdown errors gracefully", async () => {
      const shutdown1 = jest
        .fn()
        .mockRejectedValue(new Error("Shutdown failed"));
      const shutdown2 = jest.fn();

      await pluginManager.registerPlugin({
        name: "plugin1",
        shutdown: shutdown as any1,
      });
      await pluginManager.registerPlugin({
        name: "plugin2",
        shutdown: shutdown as any2,
      });

      await expect(pluginManager.shutdownAll()).resolves.not.toThrow();
      expect(shutdown1).toHaveBeenCalled();
      expect(shutdown2).toHaveBeenCalled();
    });

    it("should do nothing if no plugins registered", async () => {
      await expect(pluginManager.shutdownAll()).resolves.not.toThrow();
    });
  });

  describe("plugin lifecycle", () => {
    it("should execute all hooks in correct order", async () => {
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

      const context = createMockContext();
      await pluginManager.executeOnOperationStart(context);
      await pluginManager.executeOnOperationSuccess(context, "result");
      await pluginManager.executeOnOperationComplete(context);

      expect(callOrder).toEqual(["start", "success", "complete"]);
    });
  });

  describe("enablePlugin", () => {
    it("should re-enable a disabled plugin", async () => {
      const hook = jest.fn().mockRejectedValue(new Error("Hook failed"));
      await pluginManager.registerPlugin({
        name: "error-plugin",
        onOperationStart: hook as any,
      });

      const context = createMockContext();

      // Disable plugin by exceeding error threshold
      for (let i = 0; i < 11; i++) {
        await pluginManager.executeOnOperationStart(context);
      }

      expect(pluginManager.getDisabledPlugins()).toContain("error-plugin");

      // Re-enable plugin
      pluginManager.enablePlugin("error-plugin");
      expect(pluginManager.getDisabledPlugins()).not.toContain("error-plugin");
      expect(pluginManager.getErrorStats().get("error-plugin")).toBeUndefined();
    });
  });

  describe("parallel execution", () => {
    it("should execute plugin hooks in parallel", async () => {
      const delays: number[] = [];
      const startTime = Date.now();

      const createDelayPlugin = (
        name: string,
        delay: number,
      ): DurablePlugin => ({
        name,
        onOperationStart: async () => {
          await new Promise((resolve) => setTimeout(resolve, delay));
          delays.push(Date.now() - startTime);
        },
      });

      await pluginManager.registerPlugin(createDelayPlugin("plugin1", 50));
      await pluginManager.registerPlugin(createDelayPlugin("plugin2", 50));
      await pluginManager.registerPlugin(createDelayPlugin("plugin3", 50));

      const context = createMockContext();
      await pluginManager.executeOnOperationStart(context);

      // If parallel, total time should be ~50ms, not ~150ms
      const totalTime = Date.now() - startTime;
      expect(totalTime).toBeLessThan(100); // Allow some margin
    });
  });
});
