import { convertWebSearchToolToAdapterFormat } from '@tanstack/ai-openrouter/tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Import real exports before vi.doMock so they can be re-exported
import * as tanstackAi from '@tanstack/ai';

// Mock environment
vi.doMock('#env', () => ({
  getEnv: () => ({
    OPENROUTER_KEY: 'test-key',
    VITE_APP_URL: 'http://localhost:3000',
    VITE_APP_NAME: 'Test',
  }),
}));

// Mock @tanstack/ai — chat() is the only function callLLMStream uses
// Re-export all real exports so other test files aren't affected by incomplete mock
const mockChat = vi.fn();
vi.doMock('@tanstack/ai', () => ({
  ...tanstackAi,
  chat: mockChat,
}));

// Mock create-adapter to avoid real adapter creation
vi.doMock('./create-adapter', () => ({
  createAdapter: () => ({ kind: 'text', name: 'mock' }),
}));

// Dynamic import so vi.doMock above is in effect when llm-client (and its
// `./create-adapter` import) resolves. Static imports are hoisted above
// vi.doMock and would bypass the mocks.
const { callLLMStream } = await import('./llm-client');

describe('llm-client', () => {
  beforeEach(() => {
    mockChat.mockClear();
  });

  describe('callLLMStream', () => {
    it('handles split chunks correctly', async () => {
      mockChat.mockReturnValue(
        (async function* () {
          yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'Hello' };
          yield { type: 'TEXT_MESSAGE_CONTENT', delta: ' ' };
          yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'World' };
        })()
      );

      const generator = callLLMStream({
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'test' }],
      });

      let fullText = '';
      const chunks = [];

      for await (const chunk of generator) {
        if (!chunk.done) {
          fullText = chunk.accumulated;
          chunks.push(chunk.delta);
        }
      }

      expect(fullText).toBe('Hello World');
      expect(chunks).toEqual(['Hello', ' ', 'World']);
    });

    it('handles multiple lines in a single chunk', async () => {
      mockChat.mockReturnValue(
        (async function* () {
          yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'A' };
          yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'B' };
        })()
      );

      const generator = callLLMStream({
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'test' }],
      });

      let fullText = '';
      const chunks = [];

      for await (const chunk of generator) {
        if (!chunk.done) {
          fullText = chunk.accumulated;
          chunks.push(chunk.delta);
        }
      }

      expect(fullText).toBe('AB');
      expect(chunks).toEqual(['A', 'B']);
    });

    it('forwards userId and sessionId to chat metadata', async () => {
      mockChat.mockReturnValue(
        (async function* () {
          yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'ok' };
        })()
      );

      const generator = callLLMStream({
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'test' }],
        userId: 'user-123',
        sessionId: 'seq-456',
        observationName: 'unit-test',
      });

      for await (const _chunk of generator) {
        // drain
      }

      expect(mockChat).toHaveBeenCalledTimes(1);
      const firstCall = mockChat.mock.calls[0];
      if (!firstCall) throw new Error('expected mockChat to have been called');
      const callArgs = firstCall[0];
      expect(callArgs.metadata).toMatchObject({
        userId: 'user-123',
        sessionId: 'seq-456',
        observationName: 'unit-test',
      });
    });

    const drain = async (gen: AsyncIterable<unknown>) => {
      for await (const _chunk of gen) {
        // exhaust the generator
      }
    };

    it('handles stream errors', () => {
      mockChat.mockReturnValue(
        (async function* () {
          yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'partial' };
          yield {
            type: 'RUN_ERROR',
            message: 'Connection lost',
          };
        })()
      );

      const generator = callLLMStream({
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'test' }],
      });

      return expect(drain(generator)).rejects.toThrow(
        'LLM stream error: Connection lost'
      );
    });

    it('preserves event.code in stream errors', () => {
      mockChat.mockReturnValue(
        (async function* () {
          yield {
            type: 'RUN_ERROR',
            message: 'Schema mismatch',
            code: 'schema-validation',
          };
        })()
      );

      const generator = callLLMStream({
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'test' }],
      });

      return expect(drain(generator)).rejects.toThrow(
        'LLM stream error [schema-validation]: Schema mismatch'
      );
    });

    it('surfaces event.code and event.model in stream errors', () => {
      mockChat.mockReturnValue(
        (async function* () {
          yield {
            type: 'RUN_ERROR',
            message: 'Provider returned error',
            code: 'provider-error',
            model: 'anthropic/claude-sonnet-4.6',
          };
        })()
      );

      const generator = callLLMStream({
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'test' }],
      });

      return expect(drain(generator)).rejects.toThrow(
        'LLM stream error [provider-error, model=anthropic/claude-sonnet-4.6]: Provider returned error'
      );
    });

    it('surfaces event.model even when code is absent', () => {
      mockChat.mockReturnValue(
        (async function* () {
          yield {
            type: 'RUN_ERROR',
            message: 'Provider returned error',
            model: 'anthropic/claude-sonnet-4.6',
          };
        })()
      );

      const generator = callLLMStream({
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'test' }],
      });

      return expect(drain(generator)).rejects.toThrow(
        'LLM stream error [model=anthropic/claude-sonnet-4.6]: Provider returned error'
      );
    });

    it('stringifies non-string RUN_ERROR.message', () => {
      mockChat.mockReturnValue(
        (async function* () {
          yield {
            type: 'RUN_ERROR',
            message: { reason: 'aborted', detail: 'user cancelled' },
          };
        })()
      );

      const generator = callLLMStream({
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'test' }],
      });

      return expect(drain(generator)).rejects.toThrow(/"reason":"aborted"/);
    });

    it('surfaces the provider error detail from rawEvent', () => {
      mockChat.mockReturnValue(
        (async function* () {
          yield {
            type: 'RUN_ERROR',
            message: 'Provider returned error',
            model: 'anthropic/claude-sonnet-4.6',
            rawEvent: {
              code: 400,
              message: 'Provider returned error',
              provider_name: 'Anthropic',
              raw: JSON.stringify({
                type: 'error',
                error: {
                  type: 'invalid_request_error',
                  message: 'output_config.format.schema: Invalid schema',
                },
              }),
            },
          };
        })()
      );

      const generator = callLLMStream({
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'test' }],
      });

      return expect(drain(generator)).rejects.toThrow(
        'LLM stream error [model=anthropic/claude-sonnet-4.6]: Provider returned error — provider=Anthropic output_config.format.schema: Invalid schema'
      );
    });

    describe('with responseSchema', () => {
      const schema = z.object({ greeting: z.string() });
      // A non-Anthropic structured-output model → native `outputSchema` path.
      const nativeModel = 'openai/gpt-5.4';

      it('yields parsed object on terminal chunk when structured-output.complete fires', async () => {
        mockChat.mockReturnValue(
          (async function* () {
            yield { type: 'TEXT_MESSAGE_CONTENT', delta: '{"greeting":' };
            yield { type: 'TEXT_MESSAGE_CONTENT', delta: '"hi"}' };
            yield {
              type: 'CUSTOM',
              name: 'structured-output.complete',
              value: { object: { greeting: 'hi' } },
            };
          })()
        );

        const generator = callLLMStream({
          model: nativeModel,
          messages: [{ role: 'user', content: 'test' }],
          responseSchema: schema,
        });

        const chunks = [];
        for await (const chunk of generator) {
          chunks.push(chunk);
        }

        const terminal = chunks.at(-1);
        if (!terminal || !terminal.done) {
          throw new Error('expected a terminal done:true chunk');
        }
        expect(terminal.parsed).toEqual({ greeting: 'hi' });

        // Non-terminal chunks have done:false and no parsed field
        const nonTerminal = chunks.slice(0, -1);
        expect(nonTerminal.every((c) => c.done === false)).toBe(true);
      });

      it('forwards outputSchema to chat()', async () => {
        mockChat.mockReturnValue(
          (async function* () {
            yield {
              type: 'CUSTOM',
              name: 'structured-output.complete',
              value: { object: { greeting: 'hi' } },
            };
          })()
        );

        const generator = callLLMStream({
          model: nativeModel,
          messages: [{ role: 'user', content: 'test' }],
          responseSchema: schema,
        });

        for await (const _chunk of generator) {
          // drain
        }

        expect(mockChat).toHaveBeenCalledTimes(1);
        const firstCall = mockChat.mock.calls[0];
        if (!firstCall)
          throw new Error('expected mockChat to have been called');
        expect(firstCall[0].outputSchema).toBe(schema);
      });

      it('yields parsed=undefined when stream ends without structured-output.complete', async () => {
        mockChat.mockReturnValue(
          (async function* () {
            yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'plain text' };
          })()
        );

        const generator = callLLMStream({
          model: nativeModel,
          messages: [{ role: 'user', content: 'test' }],
          responseSchema: schema,
        });

        const chunks = [];
        for await (const chunk of generator) {
          chunks.push(chunk);
        }

        const terminal = chunks.at(-1);
        if (!terminal || !terminal.done) {
          throw new Error('expected a terminal done:true chunk');
        }
        expect(terminal.parsed).toBeUndefined();
      });

      it('falls back to json_object + schema-in-prompt for Anthropic models', async () => {
        mockChat.mockReturnValue(
          (async function* () {
            yield { type: 'TEXT_MESSAGE_CONTENT', delta: '{"greeting":' };
            yield { type: 'TEXT_MESSAGE_CONTENT', delta: '"hi"}' };
          })()
        );

        const chunks = [];
        for await (const chunk of callLLMStream({
          model: 'anthropic/claude-sonnet-4.6',
          messages: [{ role: 'user', content: 'test' }],
          responseSchema: schema,
        })) {
          chunks.push(chunk);
        }

        const callArgs = mockChat.mock.calls[0]?.[0];
        if (!callArgs) throw new Error('expected mockChat to have been called');
        // Anthropic can't compile the strict grammar → no outputSchema; uses
        // json_object with the schema pinned in an extra system prompt.
        expect(callArgs.outputSchema).toBeUndefined();
        expect(callArgs.modelOptions.responseFormat).toEqual({
          type: 'json_object',
        });
        expect(
          callArgs.systemPrompts.some((p: string) => p.includes('JSON Schema'))
        ).toBe(true);
        // `parsed` comes from validating the accumulated JSON text.
        const terminal = chunks.at(-1);
        if (!terminal || !terminal.done) throw new Error('expected terminal');
        expect(terminal.parsed).toEqual({ greeting: 'hi' });
      });
    });

    describe('web search tool', () => {
      it('wires the OpenRouter web search server tool when webSearch is enabled', async () => {
        mockChat.mockReturnValue(
          (async function* () {
            yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'ok' };
          })()
        );

        await drain(
          callLLMStream({
            model: 'anthropic/claude-sonnet-4.6',
            messages: [{ role: 'user', content: 'test' }],
            webSearch: true,
          })
        );

        expect(mockChat).toHaveBeenCalledTimes(1);
        const callArgs = mockChat.mock.calls[0]?.[0];
        if (!callArgs) throw new Error('expected mockChat to have been called');
        expect(callArgs.tools).toHaveLength(1);
        // Converting to the adapter wire format proves it's a genuine
        // webSearchTool() output and resolves to OpenRouter's server tool type.
        expect(
          convertWebSearchToolToAdapterFormat(callArgs.tools[0]).type
        ).toBe('openrouter:web_search');
      });

      it('omits tools entirely when webSearch is not requested', async () => {
        mockChat.mockReturnValue(
          (async function* () {
            yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'ok' };
          })()
        );

        await drain(
          callLLMStream({
            model: 'anthropic/claude-sonnet-4.6',
            messages: [{ role: 'user', content: 'test' }],
          })
        );

        const callArgs = mockChat.mock.calls[0]?.[0];
        if (!callArgs) throw new Error('expected mockChat to have been called');
        expect(callArgs.tools).toBeUndefined();
      });
    });
  });
});
