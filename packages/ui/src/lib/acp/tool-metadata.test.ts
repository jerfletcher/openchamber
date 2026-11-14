import { describe, expect, test } from 'bun:test';
import { getToolMetadata } from '@/lib/toolHelpers';
import { getDiffPatchEntries } from '@/components/chat/message/parts/toolDiffUtils';

describe('ACP tool metadata and diff extraction', () => {
    test('getToolMetadata maps ACP kind and title instead of collapsing to bash', () => {
        const readMeta = getToolMetadata('bash', { kind: 'read', title: 'Read package.json' });
        expect(readMeta.displayName).toBe('Read package.json');
        expect(readMeta.category).toBe('file');

        const editMeta = getToolMetadata('bash', { kind: 'edit' });
        expect(editMeta.displayName).toBe('Edit File');
        expect(editMeta.category).toBe('file');

        const searchMeta = getToolMetadata('bash', { kind: 'search', title: 'Search ACP' });
        expect(searchMeta.displayName).toBe('Search ACP');
        expect(searchMeta.category).toBe('search');

        const fetchMeta = getToolMetadata('bash', { kind: 'fetch' });
        expect(fetchMeta.displayName).toBe('Fetch URL');
        expect(fetchMeta.category).toBe('web');

        const thinkMeta = getToolMetadata('bash', { kind: 'think' });
        expect(thinkMeta.displayName).toBe('Think');
        expect(thinkMeta.category).toBe('ai');
    });

    test('getDiffPatchEntries extracts ACP metadata.diffs unified patches', () => {
        const unified = [
            '--- a/src/app.ts',
            '+++ b/src/app.ts',
            '@@ -1,2 +1,2 @@',
            '-const a = 1;',
            '+const a = 2;',
            ' const b = 3;',
        ].join('\n');

        const entries = getDiffPatchEntries(
            {
                diffs: [
                    {
                        path: 'src/app.ts',
                        oldText: 'const a = 1;\nconst b = 3;',
                        newText: 'const a = 2;\nconst b = 3;',
                        unified,
                    },
                ],
            },
            undefined,
            (p) => p,
        );

        expect(entries).toHaveLength(1);
        expect(entries[0]?.filePath).toBe('src/app.ts');
        expect(entries[0]?.renderMode).toBe('diff');
        expect(entries[0]?.patch).toContain('+const a = 2;');
    });
});
