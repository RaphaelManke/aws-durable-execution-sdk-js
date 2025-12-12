import { OperationContext } from "./types";
import { PluginManager } from "./plugin-manager";
import { DurablePromise } from "../types/durable-promise";
import { OperationType } from "@aws-sdk/client-lambda";

/**
 * Information needed to create operation context
 *
 * @internal
 */
export interface OperationInfo {
  operationType: OperationType;
  operationId: string;
  operationName?: string;
  parentId?: string;
  executionArn: string;
  requestId: string;
  isReplay: boolean;
  executionMode: "REPLAY" | "EXECUTION";
  depth?: number;
  path?: string;
}

/**
 * Creates an operation context from operation info
 *
 * @internal
 */
function createOperationContext(info: OperationInfo): OperationContext {
  return {
    operationType: info.operationType,
    operationId: info.operationId,
    operationName: info.operationName,
    parentId: info.parentId,
    executionArn: info.executionArn,
    timestamp: new Date(),
    isReplay: info.isReplay,
    executionMode: info.executionMode,
    requestId: info.requestId,
    depth: info.depth || 0,
    path: info.path || info.operationId,
    metadata: {},
  };
}

/**
 * Wraps an operation with plugin hooks
 *
 * @param operation - The operation to execute
 * @param operationInfo - Information about the operation
 * @param pluginManager - Plugin manager to execute hooks
 * @returns Promise that resolves with operation result
 *
 * @internal
 */
export async function withPluginInterceptor<T>(
  operation: () => Promise<T>,
  operationInfo: OperationInfo,
  pluginManager: PluginManager,
): Promise<T> {
  const context = createOperationContext(operationInfo);

  // Execute onOperationStart hooks
  await pluginManager.executeOnOperationStart(context);

  try {
    // Execute the actual operation
    const result = await operation();

    // Execute onOperationSuccess hooks
    await pluginManager.executeOnOperationSuccess(context, result);

    return result;
  } catch (error) {
    // Execute onOperationError hooks
    if (error instanceof Error) {
      await pluginManager.executeOnOperationError(context, error);
    }

    // Rethrow the error
    throw error;
  } finally {
    // Always execute onOperationComplete hooks
    await pluginManager.executeOnOperationComplete(context);
  }
}

/**
 * Wraps a durable promise operation with plugin hooks
 *
 * @param operation - The operation returning a DurablePromise
 * @param operationInfo - Information about the operation
 * @param pluginManager - Plugin manager to execute hooks
 * @returns DurablePromise that resolves with operation result
 *
 * @internal
 */
export function withDurablePluginInterceptor<T>(
  operation: () => DurablePromise<T>,
  operationInfo: OperationInfo,
  pluginManager: PluginManager,
): DurablePromise<T> {
  // Create a regular promise that wraps the durable promise with plugin hooks
  const wrappedPromise = (async () => {
    const context = createOperationContext(operationInfo);

    // Execute onOperationStart hooks
    await pluginManager.executeOnOperationStart(context);

    try {
      // Execute the actual operation and await the DurablePromise
      const durablePromise = operation();
      const result = await durablePromise;

      // Execute onOperationSuccess hooks
      await pluginManager.executeOnOperationSuccess(context, result);

      return result;
    } catch (error) {
      // Execute onOperationError hooks
      if (error instanceof Error) {
        await pluginManager.executeOnOperationError(context, error);
      }

      // Rethrow the error
      throw error;
    } finally {
      // Always execute onOperationComplete hooks
      await pluginManager.executeOnOperationComplete(context);
    }
  })();

  // Return as DurablePromise (it's a branded type, so we cast it)
  return wrappedPromise as DurablePromise<T>;
}
