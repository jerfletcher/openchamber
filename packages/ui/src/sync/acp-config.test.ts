import { beforeEach, describe, expect, mock, test } from 'bun:test';

const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
let mockResponses: Array<{ ok: boolean; status: number; body: unknown }> = [];

mock.module('@/lib/runtime-fetch', () => ({
    runtimeFetch: async (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, init });
        const next = mockResponses.shift() ?? { ok: true, status: 200, body: {} };
        return new Response(JSON.stringify(next.body), {
            status: next.status,
            headers: { 'content-type': 'application/json' },
        });
    },
}));

const {
    applyAcpConfigEvents,
    fetchAcpSessionConfig,
    getAcpConfigOption,
    resetAcpConfig,
    updateAcpConfigOption,
    updateAcpSessionMode,
    updateAcpSessionModel,
    useAcpConfigStore,
} = await import('./acp-config');

describe('acp-config store and API client', () => {
    beforeEach(() => {
        resetAcpConfig();
        fetchCalls.length = 0;
        mockResponses = [];
    });

    test('applyAcpConfigEvents updates plan, mode, configOptions, and commands', () => {
        const changed = applyAcpConfigEvents([
            {
                type: 'openchamber.acp-config-options',
                properties: {
                    sessionID: 'ses_acp_1',
                    configOptions: [
                        {
                            id: 'mode',
                            name: 'Mode',
                            type: 'select',
                            currentValue: 'code',
                            options: [
                                { value: 'code', name: 'Code' },
                                { value: 'ask', name: 'Ask' },
                            ],
                        },
                        {
                            id: 'thought_level',
                            name: 'Thinking',
                            type: 'select',
                            currentValue: 'medium',
                            options: [
                                { value: 'low', name: 'Low' },
                                { value: 'medium', name: 'Medium' },
                                { value: 'high', name: 'High' },
                            ],
                        },
                    ],
                    availableModels: [{ id: 'gemini-4-argon', name: 'Gemini 4 Argon' }],
                    currentModelId: 'gemini-4-argon',
                },
            },
            {
                type: 'openchamber.acp-mode',
                properties: { sessionID: 'ses_acp_1', modeId: 'ask' },
            },
            {
                type: 'openchamber.acp-plan',
                properties: {
                    sessionID: 'ses_acp_1',
                    entries: [
                        { content: 'Inspect bridge', priority: 'high', status: 'completed' },
                        { content: 'Wire UI', priority: 'medium', status: 'in_progress' },
                    ],
                },
            },
            {
                type: 'openchamber.acp-commands',
                properties: {
                    sessionID: 'ses_acp_1',
                    availableCommands: [{ name: 'plan', description: 'Create a plan' }],
                },
            },
        ]);

        expect(changed).toBe(true);
        const state = useAcpConfigStore.getState().bySession.get('ses_acp_1');
        expect(state?.currentModeId).toBe('ask');
        expect(getAcpConfigOption(state, 'mode')?.currentValue).toBe('ask');
        expect(getAcpConfigOption(state, 'thought_level')?.currentValue).toBe('medium');
        expect(state?.availableModels).toEqual([{ id: 'gemini-4-argon', name: 'Gemini 4 Argon' }]);
        expect(state?.plan).toHaveLength(2);
        expect(state?.availableCommands).toEqual([{ name: 'plan', description: 'Create a plan' }]);
    });

    test('fetchAcpSessionConfig loads from /api/acp/sessions/:id/config and ignores 404', async () => {
        mockResponses.push({
            ok: true,
            status: 200,
            body: {
                configOptions: [
                    { id: 'mode', name: 'Mode', type: 'select', currentValue: 'code', options: [{ value: 'code', name: 'Code' }] },
                ],
                availableModels: [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }],
                currentModelId: 'gemini-3.8-flash',
            },
        });

        const loaded = await fetchAcpSessionConfig('ses_acp_2');
        expect(loaded?.loaded).toBe(true);
        expect(loaded?.currentModelId).toBe('gemini-3.8-flash');
        expect(fetchCalls[0]?.url).toBe('/api/acp/sessions/ses_acp_2/config');

        mockResponses.push({ ok: false, status: 404, body: { error: 'Session not found' } });
        const missing = await fetchAcpSessionConfig('ses_missing');
        expect(missing).toBeNull();
    });

    test('updateAcpConfigOption, updateAcpSessionMode, and updateAcpSessionModel POST to ACP endpoints', async () => {
        mockResponses.push(
            {
                ok: true,
                status: 200,
                body: {
                    success: true,
                    configOptions: [
                        { id: 'thought_level', name: 'Thinking', type: 'select', currentValue: 'high' },
                    ],
                },
            },
            { ok: true, status: 200, body: { success: true, currentModeId: 'architect' } },
            { ok: true, status: 200, body: { success: true, currentModelId: 'claude-opus-5-5' } },
        );

        await updateAcpConfigOption('ses_acp_3', 'thought_level', 'high');
        await updateAcpSessionMode('ses_acp_3', 'architect');
        await updateAcpSessionModel('ses_acp_3', 'claude-opus-5-5');

        expect(fetchCalls.map((c) => c.url)).toEqual([
            '/api/acp/sessions/ses_acp_3/config',
            '/api/acp/sessions/ses_acp_3/mode',
            '/api/acp/sessions/ses_acp_3/model',
        ]);
        const state = useAcpConfigStore.getState().bySession.get('ses_acp_3');
        expect(state?.currentModeId).toBe('architect');
        expect(state?.currentModelId).toBe('claude-opus-5-5');
    });
});
