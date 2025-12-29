import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ToolArguments } from './connection/types.ts';
import { type NativeCallToolResponse, type NativeGetPromptResponse, type NativeReadResourceResponse, PromptResponseWrapper, ResourceResponseWrapper, ToolResponseWrapper } from './response-wrappers.ts';

export type PromptArguments = Record<string, string>;

type NativeCallToolParams = Parameters<Client['callTool']>;
type NativeCallToolReturn = ReturnType<Client['callTool']>;
/**
 * Fetch-style wrapper returned by `ManagedClient.callTool()`.
 * @public
 */
export type WrappedCallToolReturn = Promise<ToolResponseWrapper>;

type NativeGetPromptParams = Parameters<Client['getPrompt']>;
type NativeGetPromptReturn = ReturnType<Client['getPrompt']>;
/**
 * Fetch-style wrapper returned by `ManagedClient.getPrompt()`.
 * @public
 */
export type WrappedGetPromptReturn = Promise<PromptResponseWrapper>;

type NativeReadResourceParams = Parameters<Client['readResource']>;
type NativeReadResourceReturn = ReturnType<Client['readResource']>;
/**
 * Fetch-style wrapper returned by `ManagedClient.readResource()`.
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
  /** Underlying MCP SDK client for advanced scenarios. */
  readonly nativeClient: Client;

  callTool(toolName: string, args?: ToolArguments, requestOptions?: RequestOptions): WrappedCallToolReturn;
  callTool(invocation: NativeCallToolParams[0], sessionId?: NativeCallToolParams[1], requestOptions?: NativeCallToolParams[2]): WrappedCallToolReturn;
  callToolRaw(toolName: string, args?: ToolArguments, requestOptions?: RequestOptions): NativeCallToolReturn;
  callToolRaw(invocation: NativeCallToolParams[0], sessionId?: NativeCallToolParams[1], requestOptions?: NativeCallToolParams[2]): NativeCallToolReturn;

  getPrompt(name: string, args?: PromptArguments, requestOptions?: NativeGetPromptParams[1]): WrappedGetPromptReturn;
  getPrompt(invocation: NativeGetPromptParams[0], requestOptions?: NativeGetPromptParams[1]): WrappedGetPromptReturn;
  getPromptRaw(name: string, args?: PromptArguments, requestOptions?: NativeGetPromptParams[1]): NativeGetPromptReturn;
  getPromptRaw(invocation: NativeGetPromptParams[0], requestOptions?: NativeGetPromptParams[1]): NativeGetPromptReturn;

  readResource(uri: string, requestOptions?: NativeReadResourceParams[1]): WrappedReadResourceReturn;
  readResource(request: NativeReadResourceParams[0], requestOptions?: NativeReadResourceParams[1]): WrappedReadResourceReturn;
  readResourceRaw(uri: string, requestOptions?: NativeReadResourceParams[1]): NativeReadResourceReturn;
  readResourceRaw(request: NativeReadResourceParams[0], requestOptions?: NativeReadResourceParams[1]): NativeReadResourceReturn;
};

/**
 * Enhance an MCP SDK client with convenience overloads.
 */
export function decorateClient(client: Client, metadata: { serverName: string }): ManagedClient {
  const enhanced = client as unknown as ManagedClient;

  Object.defineProperty(enhanced, 'serverName', {
    value: metadata.serverName,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(enhanced, 'nativeClient', {
    value: client,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  const nativeCallTool = client.callTool.bind(client);
  const wrapCallTool = (promise: NativeCallToolReturn): WrappedCallToolReturn => promise.then((payload) => new ToolResponseWrapper(payload as NativeCallToolResponse));

  enhanced.callTool = ((nameOrInvocation: string | NativeCallToolParams[0], argsOrSession?: ToolArguments | NativeCallToolParams[1], requestOptions?: NativeCallToolParams[2]) => {
    if (typeof nameOrInvocation === 'string') {
      return wrapCallTool(nativeCallTool({ name: nameOrInvocation, arguments: (argsOrSession as ToolArguments) ?? {} }, undefined, requestOptions));
    }
    return wrapCallTool(nativeCallTool(nameOrInvocation, argsOrSession as NativeCallToolParams[1], requestOptions));
  }) as ManagedClient['callTool'];

  enhanced.callToolRaw = ((nameOrInvocation: string | NativeCallToolParams[0], argsOrSession?: ToolArguments | NativeCallToolParams[1], requestOptions?: NativeCallToolParams[2]) => {
    if (typeof nameOrInvocation === 'string') {
      return nativeCallTool({ name: nameOrInvocation, arguments: (argsOrSession as ToolArguments) ?? {} }, undefined, requestOptions);
    }
    return nativeCallTool(nameOrInvocation, argsOrSession as NativeCallToolParams[1], requestOptions);
  }) as ManagedClient['callToolRaw'];

  const nativeGetPrompt = client.getPrompt.bind(client);
  const wrapPrompt = (promise: NativeGetPromptReturn): WrappedGetPromptReturn => promise.then((payload) => new PromptResponseWrapper(payload as NativeGetPromptResponse));

  enhanced.getPrompt = ((nameOrParams: string | NativeGetPromptParams[0], argsOrOptions?: PromptArguments | NativeGetPromptParams[1], requestOptions?: NativeGetPromptParams[1]) => {
    if (typeof nameOrParams === 'string') {
      return wrapPrompt(nativeGetPrompt({ name: nameOrParams, ...(argsOrOptions ? { arguments: argsOrOptions as PromptArguments } : {}) }, requestOptions));
    }
    return wrapPrompt(nativeGetPrompt(nameOrParams, argsOrOptions as NativeGetPromptParams[1]));
  }) as ManagedClient['getPrompt'];

  enhanced.getPromptRaw = ((nameOrParams: string | NativeGetPromptParams[0], argsOrOptions?: PromptArguments | NativeGetPromptParams[1], requestOptions?: NativeGetPromptParams[1]) => {
    if (typeof nameOrParams === 'string') {
      return nativeGetPrompt({ name: nameOrParams, ...(argsOrOptions ? { arguments: argsOrOptions as PromptArguments } : {}) }, requestOptions);
    }
    return nativeGetPrompt(nameOrParams, argsOrOptions as NativeGetPromptParams[1]);
  }) as ManagedClient['getPromptRaw'];

  const nativeReadResource = client.readResource.bind(client);
  const wrapResource = (promise: NativeReadResourceReturn): WrappedReadResourceReturn => promise.then((payload) => new ResourceResponseWrapper(payload as NativeReadResourceResponse));

  enhanced.readResource = ((uriOrRequest: string | NativeReadResourceParams[0], requestOptions?: NativeReadResourceParams[1]) => {
    if (typeof uriOrRequest === 'string') {
      return wrapResource(nativeReadResource({ uri: uriOrRequest }, requestOptions));
    }
    return wrapResource(nativeReadResource(uriOrRequest, requestOptions));
  }) as ManagedClient['readResource'];

  enhanced.readResourceRaw = ((uriOrRequest: string | NativeReadResourceParams[0], requestOptions?: NativeReadResourceParams[1]) => {
    if (typeof uriOrRequest === 'string') {
      return nativeReadResource({ uri: uriOrRequest }, requestOptions);
    }
    return nativeReadResource(uriOrRequest, requestOptions);
  }) as ManagedClient['readResourceRaw'];

  return enhanced;
}
