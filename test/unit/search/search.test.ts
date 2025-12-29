import assert from 'assert';
import { searchCapabilities } from '../../../src/search/search.ts';
import type { CapabilityIndex, IndexedPrompt, IndexedResource, IndexedTool } from '../../../src/search/types.ts';

describe('searchCapabilities', () => {
  // Create a test index with various capabilities
  function createTestIndex(): CapabilityIndex {
    const tools: IndexedTool[] = [
      {
        type: 'tool',
        server: 'gmail',
        name: 'gmail-message-send',
        description: 'Send an email message through Gmail',
        schemaText: 'to recipient email body subject cc bcc',
      },
      {
        type: 'tool',
        server: 'gmail',
        name: 'gmail-message-search',
        description: 'Search for messages in Gmail inbox',
        schemaText: 'query from subject date label',
      },
      {
        type: 'tool',
        server: 'sheets',
        name: 'sheets-rows-append',
        description: 'Add new rows to the bottom of a spreadsheet',
        schemaText: 'id gid rows headers deduplicateBy',
      },
      {
        type: 'tool',
        server: 'drive',
        name: 'drive-files-search',
        description: 'Search Google Drive files with flexible field selection',
        schemaText: 'query fields pageSize name mimeType',
      },
    ];

    const prompts: IndexedPrompt[] = [
      {
        type: 'prompt',
        server: 'gmail',
        name: 'compose-email',
        description: 'Help compose a professional email',
        argumentsText: 'tone recipient topic',
        arguments: [
          { name: 'tone', description: 'The tone of the email' },
          { name: 'recipient', description: 'Who the email is for' },
          { name: 'topic', description: 'What the email is about' },
        ],
      },
    ];

    const resources: IndexedResource[] = [
      {
        type: 'resource',
        server: 'pdf',
        name: 'pdf-template',
        description: 'PDF document template',
        uri: 'template://pdf/invoice',
        mimeType: 'application/pdf',
      },
      {
        type: 'resource',
        server: 'drive',
        name: 'recent-files',
        description: 'List of recently accessed files',
        uri: 'drive://recent',
        mimeType: 'application/json',
      },
    ];

    return {
      capabilities: [...tools, ...prompts, ...resources],
      servers: ['gmail', 'sheets', 'drive', 'pdf'],
      indexedAt: new Date(),
    };
  }

  describe('basic search', () => {
    it('should find tools by exact name match', () => {
      const index = createTestIndex();
      const result = searchCapabilities(index, 'gmail-message-send');

      assert.strictEqual(result.results.length, 1);
      assert.strictEqual(result.results[0]?.name, 'gmail-message-send');
      assert.strictEqual(result.results[0]?.type, 'tool');
      assert.ok(result.results[0]?.matchedOn.includes('name'));
    });

    it('should find tools by partial name match', () => {
      const index = createTestIndex();
      const result = searchCapabilities(index, 'message');

      // Should find both gmail-message-send and gmail-message-search
      assert.ok(result.results.length >= 2);
      assert.ok(result.results.some((r) => r.name === 'gmail-message-send'));
      assert.ok(result.results.some((r) => r.name === 'gmail-message-search'));
    });

    it('should find capabilities by description', () => {
      const index = createTestIndex();
      const result = searchCapabilities(index, 'email');

      // Should find gmail-message-send (description: "Send an email message")
      // and compose-email prompt
      assert.ok(result.results.length >= 1);
      assert.ok(result.results.some((r) => r.name === 'gmail-message-send'));
    });

    it('should find tools by schema property', () => {
      const index = createTestIndex();
      const result = searchCapabilities(index, 'recipient');

      // Should find gmail-message-send (schemaText contains "recipient")
      // and compose-email prompt (argumentsText contains "recipient")
      assert.ok(result.results.length >= 1);
      const toolResult = result.results.find((r) => r.name === 'gmail-message-send');
      assert.ok(toolResult);
      assert.ok(toolResult?.matchedOn.includes('inputSchema'));
    });

    it('should return empty results for no matches', () => {
      const index = createTestIndex();
      const result = searchCapabilities(index, 'nonexistent-capability-xyz');

      assert.strictEqual(result.results.length, 0);
      assert.strictEqual(result.total, 0);
    });

    it('should return empty results for empty query', () => {
      const index = createTestIndex();
      const result = searchCapabilities(index, '');

      assert.strictEqual(result.results.length, 0);
      assert.strictEqual(result.total, 0);
    });

    it('should return empty results for whitespace-only query', () => {
      const index = createTestIndex();
      const result = searchCapabilities(index, '   ');

      assert.strictEqual(result.results.length, 0);
      assert.strictEqual(result.total, 0);
    });
  });

  describe('multi-term search', () => {
    it('should score higher when multiple terms match', () => {
      const index = createTestIndex();
      const result = searchCapabilities(index, 'gmail send');

      // gmail-message-send should rank highest (matches both "gmail" and "send")
      assert.ok(result.results.length >= 1);
      assert.strictEqual(result.results[0]?.name, 'gmail-message-send');
    });

    it('should find results matching any term', () => {
      const index = createTestIndex();
      const result = searchCapabilities(index, 'spreadsheet drive');

      // Should find sheets-rows-append (description contains "spreadsheet")
      // and drive-files-search (server is "drive")
      assert.ok(result.results.length >= 2);
    });
  });

  describe('type filtering', () => {
    it('should filter to tools only', () => {
      const index = createTestIndex();
      const result = searchCapabilities(index, 'email', { types: ['tool'] });

      assert.ok(result.results.every((r) => r.type === 'tool'));
    });

    it('should filter to prompts only', () => {
      const index = createTestIndex();
      const result = searchCapabilities(index, 'email', { types: ['prompt'] });

      assert.ok(result.results.every((r) => r.type === 'prompt'));
    });

    it('should filter to resources only', () => {
      const index = createTestIndex();
      const result = searchCapabilities(index, 'pdf', { types: ['resource'] });

      assert.ok(result.results.every((r) => r.type === 'resource'));
    });

    it('should filter to multiple types', () => {
      const index = createTestIndex();
      const result = searchCapabilities(index, 'email', { types: ['tool', 'prompt'] });

      assert.ok(result.results.every((r) => r.type === 'tool' || r.type === 'prompt'));
    });
  });

  describe('server filtering', () => {
    it('should filter to specific server', () => {
      const index = createTestIndex();
      const result = searchCapabilities(index, 'search', { servers: ['gmail'] });

      assert.ok(result.results.every((r) => r.server === 'gmail'));
      assert.ok(result.results.some((r) => r.name === 'gmail-message-search'));
    });

    it('should filter to multiple servers', () => {
      const index = createTestIndex();
      const result = searchCapabilities(index, 'files', { servers: ['drive', 'sheets'] });

      assert.ok(result.results.every((r) => r.server === 'drive' || r.server === 'sheets'));
    });

    it('should return empty if server has no matches', () => {
      const index = createTestIndex();
      const result = searchCapabilities(index, 'email', { servers: ['nonexistent'] });

      assert.strictEqual(result.results.length, 0);
    });
  });

  describe('search field filtering', () => {
    it('should search only name when specified', () => {
      const index = createTestIndex();
      // "send" appears in both name and description of gmail-message-send
      // but "email" only appears in description
      const result = searchCapabilities(index, 'email', { searchFields: ['name'] });

      // Should not find gmail-message-send by "email" since we're only searching name
      assert.ok(!result.results.some((r) => r.name === 'gmail-message-send' && r.matchedOn.includes('description')));
    });

    it('should search only description when specified', () => {
      const index = createTestIndex();
      const result = searchCapabilities(index, 'spreadsheet', { searchFields: ['description'] });

      // Should find sheets-rows-append by description
      const found = result.results.find((r) => r.name === 'sheets-rows-append');
      assert.ok(found);
      assert.ok(found?.matchedOn.includes('description'));
    });

    it('should search server name when specified', () => {
      const index = createTestIndex();
      const result = searchCapabilities(index, 'gmail', { searchFields: ['server'] });

      assert.ok(result.results.length >= 1);
      assert.ok(result.results.every((r) => r.matchedOn.includes('server')));
    });
  });

  describe('limit and threshold', () => {
    it('should respect limit option', () => {
      const index = createTestIndex();
      const result = searchCapabilities(index, 'gmail', { limit: 2 });

      assert.ok(result.results.length <= 2);
      assert.ok(result.total >= result.results.length);
    });

    it('should filter by threshold', () => {
      const index = createTestIndex();
      const result = searchCapabilities(index, 'gmail', { threshold: 0.5 });

      // All results should have score >= 0.5
      assert.ok(result.results.every((r) => r.score >= 0.5));
    });
  });

  describe('scoring', () => {
    it('should give exact name match higher score than partial match', () => {
      const index = createTestIndex();
      const result = searchCapabilities(index, 'gmail-message-send');

      // The exact match should have the highest score
      const exactMatch = result.results.find((r) => r.name === 'gmail-message-send');
      assert.ok(exactMatch);
      assert.ok(exactMatch?.score > 0.7);
    });

    it('should sort results by score descending', () => {
      const index = createTestIndex();
      const result = searchCapabilities(index, 'search');

      for (let i = 1; i < result.results.length; i++) {
        const current = result.results[i];
        const previous = result.results[i - 1];
        assert.ok(current && previous && previous.score >= current.score, 'Results should be sorted by score descending');
      }
    });
  });

  describe('response format', () => {
    it('should include query in response', () => {
      const index = createTestIndex();
      const result = searchCapabilities(index, 'test query');

      assert.strictEqual(result.query, 'test query');
    });

    it('should include total count', () => {
      const index = createTestIndex();
      const result = searchCapabilities(index, 'gmail', { limit: 1 });

      // gmail server has multiple capabilities
      assert.ok(result.total >= 1);
      assert.strictEqual(result.results.length, 1);
    });

    it('should include all required fields in results', () => {
      const index = createTestIndex();
      const result = searchCapabilities(index, 'gmail');

      for (const item of result.results) {
        assert.ok(item.type, 'Result should have type');
        assert.ok(item.server, 'Result should have server');
        assert.ok(item.name, 'Result should have name');
        assert.ok(Array.isArray(item.matchedOn), 'Result should have matchedOn array');
        assert.ok(typeof item.score === 'number', 'Result should have numeric score');
      }
    });
  });

  describe('resource-specific features', () => {
    it('should match resources by mimeType in schema field', () => {
      const index = createTestIndex();
      const result = searchCapabilities(index, 'pdf', { types: ['resource'] });

      const pdfResource = result.results.find((r) => r.name === 'pdf-template');
      assert.ok(pdfResource);
    });

    it('should match resources by URI in schema field', () => {
      const index = createTestIndex();
      const result = searchCapabilities(index, 'invoice', { types: ['resource'] });

      // Should find pdf-template (uri contains "invoice")
      const found = result.results.find((r) => r.name === 'pdf-template');
      assert.ok(found);
    });
  });

  describe('case insensitivity', () => {
    it('should match regardless of case', () => {
      const index = createTestIndex();

      const lowerResult = searchCapabilities(index, 'gmail');
      const upperResult = searchCapabilities(index, 'GMAIL');
      const mixedResult = searchCapabilities(index, 'Gmail');

      assert.strictEqual(lowerResult.total, upperResult.total);
      assert.strictEqual(lowerResult.total, mixedResult.total);
    });
  });
});
