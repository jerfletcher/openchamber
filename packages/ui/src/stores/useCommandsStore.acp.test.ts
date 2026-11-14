import { describe, expect, test } from 'bun:test';
import { mergeAcpCommands, type Command } from './useCommandsStore';

describe('useCommandsStore mergeAcpCommands', () => {
    test('merges ACP availableCommands into OpenCode commands without duplicating names', () => {
        const base: Command[] = [
            { name: 'init', description: 'Initialize project', isBuiltIn: true },
            { name: 'plan', description: 'OpenCode plan' },
        ];

        const merged = mergeAcpCommands(base, [
            { name: 'plan', description: 'ACP plan override' },
            { name: 'compact', description: 'Compact ACP context' },
        ]);

        expect(merged.map((c) => c.name)).toEqual(['init', 'plan', 'compact']);
        expect(merged.find((c) => c.name === 'plan')?.description).toBe('ACP plan override');
        expect(merged.find((c) => c.name === 'compact')).toMatchObject({
            name: 'compact',
            description: 'Compact ACP context',
            source: 'acp',
            fromOpenCode: true,
        });
    });
});
