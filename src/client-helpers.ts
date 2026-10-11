import type { Client } from '@modelcontextprotocol/client';
import type { ToolArguments } from './connection/types.ts';
import { type NativeCallToolResponse, type NativeGetPromptResponse, type NativeReadResourceResponse, PromptResponseWrapper, ResourceResponseWrapper, ToolResponseWrapper } from './response-wrappers.ts';

export type PromptArguments = Record<string, string>;

type NativeCallToolParams = Parameters<Client['callTool']>;
type NativeCallToolReturn = ReturnType<Client['callTool']>;
/**
 * Response with MCP data and representation helpers returned by `ManagedClient.callTool()`.
 * @public
 */
export type WrappedCallToolReturn = Promise<ToolResponseWrapper>;

type NativeGetPromptParams = Parameters<Client['getPrompt']>;
type NativeGetPromptReturn = ReturnType<Client['getPrompt']>;
/**
 * Response with MCP data and representation helpers returned by `ManagedClient.getPrompt()`.
 * @public
 */
export type WrappedGetPromptReturn = Promise<PromptResponseWrapper>;

type NativeReadResourceParams = Parameters<Client['readResource']>;
type NativeReadResourceReturn = ReturnType<Client['readResource']>;
/**
 * Response with MCP data and representation helpers returned by `ManagedClient.readResource()`.
 * @public
 */
export type WrappedReadResourceReturn = Promise<ResourceResponseWrapper>;

/**
 * Client returned by registry.connect() with convenience overloads for
 * calling tools, reading resources, and getting prompts using simple arguments.
 */
export type ManagedClient = Omit<Client, 'callTool' | 'getPrompt' | 'readResource'> & {
  /** Name of the server this client is connected to. */
  readonly serverName: string;
  /** Original SDK instance, distinct from this managed view. */
  readonly nativeClient: Client;

  callTool(toolName: string, args?: ToolArguments, requestOptions?: NativeCallToolParams[1]): WrappedCallToolReturn;
  callTool(invocation: NativeCallToolParams[0], requestOptions?: NativeCallToolParams[1]): WrappedCallToolReturn;

  getPrompt(name: string, args?: PromptArguments, requestOptions?: NativeGetPromptParams[1]): WrappedGetPromptReturn;
  getPrompt(invocation: NativeGetPromptParams[0], requestOptions?: NativeGetPromptParams[1]): WrappedGetPromptReturn;

  readResource(uri: string, requestOptions?: NativeReadResourceParams[1]): WrappedReadResourceReturn;
  readResource(request: NativeReadResourceParams[0], requestOptions?: NativeReadResourceParams[1]): WrappedReadResourceReturn;
};

/**
 * Return a managed view without replacing the original SDK methods.
 */
export function decorateClient(client: Client, metadata: { serverName: string }): ManagedClient {
  Object.defineProperty(client, 'serverName', {
    value: metadata.serverName,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(client, 'nativeClient', {
    value: client,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  const nativeCallTool = client.callTool.bind(client);
  const wrapCallTool = (promise: NativeCallToolReturn): WrappedCallToolReturn => promise.then((payload) => new ToolResponseWrapper(payload as NativeCallToolResponse));

  const callTool = ((nameOrInvocation: string | NativeCallToolParams[0], argsOrOptions?: ToolArguments | NativeCallToolParams[1], requestOptions?: NativeCallToolParams[1]) => {
    if (typeof nameOrInvocation === 'string') {
      return wrapCallTool(nativeCallTool({ name: nameOrInvocation, arguments: (argsOrOptions as ToolArguments) ?? {} }, requestOptions));
    }
    return wrapCallTool(nativeCallTool(nameOrInvocation, argsOrOptions as NativeCallToolParams[1]));
  }) as ManagedClient['callTool'];

  const nativeGetPrompt = client.getPrompt.bind(client);
  const wrapPrompt = (promise: NativeGetPromptReturn): WrappedGetPromptReturn => promise.then((payload) => new PromptResponseWrapper(payload as NativeGetPromptResponse));

  const getPrompt = ((nameOrParams: string | NativeGetPromptParams[0], argsOrOptions?: PromptArguments | NativeGetPromptParams[1], requestOptions?: NativeGetPromptParams[1]) => {
    if (typeof nameOrParams === 'string') {
      return wrapPrompt(nativeGetPrompt({ name: nameOrParams, ...(argsOrOptions ? { arguments: argsOrOptions as PromptArguments } : {}) }, requestOptions));
    }
    return wrapPrompt(nativeGetPrompt(nameOrParams, argsOrOptions as NativeGetPromptParams[1]));
  }) as ManagedClient['getPrompt'];

  const nativeReadResource = client.readResource.bind(client);
  const wrapResource = (promise: NativeReadResourceReturn): WrappedReadResourceReturn => promise.then((payload) => new ResourceResponseWrapper(payload as NativeReadResourceResponse));

  const readResource = ((uriOrRequest: string | NativeReadResourceParams[0], requestOptions?: NativeReadResourceParams[1]) => {
    if (typeof uriOrRequest === 'string') {
      return wrapResource(nativeReadResource({ uri: uriOrRequest }, requestOptions));
    }
    return wrapResource(nativeReadResource(uriOrRequest, requestOptions));
  }) as ManagedClient['readResource'];

  const methods = { callTool, getPrompt, readResource };

  return new Proxy(client, {
    get(target, property) {
      if (property === 'callTool' || property === 'getPrompt' || property === 'readResource') {
        return methods[property];
      }
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value === 'function' && property !== 'constructor' && property !== 'onclose' && property !== 'onerror' && property !== 'fallbackRequestHandler' && property !== 'fallbackNotificationHandler') {
        return (value as (...args: unknown[]) => unknown).bind(target);
      }
      return value;
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target);
    },
  }) as unknown as ManagedClient;
}
