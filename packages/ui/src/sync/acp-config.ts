import { create } from 'zustand';
import {
    AcpConfigRequestError,
    getAcpSessionConfig,
    setAcpConfigOption,
    setAcpSessionMode,
    setAcpSessionModel,
} from '@/lib/acp/config-api';
import type {
    AcpCommandInfo,
    AcpConfigOption,
    AcpModeInfo,
    AcpModelInfo,
    AcpPlanEntry,
} from '@/lib/acp/types';
import type { SyncEvent } from '@/lib/opencode/events';

export type AcpSessionConfigState = {
    configOptions: readonly AcpConfigOption[];
    availableModes: readonly AcpModeInfo[];
    currentModeId: string | null;
    availableModels: readonly AcpModelInfo[];
    currentModelId: string | null;
    availableCommands: readonly AcpCommandInfo[];
    plan: readonly AcpPlanEntry[];
    capabilities?: Record<string, unknown>;
    loaded: boolean;
};

const EMPTY_CONFIG_OPTIONS: readonly AcpConfigOption[] = [];
const EMPTY_MODES: readonly AcpModeInfo[] = [];
const EMPTY_MODELS: readonly AcpModelInfo[] = [];
const EMPTY_COMMANDS: readonly AcpCommandInfo[] = [];
const EMPTY_PLAN: readonly AcpPlanEntry[] = [];

const createEmptySessionConfig = (): AcpSessionConfigState => ({
    configOptions: EMPTY_CONFIG_OPTIONS,
    availableModes: EMPTY_MODES,
    currentModeId: null,
    availableModels: EMPTY_MODELS,
    currentModelId: null,
    availableCommands: EMPTY_COMMANDS,
    plan: EMPTY_PLAN,
    loaded: false,
});

type AcpConfigStoreState = {
    bySession: ReadonlyMap<string, AcpSessionConfigState>;
};

export const useAcpConfigStore = create<AcpConfigStoreState>(() => ({
    bySession: new Map(),
}));

const inFlightFetches = new Map<string, Promise<AcpSessionConfigState | null>>();

const configOptionValue = (options: readonly AcpConfigOption[], id: string): string | null => {
    const match = options.find((opt) => opt.id === id);
    return match?.currentValue ?? null;
};

const applyConfigOptionsPatch = (
    prev: AcpSessionConfigState,
    configOptions: readonly AcpConfigOption[],
    extras?: {
        currentModeId?: string | null;
        currentModelId?: string | null;
        availableModels?: readonly AcpModelInfo[];
        availableModes?: readonly AcpModeInfo[];
    },
): AcpSessionConfigState => {
    const modeFromOption = configOptionValue(configOptions, 'mode');
    const modelFromOption = configOptionValue(configOptions, 'model');
    return {
        ...prev,
        configOptions,
        currentModeId: extras?.currentModeId ?? modeFromOption ?? prev.currentModeId,
        currentModelId: extras?.currentModelId ?? modelFromOption ?? prev.currentModelId,
        availableModels: extras?.availableModels ?? prev.availableModels,
        availableModes: extras?.availableModes ?? prev.availableModes,
        loaded: true,
    };
};

/** Apply `openchamber.acp-*` config/plan/mode/commands events. Returns true when store changed. */
export const applyAcpConfigEvents = (payloads: readonly SyncEvent[]): boolean => {
    const state = useAcpConfigStore.getState();
    let draft: Map<string, AcpSessionConfigState> | null = null;

    const getEntry = (sessionID: string): AcpSessionConfigState => (
        (draft ?? state.bySession).get(sessionID) ?? createEmptySessionConfig()
    );
    const write = (sessionID: string, next: AcpSessionConfigState) => {
        draft ??= new Map(state.bySession);
        draft.set(sessionID, next);
    };

    for (const payload of payloads) {
        if (payload.type === 'openchamber.acp-plan') {
            const { sessionID, entries } = payload.properties;
            if (!sessionID) continue;
            write(sessionID, { ...getEntry(sessionID), plan: entries });
        } else if (payload.type === 'openchamber.acp-mode') {
            const { sessionID, modeId } = payload.properties;
            if (!sessionID) continue;
            const prev = getEntry(sessionID);
            const nextOptions = prev.configOptions.map((opt) => (
                opt.id === 'mode' ? { ...opt, currentValue: modeId } : opt
            ));
            write(sessionID, { ...prev, currentModeId: modeId, configOptions: nextOptions });
        } else if (payload.type === 'openchamber.acp-config-options') {
            const { sessionID, configOptions, currentModeId, currentModelId, availableModels, availableModes } = payload.properties;
            if (!sessionID) continue;
            write(sessionID, applyConfigOptionsPatch(getEntry(sessionID), configOptions, {
                currentModeId,
                currentModelId,
                availableModels,
                availableModes,
            }));
        } else if (payload.type === 'openchamber.acp-commands') {
            const { sessionID, availableCommands } = payload.properties;
            if (!sessionID) continue;
            write(sessionID, { ...getEntry(sessionID), availableCommands });
        }
    }

    if (!draft) return false;
    useAcpConfigStore.setState({ bySession: draft });
    return true;
};

export const setAcpSessionConfigState = (
    sessionID: string,
    patch: Partial<AcpSessionConfigState>,
): void => {
    if (!sessionID) return;
    const state = useAcpConfigStore.getState();
    const prev = state.bySession.get(sessionID) ?? createEmptySessionConfig();
    const next = new Map(state.bySession);
    next.set(sessionID, { ...prev, ...patch });
    useAcpConfigStore.setState({ bySession: next });
};

/** Fetch `/api/acp/sessions/:id/config` and populate the store (returns null on 404 / non-ACP). */
export const fetchAcpSessionConfig = async (
    sessionID: string,
    options?: { force?: boolean },
): Promise<AcpSessionConfigState | null> => {
    if (!sessionID) return null;
    const existing = useAcpConfigStore.getState().bySession.get(sessionID);
    if (existing?.loaded && !options?.force) {
        return existing;
    }

    const inFlight = inFlightFetches.get(sessionID);
    if (inFlight) return inFlight;

    const task = (async (): Promise<AcpSessionConfigState | null> => {
        try {
            const remote = await getAcpSessionConfig(sessionID);
            const current = useAcpConfigStore.getState().bySession.get(sessionID) ?? createEmptySessionConfig();
            const merged: AcpSessionConfigState = {
                ...current,
                configOptions: Array.isArray(remote.configOptions) ? remote.configOptions : current.configOptions,
                availableModes: Array.isArray(remote.availableModes) ? remote.availableModes : current.availableModes,
                currentModeId: remote.currentModeId !== undefined ? remote.currentModeId : current.currentModeId,
                availableModels: Array.isArray(remote.availableModels) ? remote.availableModels : current.availableModels,
                currentModelId: remote.currentModelId !== undefined ? remote.currentModelId : current.currentModelId,
                availableCommands: Array.isArray(remote.availableCommands) ? remote.availableCommands : current.availableCommands,
                plan: Array.isArray(remote.acpPlan) ? remote.acpPlan : current.plan,
                capabilities: remote.capabilities ?? current.capabilities,
                loaded: true,
            };
            setAcpSessionConfigState(sessionID, merged);
            return merged;
        } catch (error) {
            if (error instanceof AcpConfigRequestError && error.status === 404) {
                return null;
            }
            return null;
        } finally {
            inFlightFetches.delete(sessionID);
        }
    })();

    inFlightFetches.set(sessionID, task);
    return task;
};

export const updateAcpConfigOption = async (
    sessionID: string,
    configId: string,
    value: string,
): Promise<void> => {
    const result = await setAcpConfigOption(sessionID, configId, value);
    const prev = useAcpConfigStore.getState().bySession.get(sessionID) ?? createEmptySessionConfig();
    if (Array.isArray(result.configOptions)) {
        setAcpSessionConfigState(sessionID, applyConfigOptionsPatch(prev, result.configOptions));
        return;
    }
    const nextOptions = prev.configOptions.map((opt) => (
        opt.id === configId ? { ...opt, currentValue: value } : opt
    ));
    setAcpSessionConfigState(sessionID, {
        ...prev,
        configOptions: nextOptions,
        ...(configId === 'mode' ? { currentModeId: value } : {}),
        ...(configId === 'model' ? { currentModelId: value } : {}),
    });
};

export const updateAcpSessionMode = async (sessionID: string, modeId: string): Promise<void> => {
    const result = await setAcpSessionMode(sessionID, modeId);
    const prev = useAcpConfigStore.getState().bySession.get(sessionID) ?? createEmptySessionConfig();
    if (Array.isArray(result.configOptions)) {
        setAcpSessionConfigState(sessionID, applyConfigOptionsPatch(prev, result.configOptions, {
            currentModeId: result.currentModeId ?? modeId,
        }));
        return;
    }
    const nextOptions = prev.configOptions.map((opt) => (
        opt.id === 'mode' ? { ...opt, currentValue: modeId } : opt
    ));
    setAcpSessionConfigState(sessionID, {
        ...prev,
        currentModeId: result.currentModeId ?? modeId,
        configOptions: nextOptions,
    });
};

export const updateAcpSessionModel = async (sessionID: string, modelId: string): Promise<void> => {
    const result = await setAcpSessionModel(sessionID, modelId);
    const prev = useAcpConfigStore.getState().bySession.get(sessionID) ?? createEmptySessionConfig();
    if (Array.isArray(result.configOptions)) {
        setAcpSessionConfigState(sessionID, applyConfigOptionsPatch(prev, result.configOptions, {
            currentModelId: result.currentModelId ?? modelId,
        }));
        return;
    }
    const nextOptions = prev.configOptions.map((opt) => (
        opt.id === 'model' ? { ...opt, currentValue: modelId } : opt
    ));
    setAcpSessionConfigState(sessionID, {
        ...prev,
        currentModelId: result.currentModelId ?? modelId,
        configOptions: nextOptions,
    });
};

export const resetAcpConfig = (): void => {
    inFlightFetches.clear();
    useAcpConfigStore.setState({ bySession: new Map() });
};

export const getAcpConfigOption = (
    config: AcpSessionConfigState | null | undefined,
    id: string,
): AcpConfigOption | undefined => config?.configOptions.find((opt) => opt.id === id);

export const selectAcpSessionConfig = (
    state: AcpConfigStoreState,
    sessionID: string | null | undefined,
): AcpSessionConfigState | undefined => (sessionID ? state.bySession.get(sessionID) : undefined);

export const useAcpSessionConfig = (
    sessionID: string | null | undefined,
): AcpSessionConfigState | undefined => (
    useAcpConfigStore((state) => selectAcpSessionConfig(state, sessionID))
);

export const useAcpPlan = (
    sessionID: string | null | undefined,
): readonly AcpPlanEntry[] => (
    useAcpConfigStore((state) => (sessionID ? state.bySession.get(sessionID)?.plan ?? EMPTY_PLAN : EMPTY_PLAN))
);

export const useAcpCommands = (
    sessionID: string | null | undefined,
): readonly AcpCommandInfo[] => (
    useAcpConfigStore((state) => (sessionID ? state.bySession.get(sessionID)?.availableCommands ?? EMPTY_COMMANDS : EMPTY_COMMANDS))
);
