import type { useI18n } from '@/lib/i18n';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerRuntime } from './useComposerRuntime';
import type { useComposerPreferences } from './useComposerPreferences';
import type { useComposerPermissionSettings } from './useComposerPermissionSettings';
import type { useComposerMobileShell } from './useComposerMobileShell';
import type { useComposerMobilePanels } from './useComposerMobilePanels';
import type { useComposerExpansion } from './useComposerExpansion';
import type { useComposerEditorState } from './useComposerEditorState';
import type { useComposerDraftText } from './useComposerDraftText';
import type { useComposerDraftHistory } from './useComposerDraftHistory';
import type { useComposerSelection } from './useComposerSelection';
import { useChatSurfaceMode } from '../../useChatSurfaceMode';
import { abortShortcutReachesComposer, isTouchOnlyInput } from '../../composer/state/abortShortcutReach';
import React from 'react';
import {
    fetchAcpSessionConfig,
    getAcpConfigOption,
    updateAcpConfigOption,
    updateAcpSessionMode,
    useAcpSessionConfig,
} from '@/sync/acp-config';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionGoalArmStore } from '@/stores/useSessionGoalArmStore';
import { useBtwStore } from '@/stores/useBtwStore';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui';
import { usePermissionStore } from '@/stores/permissionStore';
import { cyclePermissionMode } from '../../permissionAutoAccept';
import { displayedPermissionMode, nextPermissionMode } from '@/stores/utils/permissionAutoAccept';
import { selectSafetyNetAvailable, useRoutingStore } from '@/stores/useRoutingStore';
import { useKeybind } from '@/hooks/useKeybind';
import { useOpenCodeStartupStore } from '@/sync/opencode-startup-gate';
import { useComposerTextValue } from '../../composer/state/composerText';
import { useMobileViewportPin } from '../../composer/state/useMobileViewportPin';

type Dependencies = {
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'composerFormRef' | 'composerRef'>;
    mobilePanels: Pick<ReturnType<typeof useComposerMobilePanels>, 'setMobileAttachMenuOpen'>;
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'composerText'>;
    i18n: Pick<ReturnType<typeof useI18n>, 't'>;
    preferences: Pick<ReturnType<typeof useComposerPreferences>, 'isMobile'>;
    expansion: Pick<ReturnType<typeof useComposerExpansion>, 'isMobileExpanded'>;
    permissionSettings: Pick<ReturnType<typeof useComposerPermissionSettings>, 'pendingBtwPermissionMode' | 'setSessionMode'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'newSessionDraftOpen' | 'isBtwActive' | 'btwSessionId' | 'currentSessionId' | 'currentManagementSessionId' | 'draftPermissionMode' | 'setDraftPermissionMode' | 'abortPromptSessionId' | 'acknowledgeSessionAbort'>;
    mobileShell: Pick<ReturnType<typeof useComposerMobileShell>, 'mobileTextareaFocused' | 'mobileComposerExpanded'>;
    runtime: Pick<ReturnType<typeof useComposerRuntime>, 'isVSCode'>;
    draftHistory: Pick<ReturnType<typeof useComposerDraftHistory>, 'isPromptHistorySearchOpen'>;
    selection: Pick<ReturnType<typeof useComposerSelection>, 'currentProviderId' | 'currentAgentName'>;
};

export function useComposerControls({
    editorState, mobilePanels, draftText, i18n, preferences, expansion, permissionSettings,
    sessionScope, mobileShell, runtime, draftHistory, selection,
}: Dependencies) {
    const { currentProviderId, currentAgentName } = selection;
    const { composerFormRef, composerRef } = editorState;
    const { setMobileAttachMenuOpen } = mobilePanels;
    const { composerText } = draftText;
    const { t } = i18n;
    const { isMobile } = preferences;
    const { isMobileExpanded } = expansion;
    const { pendingBtwPermissionMode, setSessionMode } = permissionSettings;
    const {
        newSessionDraftOpen, isBtwActive, btwSessionId, currentSessionId, currentManagementSessionId,
        draftPermissionMode, setDraftPermissionMode, abortPromptSessionId, acknowledgeSessionAbort,
    } = sessionScope;
    const { mobileTextareaFocused, mobileComposerExpanded } = mobileShell;
    const { isVSCode } = runtime;
    const { isPromptHistorySearchOpen } = draftHistory;

    const toggleDictation = React.useCallback(() => {
        window.dispatchEvent(new CustomEvent('openchamber:dictation-toggle', {
            detail: { composer: composerFormRef.current },
        }));
    }, [composerFormRef]);

    const startDictation = React.useCallback(() => {
        window.dispatchEvent(new CustomEvent('openchamber:dictation-toggle', {
            detail: { composer: composerFormRef.current, startOnly: true },
        }));
    }, [composerFormRef]);

    const openMobileAttachSheet = React.useCallback(() => {
        setMobileAttachMenuOpen(true);
        composerRef.current?.blur();
    }, [composerRef, setMobileAttachMenuOpen]);

    useMobileViewportPin({
        isMobile,
        isFullscreen: isMobileExpanded,
        isDraftScreen: newSessionDraftOpen,
        isFocused: mobileTextareaFocused,
        formRef: composerFormRef,
        editorRef: composerRef,
    });

    const goalArmed = useSessionGoalArmStore((state) => state.armed);

    const [desktopDictating, setDesktopDictating] = React.useState(false);

    const goalObjectiveLength = useComposerTextValue(composerText, (text) => (goalArmed ? text.length : 0));

    const pillText = useComposerTextValue(composerText, (text) => (isMobile && !mobileComposerExpanded ? text : ''));

    const waitingForOpenCode = useOpenCodeStartupStore((state) => state.waitingSends > 0);

    const footerGapClass = 'gap-x-1.5 gap-y-0';

    const footerPaddingClass = isMobile ? 'px-1.5 py-1.5' : (isVSCode ? 'px-1.5 py-1' : 'px-2.5 py-1.5');

    const buttonSizeClass = isMobile ? 'h-8 w-8' : (isVSCode ? 'h-5 w-5' : 'h-6 w-6');

    const sendIconSizeClass = isMobile ? 'h-4 w-4' : (isVSCode ? 'h-3.5 w-3.5' : 'h-4 w-4');

    const stopIconSizeClass = isMobile ? 'h-4 w-4' : (isVSCode ? 'h-3.5 w-3.5' : 'h-4 w-4');

    const iconSizeClass = isMobile ? 'h-[18px] w-[18px]' : 'h-4 w-4';

    const iconButtonBaseClass = 'flex cursor-pointer items-center justify-center text-foreground transition-none outline-none focus:outline-none flex-shrink-0 disabled:cursor-not-allowed';

    const footerIconButtonClass = cn(iconButtonBaseClass, buttonSizeClass);

    const permissionScopeSessionId = isBtwActive ? btwSessionId : currentSessionId ?? currentManagementSessionId;

    const safetyNetAvailable = useRoutingStore(selectSafetyNetAvailable);

    const defaultPermissionMode = useUIStore((state) => (isVSCode ? 'ask' : state.permissionDefaultMode));

    const permissionMode = usePermissionStore((state) => {
        if (isBtwActive && !btwSessionId) return pendingBtwPermissionMode ?? defaultPermissionMode;
        if (!permissionScopeSessionId) {
            return draftPermissionMode ?? defaultPermissionMode;
        }
        return state.getSessionMode(permissionScopeSessionId);
    });

    const shownPermissionMode = displayedPermissionMode(permissionMode, safetyNetAvailable);

    const isPermissionAutoAcceptInteractive = Boolean(permissionScopeSessionId || newSessionDraftOpen);

    const acpConfig = useAcpSessionConfig(permissionScopeSessionId);
    const isAcpSession = currentProviderId === 'antigravity'
        || currentAgentName === 'antigravity'
        || Boolean(acpConfig?.loaded);

    React.useEffect(() => {
        if (!permissionScopeSessionId || !isAcpSession) return;
        void fetchAcpSessionConfig(permissionScopeSessionId);
    }, [isAcpSession, permissionScopeSessionId]);

    const acpModeOption = React.useMemo(() => getAcpConfigOption(acpConfig, 'mode'), [acpConfig]);
    const acpModeOptions = React.useMemo(() => {
        if (acpModeOption?.options && acpModeOption.options.length > 0) {
            return acpModeOption.options.map((opt) => ({
                id: opt.value,
                name: opt.name,
                description: opt.description,
            }));
        }
        if (acpConfig?.availableModes && acpConfig.availableModes.length > 0) {
            return acpConfig.availableModes.map((mode) => ({
                id: mode.id,
                name: mode.name,
                description: mode.description,
            }));
        }
        return [];
    }, [acpConfig?.availableModes, acpModeOption?.options]);

    const currentAcpModeId = acpModeOption?.currentValue
        ?? acpConfig?.currentModeId
        ?? acpModeOptions[0]?.id
        ?? null;

    const handleSelectAcpMode = React.useCallback((modeId: string) => {
        if (!permissionScopeSessionId) {
            toast.error(t('chat.chatInput.toast.openSessionFirst'));
            return;
        }
        const update = acpModeOption
            ? updateAcpConfigOption(permissionScopeSessionId, 'mode', modeId)
            : updateAcpSessionMode(permissionScopeSessionId, modeId);
        void update.catch((error) => {
            const message = error instanceof Error ? error.message : t('chat.chatInput.toast.togglePermissionAutoAcceptFailed');
            toast.error(message);
        });
    }, [acpModeOption, permissionScopeSessionId, t]);

    const handlePermissionModeCycle = React.useCallback(() => {
        if (isAcpSession && acpModeOptions.length > 0) {
            const currentIdx = acpModeOptions.findIndex((opt) => opt.id === currentAcpModeId);
            const nextOpt = acpModeOptions[(currentIdx + 1) % acpModeOptions.length];
            if (nextOpt) handleSelectAcpMode(nextOpt.id);
            return;
        }
        if (isBtwActive && !btwSessionId && currentSessionId) {
            useBtwStore.getState().setPanelState(currentSessionId, {
                pendingPermissionMode: nextPermissionMode(permissionMode, safetyNetAvailable),
            });
            return;
        }
        cyclePermissionMode({
            permissionScopeSessionId,
            newSessionDraftOpen,
            currentMode: permissionMode,
            safetyAvailable: safetyNetAvailable,
            setDraftPermissionMode,
            setSessionMode,
            onOpenSessionFirst: () => toast.error(t('chat.chatInput.toast.openSessionFirst')),
            onToggleFailed: () => toast.error(t('chat.chatInput.toast.togglePermissionAutoAcceptFailed')),
        });
    }, [
        acpModeOptions,
        currentAcpModeId,
        handleSelectAcpMode,
        isAcpSession,
        newSessionDraftOpen,
        permissionMode,
        permissionScopeSessionId,
        safetyNetAvailable,
        isBtwActive,
        btwSessionId,
        currentSessionId,
        setDraftPermissionMode,
        setSessionMode,
        t,
    ]);

    const acpMode = React.useMemo(
        () => (isAcpSession && acpModeOptions.length > 0 ? {
            options: acpModeOptions,
            currentModeId: currentAcpModeId,
            onSelectMode: handleSelectAcpMode,
        } : null),
        [acpModeOptions, currentAcpModeId, handleSelectAcpMode, isAcpSession],
    );

    useKeybind('toggle_permission_auto_accept', () => {
        if (!isPermissionAutoAcceptInteractive || isPromptHistorySearchOpen) return false;
        handlePermissionModeCycle();
    });

    const chatSurfaceMode = useChatSurfaceMode();
    const isMiniChatSurface = chatSurfaceMode === 'mini-chat';

    const abortShortcutReaches = abortShortcutReachesComposer({
        surface: isBtwActive ? 'btw' : isMiniChatSurface ? 'mini-chat' : chatSurfaceMode === 'default' ? 'main' : 'unknown',
        touch: isMobile || isTouchOnlyInput(),
    });

    const prevWasAbortedRef = React.useRef(false);

    React.useEffect(() => {
        const pendingAbort = Boolean(abortPromptSessionId) && abortPromptSessionId === currentSessionId;
        if (!prevWasAbortedRef.current && pendingAbort && currentSessionId) {
            acknowledgeSessionAbort(currentSessionId);
        }
        prevWasAbortedRef.current = pendingAbort;
    }, [abortPromptSessionId, acknowledgeSessionAbort, currentSessionId, prevWasAbortedRef]);

    return {
        pillText, footerIconButtonClass, iconSizeClass, sendIconSizeClass, stopIconSizeClass,
        openMobileAttachSheet, toggleDictation, startDictation, desktopDictating, iconButtonBaseClass, goalObjectiveLength,
    footerPaddingClass, footerGapClass, abortShortcutReaches, shownPermissionMode,
    isPermissionAutoAcceptInteractive, acpMode,
        handlePermissionModeCycle, setDesktopDictating, waitingForOpenCode,
    };
}
