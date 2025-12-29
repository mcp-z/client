import { Buffer } from 'node:buffer';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ContentBlock, PromptMessage, TextContent } from '@modelcontextprotocol/sdk/types.js';

export type NativeCallToolResponse = Awaited<ReturnType<Client['callTool']>>;
export type NativeGetPromptResponse = Awaited<ReturnType<Client['getPrompt']>>;
export type NativeReadResourceResponse = Awaited<ReturnType<Client['readResource']>>;

export type JsonValidator<T> = (value: unknown) => asserts value is T;

export class ToolResponseError extends Error {
  readonly response: NativeCallToolResponse;

  constructor(message: string, response: NativeCallToolResponse) {
    super(message);
    this.name = 'ToolResponseError';
    this.response = response;
  }
}

export class ToolResponseWrapper {
  private readonly payload: NativeCallToolResponse;

  constructor(payload: NativeCallToolResponse) {
    this.payload = payload;
  }

  raw(): NativeCallToolResponse {
    return this.payload;
  }

  json<T = unknown>(validator?: JsonValidator<T>): T {
    const value = this.resolveJsonPayload();
    if (validator) {
      validator(value);
    }
    return value as T;
  }

  text(): string {
    if (isCompatibilityResult(this.payload)) {
      if (typeof this.payload.toolResult === 'string') {
        return this.payload.toolResult;
      }
      throw new ToolResponseError('Compatibility tool result is not text', this.payload);
    }

    this.throwIfError();

    const textBlock = findFirstTextBlock(this.payload.content ?? []);
    if (!textBlock) {
      throw new ToolResponseError('Tool response did not include text content', this.payload);
    }

    return textBlock.text;
  }

  private resolveJsonPayload(): unknown {
    if (isCompatibilityResult(this.payload)) {
      return this.payload.toolResult;
    }

    this.throwIfError();

    if (hasStructuredContent(this.payload)) {
      return this.payload.structuredContent;
    }

    const textBlock = findFirstTextBlock(this.payload.content ?? []);
    if (!textBlock) {
      throw new ToolResponseError('Tool response did not include structuredContent or text content', this.payload);
    }

    try {
      return JSON.parse(textBlock.text) as unknown;
    } catch (error) {
      const reason = formatErrorReason(error);
      throw new ToolResponseError(`Failed to parse tool text content as JSON: ${reason}`, this.payload);
    }
  }

  private throwIfError(): void {
    if ('isError' in this.payload && this.payload.isError) {
      let detail = typeof this.payload.error === 'object' && this.payload.error && 'message' in this.payload.error ? String((this.payload.error as { message?: unknown }).message ?? '') : '';
      if (!detail) {
        const textBlock = findFirstTextBlock((this.payload.content ?? []) as ContentBlock[]);
        if (textBlock?.text) {
          detail = textBlock.text;
        }
      }
      const message = detail ? `Tool invocation returned an error result: ${detail}` : 'Tool invocation returned an error result';
      throw new ToolResponseError(message, this.payload);
    }
  }
}

export class PromptResponseError extends Error {
  readonly response: NativeGetPromptResponse;

  constructor(message: string, response: NativeGetPromptResponse) {
    super(message);
    this.name = 'PromptResponseError';
    this.response = response;
  }
}

export class PromptResponseWrapper {
  private readonly payload: NativeGetPromptResponse;

  constructor(payload: NativeGetPromptResponse) {
    this.payload = payload;
  }

  raw(): NativeGetPromptResponse {
    return this.payload;
  }

  text(): string {
    const segments = collectPromptText(this.payload.messages);
    if (!segments.length) {
      throw new PromptResponseError('Prompt response did not include text content', this.payload);
    }
    return segments.join('\n\n');
  }

  json<T = unknown>(validator?: JsonValidator<T>): T {
    const textValue = this.text();
    try {
      const parsed = JSON.parse(textValue) as unknown;
      if (validator) {
        validator(parsed);
      }
      return parsed as T;
    } catch (error) {
      const reason = formatErrorReason(error);
      throw new PromptResponseError(`Failed to parse prompt text as JSON: ${reason}`, this.payload);
    }
  }
}

export class ResourceResponseError extends Error {
  readonly response: NativeReadResourceResponse;

  constructor(message: string, response: NativeReadResourceResponse) {
    super(message);
    this.name = 'ResourceResponseError';
    this.response = response;
  }
}

export class ResourceResponseWrapper {
  private readonly payload: NativeReadResourceResponse;

  constructor(payload: NativeReadResourceResponse) {
    this.payload = payload;
  }

  raw(): NativeReadResourceResponse {
    return this.payload;
  }

  text(): string {
    const entry = this.firstEntry();
    if ('text' in entry && typeof entry.text === 'string') {
      return entry.text;
    }
    if ('blob' in entry && typeof entry.blob === 'string') {
      try {
        return Buffer.from(entry.blob, 'base64').toString('utf8');
      } catch (error) {
        const reason = formatErrorReason(error);
        throw new ResourceResponseError(`Failed to decode resource blob as UTF-8 text: ${reason}`, this.payload);
      }
    }
    throw new ResourceResponseError('Resource content does not include text or blob data', this.payload);
  }

  json<T = unknown>(validator?: JsonValidator<T>): T {
    const textValue = this.text();
    try {
      const parsed = JSON.parse(textValue) as unknown;
      if (validator) {
        validator(parsed);
      }
      return parsed as T;
    } catch (error) {
      const reason = formatErrorReason(error);
      throw new ResourceResponseError(`Failed to parse resource text as JSON: ${reason}`, this.payload);
    }
  }

  private firstEntry(): NativeReadResourceResponse['contents'][number] {
    const [entry] = this.payload.contents ?? [];
    if (!entry) {
      throw new ResourceResponseError('Resource response did not include any contents', this.payload);
    }
    return entry;
  }
}

function hasStructuredContent(response: NativeCallToolResponse): response is NativeCallToolResponse & { structuredContent: Record<string, unknown> } {
  return Boolean((response as { structuredContent?: unknown }).structuredContent);
}

function isCompatibilityResult(response: NativeCallToolResponse): response is NativeCallToolResponse & { toolResult: unknown } {
  return hasOwn(response, 'toolResult');
}

function findFirstTextBlock(blocks: ContentBlock[] | undefined): TextContent | undefined {
  if (!Array.isArray(blocks)) {
    return undefined;
  }
  return blocks.find(isTextContent);
}

function collectPromptText(messages: PromptMessage[]): string[] {
  const segments: string[] = [];
  for (const message of messages) {
    const textBlock = isTextContent(message.content) ? message.content : undefined;
    if (textBlock) {
      segments.push(textBlock.text);
    }
  }
  return segments;
}

function isTextContent(block: unknown): block is TextContent {
  return Boolean(block) && typeof block === 'object' && (block as { type?: string }).type === 'text';
}

const protoHasOwn = Object.prototype.hasOwnProperty;

function hasOwn(target: object, key: PropertyKey): boolean {
  return protoHasOwn.call(target, key);
}

function formatErrorReason(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string') {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
