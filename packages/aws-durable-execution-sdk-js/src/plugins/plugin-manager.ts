import { DurablePlugin, OperationContext } from "./types";
import { log } from "../utils/logger/logger";

/**
 * Manages plugin registration and orchestrates hook execution
 *
 * @internal
 */
export class PluginManager {
  private plugins: Map<string, DurablePlugin> = new Map();
  private pluginErrors: Map<string, number> = new Map();
  private disabledPlugins: Set<string> = new Set();
  private initialized = false;

  /**
   * Maximum errors before auto-disabling a plugin
   */
  private readonly ERROR_THRESHOLD = 10;

  /**
   * Register a plugin
   *
   * @param plugin - Plugin to register
   * @throws Error if plugin with same name already registered
   */
  async registerPlugin(plugin: DurablePlugin): Promise<void> {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin '${plugin.name}' is already registered`);
    }

    try {
      // Initialize plugin if it has an initialize method
      if (plugin.initialize) {
        await plugin.initialize();
      }

      this.plugins.set(plugin.name, plugin);
      log("✅", `Plugin '${plugin.name}' registered successfully`);
    } catch (error) {
      log(
        "❌",
        `Failed to register plugin '${plugin.name}':`,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  /**
   * Unregister a plugin
   *
   * @param pluginName - Name of plugin to unregister
   * @returns true if plugin was unregistered, false if not found
   */
  unregisterPlugin(pluginName: string): boolean {
    const removed = this.plugins.delete(pluginName);
    if (removed) {
      this.disabledPlugins.delete(pluginName);
      this.pluginErrors.delete(pluginName);
      log("ℹ️", `Plugin '${pluginName}' unregistered`);
    }
    return removed;
  }

  /**
   * Disable a plugin (stops executing its hooks)
   *
   * @param pluginName - Name of plugin to disable
   */
  private disablePlugin(pluginName: string): void {
    this.disabledPlugins.add(pluginName);
    log("⚠️", `Plugin '${pluginName}' disabled due to repeated errors`);
  }

  /**
   * Check if plugin is enabled
   */
  private isPluginEnabled(pluginName: string): boolean {
    return !this.disabledPlugins.has(pluginName);
  }

  /**
   * Get all registered plugins
   */
  getPlugins(): DurablePlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Get plugin by name
   */
  getPlugin(name: string): DurablePlugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * Execute a hook safely with error handling
   *
   * @param plugin - Plugin to execute hook on
   * @param hookName - Name of the hook method
   * @param args - Arguments to pass to the hook
   */
  private async safeExecuteHook(
    plugin: DurablePlugin,
    hookName: keyof DurablePlugin,
    ...args: unknown[]
  ): Promise<void> {
    if (!this.isPluginEnabled(plugin.name)) {
      return;
    }

    try {
      const hook = plugin[hookName];
      if (typeof hook === "function") {
        await (hook as (...args: unknown[]) => Promise<void> | void).apply(
          plugin,
          args,
        );
      }
    } catch (error) {
      // Track errors per plugin
      const errorCount = (this.pluginErrors.get(plugin.name) || 0) + 1;
      this.pluginErrors.set(plugin.name, errorCount);

      // Log error with context
      log("❌", "Plugin hook failed", {
        pluginName: plugin.name,
        pluginVersion: plugin.version,
        hookName,
        error: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
        totalErrors: errorCount,
      });

      // Auto-disable plugin if error threshold exceeded
      if (errorCount >= this.ERROR_THRESHOLD) {
        this.disablePlugin(plugin.name);
      }
    }
  }

  /**
   * Execute onOperationStart hooks for all plugins
   *
   * @param context - Operation context
   */
  async executeOnOperationStart(context: OperationContext): Promise<void> {
    if (this.plugins.size === 0) {
      return;
    }

    // Execute all plugin hooks in parallel for performance
    const promises = Array.from(this.plugins.values()).map((plugin) =>
      this.safeExecuteHook(plugin, "onOperationStart", context),
    );

    await Promise.all(promises);
  }

  /**
   * Execute onOperationSuccess hooks for all plugins
   *
   * @param context - Operation context
   * @param result - Operation result
   */
  async executeOnOperationSuccess(
    context: OperationContext,
    result: unknown,
  ): Promise<void> {
    if (this.plugins.size === 0) {
      return;
    }

    const promises = Array.from(this.plugins.values()).map((plugin) =>
      this.safeExecuteHook(plugin, "onOperationSuccess", context, result),
    );

    await Promise.all(promises);
  }

  /**
   * Execute onOperationError hooks for all plugins
   *
   * @param context - Operation context
   * @param error - Error thrown by operation
   */
  async executeOnOperationError(
    context: OperationContext,
    error: Error,
  ): Promise<void> {
    if (this.plugins.size === 0) {
      return;
    }

    const promises = Array.from(this.plugins.values()).map((plugin) =>
      this.safeExecuteHook(plugin, "onOperationError", context, error),
    );

    await Promise.all(promises);
  }

  /**
   * Execute onOperationComplete hooks for all plugins
   *
   * @param context - Operation context
   */
  async executeOnOperationComplete(context: OperationContext): Promise<void> {
    if (this.plugins.size === 0) {
      return;
    }

    const promises = Array.from(this.plugins.values()).map((plugin) =>
      this.safeExecuteHook(plugin, "onOperationComplete", context),
    );

    await Promise.all(promises);
  }

  /**
   * Shutdown all plugins
   * Called during Lambda termination or execution completion
   */
  async shutdownAll(): Promise<void> {
    if (this.plugins.size === 0) {
      return;
    }

    log("ℹ️", `Shutting down ${this.plugins.size} plugins`);

    const promises = Array.from(this.plugins.values())
      .filter((plugin) => plugin.shutdown)
      .map(async (plugin) => {
        try {
          await plugin.shutdown!();
          log("✅", `Plugin '${plugin.name}' shutdown successfully`);
        } catch (error) {
          log(
            "❌",
            `Plugin '${plugin.name}' shutdown failed:`,
            error instanceof Error ? error.message : String(error),
          );
        }
      });

    await Promise.allSettled(promises);
  }

  /**
   * Get plugin error statistics
   */
  getErrorStats(): Map<string, number> {
    return new Map(this.pluginErrors);
  }

  /**
   * Get disabled plugins
   */
  getDisabledPlugins(): string[] {
    return Array.from(this.disabledPlugins);
  }

  /**
   * Reset error count for a plugin
   */
  resetErrorCount(pluginName: string): void {
    this.pluginErrors.delete(pluginName);
  }

  /**
   * Re-enable a disabled plugin
   */
  enablePlugin(pluginName: string): void {
    this.disabledPlugins.delete(pluginName);
    this.resetErrorCount(pluginName);
    log("ℹ️", `Plugin '${pluginName}' re-enabled`);
  }
}
