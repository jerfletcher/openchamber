import { isSessionGoalMaxAutoTurns } from '@/lib/sessionGoalTurnLimit';
import { clampLiveBrowserTabs } from '@/lib/browser/liveTabs';
import { normalizeLargeTextPasteBehavior, normalizeFileEditorKeymap } from './preferences';
import type { SessionTiledState, UIStore, UIStoreSlice } from './types';

const DEFAULT_SESSION_TILED_STATE: SessionTiledState = {
  enabled: false,
  layout: 'grid-4',
  pinnedId: null,
  sessionIds: [],
};

const MAX_TILED_STATE_ENTRIES = 200;

// Active session for tiled persistence; kept in sync by syncTiledStateForSession
// (wired from session-ui-store to avoid a circular import).
let activeTiledSessionId: string | null = null;

export const getActiveTiledSessionId = (): string | null => activeTiledSessionId;

type TiledFields = Pick<
  UIStore,
  'tiledSwarmViewEnabled' | 'tiledSwarmPinnedId' | 'tiledSwarmLayout' | 'tiledSessionIds' | 'tiledStateBySession'
>;

const applyTiledPatch = (state: UIStore, patch: Partial<TiledFields>): Partial<TiledFields> => {
  const next: Partial<TiledFields> = { ...patch };
  if (!activeTiledSessionId) return next;
  const merged = { ...state, ...patch };
  // Re-insert so the most recently updated session sits last, then cap.
  const { [activeTiledSessionId]: _old, ...rest } = state.tiledStateBySession;
  void _old;
  const entries = Object.entries({
    ...rest,
    [activeTiledSessionId]: {
      enabled: merged.tiledSwarmViewEnabled,
      layout: merged.tiledSwarmLayout,
      pinnedId: merged.tiledSwarmPinnedId,
      sessionIds: merged.tiledSessionIds,
    },
  });
  next.tiledStateBySession = Object.fromEntries(entries.slice(-MAX_TILED_STATE_ENTRIES));
  return next;
};

export const createPreferenceActions: UIStoreSlice<
  | 'setTerminalShell'
  | 'setTerminalLoginShells'
  | 'setTerminalCloseOnExit'
  | 'setTerminalOpenOnProjectAction'
  | 'setShowReasoningTraces'
  | 'setStreamingAutoFollowEnabled'
  | 'setSessionRecapEnabled'
  | 'setSessionSuggestionEnabled'
  | 'setSessionWorkEnabled'
  | 'setSessionReviewOfferEnabled'
  | 'setSessionGoalEnabled'
  | 'setSessionGoalChecker'
  | 'setSessionGoalMaxAutoTurns'
  | 'setSessionGoalDefaultBudgetEnabled'
  | 'setSessionGoalDefaultBudget'
  | 'setCollapsibleThinkingBlocks'
  | 'setExpandReasoningWhileStreaming'
  | 'setActivityRenderMode'
  | 'syncTiledStateForSession'
  | 'setTiledSwarmViewEnabled'
  | 'setTiledSwarmPinnedId'
  | 'openTiledSwarmWithPin'
  | 'setTiledSwarmLayout'
  | 'setTiledSessionIds'
  | 'toggleTiledSwarmView'
  | 'setExpandCommandsByDefault'
  | 'setExpandSubagentsByDefault'
  | 'setExpandSearchesByDefault'
  | 'setExpandEditsByDefault'
  | 'setShowDeletionDialog'
  | 'setAutoDeleteEnabled'
  | 'setMergedWorktreeCleanupEnabled'
  | 'setWorktreeArchiveOnDoneEnabled'
  | 'setAutoSaveEnabled'
  | 'setFileEditorWrapLines'
  | 'setConfirmFileTreeMove'
  | 'setLayoutAnimations'
  | 'setOpenLinksInBrowserPanel'
  | 'setLiveBrowserTabLimit'
  | 'setAgentBrowserSharesLogins'
  | 'setOpenTrackerLinksOnBoard'
  | 'setFileTreeSide'
  | 'setAutoDeleteAfterDays'
  | 'setSessionRetentionAction'
  | 'setSessionRetentionOnlyArchived'
  | 'setSessionRetentionIncludeInWork'
  | 'setAutoDeleteLastRunAt'
  | 'setMessageLimit'
  | 'setGlobalDraftStarters'
  | 'setDraftStartersVisible'
  | 'setDiffLayoutPreference'
  | 'setDiffLayoutForAllFiles'
  | 'setDiffFileLayout'
  | 'setDiffFileListMode'
  | 'setDiffFileTreeWidth'
  | 'setDiffWrapLines'
  | 'setDiffHideWhitespace'
  | 'setWalkthroughTocWidth'
  | 'setGitChangesViewMode'
  | 'setToolJsonViewMode'
  | 'setInputBarOffset'
  | 'setMobileKeyboardMode'
  | 'setShowTerminalQuickKeysOnDesktop'
  | 'setSessionTabsEnabled'
  | 'setSessionTabsPerWorkspace'
  | 'setAlwaysShowScrollbars'
  | 'setMobileKeepScreenAwake'
  | 'setQuestionsInChat'
  | 'setShowOpenCodeUpdateNotifications'
  | 'setInputSpellcheckEnabled'
  | 'setLargeTextPasteBehavior'
  | 'setDocumentAttachBehavior'
  | 'setEnterToSend'
  | 'setEnterToSendConfigured'
  | 'setMobileReturnKeySends'
  | 'setChatWidth'
  | 'setCodeBlockLineWrap'
  | 'setTableCellWrap'
  | 'setSelectionApprovalText'
  | 'setCopyMessagesAsPlainText'
  | 'setShowToolFileIcons'
  | 'setShowTurnChangedFiles'
  | 'setKeepEarlierReplies'
  | 'setTimeFormatPreference'
  | 'setWeekStartPreference'
  | 'setDesktopWindowControlsPosition'
  | 'setDesktopWindowControlsStyle'
  | 'setMermaidRenderingMode'
  | 'setUserMessageRenderingMode'
  | 'setCollapsibleUserMessages'
  | 'setStickyUserHeader'
  | 'setPromptNavigatorEnabled'
  | 'setShowSplitAssistantMessageActions'
  | 'setAllowPromptingSubagentSessions'
  | 'setSavePastedImagesAsFiles'
  | 'setReportUsage'
  | 'setShortcutOverride'
  | 'clearShortcutOverride'
  | 'resetAllShortcutOverrides'
  | 'setFileEditorKeymap'
  | 'setFileEditorVimMappings'
> = (set, get) => ({
  setTerminalShell: (shell) => {
    set({ terminalShell: shell });
  },

  setTerminalLoginShells: (shells) => {
    set({ terminalLoginShells: [...new Set(shells)] });
  },

  setTerminalCloseOnExit: (value) => {
    set({ terminalCloseOnExit: value });
  },

  setTerminalOpenOnProjectAction: (value) => {
    set({ terminalOpenOnProjectAction: value });
  },
  setShowReasoningTraces: (value) => {
    set({ showReasoningTraces: value });
  },

  setStreamingAutoFollowEnabled: (value) => {
    set({ streamingAutoFollowEnabled: value });
  },

  setSessionRecapEnabled: (value) => {
    set({ sessionRecapEnabled: value });
  },

  setSessionSuggestionEnabled: (value) => {
    set({ sessionSuggestionEnabled: value });
  },

  setSessionWorkEnabled: (value) => {
    set({ sessionWorkEnabled: value });
  },

  setSessionReviewOfferEnabled: (value) => {
    set({ sessionReviewOfferEnabled: value });
  },

  setSessionGoalEnabled: (value) => {
    set({ sessionGoalEnabled: value });
  },

  setSessionGoalChecker: (value) => {
    set({ sessionGoalChecker: value });
  },

  setSessionGoalMaxAutoTurns: (value) => {
    if (!isSessionGoalMaxAutoTurns(value)) return;
    set({ sessionGoalMaxAutoTurns: value });
  },

  setSessionGoalDefaultBudgetEnabled: (value) => {
    set({ sessionGoalDefaultBudgetEnabled: value });
  },

  setSessionGoalDefaultBudget: (value) => {
    set({ sessionGoalDefaultBudget: value });
  },

  setCollapsibleThinkingBlocks: (value) => {
    set({ collapsibleThinkingBlocks: value });
  },

  setExpandReasoningWhileStreaming: (value) => {
    set({ expandReasoningWhileStreaming: value });
  },

  setExpandCommandsByDefault: (value) => {
    set({ expandCommandsByDefault: value });
  },

  setExpandSubagentsByDefault: (value) => {
    set({ expandSubagentsByDefault: value });
  },

  setExpandEditsByDefault: (value) => {
    set({ expandEditsByDefault: value });
  },

  setExpandSearchesByDefault: (value) => {
    set({ expandSearchesByDefault: value });
  },

  setActivityRenderMode: (value) => {
    set({ activityRenderMode: value });
  },

  syncTiledStateForSession: (sessionId) => {
    activeTiledSessionId = sessionId;
    if (!sessionId) {
      set({
        tiledSwarmViewEnabled: DEFAULT_SESSION_TILED_STATE.enabled,
        tiledSwarmLayout: DEFAULT_SESSION_TILED_STATE.layout,
        tiledSwarmPinnedId: DEFAULT_SESSION_TILED_STATE.pinnedId,
        tiledSessionIds: DEFAULT_SESSION_TILED_STATE.sessionIds,
      });
      return;
    }
    const saved = get().tiledStateBySession[sessionId] ?? DEFAULT_SESSION_TILED_STATE;
    set({
      tiledSwarmViewEnabled: saved.enabled,
      tiledSwarmLayout: saved.layout,
      tiledSwarmPinnedId: saved.pinnedId,
      tiledSessionIds: saved.sessionIds,
    });
  },

  setTiledSwarmViewEnabled: (value) => {
    set((state) => applyTiledPatch(state, { tiledSwarmViewEnabled: value }));
  },

  setTiledSwarmPinnedId: (id) => {
    set((state) => applyTiledPatch(state, { tiledSwarmPinnedId: id }));
  },

  openTiledSwarmWithPin: (id) => {
    set((state) => applyTiledPatch(state, { tiledSwarmViewEnabled: true, tiledSwarmPinnedId: id }));
  },

  setTiledSwarmLayout: (value) => {
    set((state) => applyTiledPatch(state, { tiledSwarmLayout: value }));
  },

  setTiledSessionIds: (ids) => {
    // Stale or duplicate ids would render duplicate panes and duplicate
    // React keys, so the setter normalises the list once, here.
    const clean = Array.from(new Set(ids.filter((id) => typeof id === 'string' && id.trim() !== '')));
    set((state) => applyTiledPatch(state, { tiledSessionIds: clean }));
  },

  toggleTiledSwarmView: () => {
    set((state) => applyTiledPatch(state, { tiledSwarmViewEnabled: !state.tiledSwarmViewEnabled }));
  },

  setShowDeletionDialog: (value) => {
    set({ showDeletionDialog: value });
  },

  setAutoDeleteEnabled: (value) => {
    set({ autoDeleteEnabled: value });
  },

  setMergedWorktreeCleanupEnabled: (value) => {
    set({ mergedWorktreeCleanupEnabled: value });
  },

  setWorktreeArchiveOnDoneEnabled: (value) => {
    set({ worktreeArchiveOnDoneEnabled: value });
  },

  setAutoSaveEnabled: (value) => {
    set({ autoSaveEnabled: value });
  },

  setFileEditorWrapLines: (value) => {
    set({ fileEditorWrapLines: value });
  },

  setConfirmFileTreeMove: (value) => {
    set({ confirmFileTreeMove: value });
  },

  setLayoutAnimations: (value) => {
    set({ layoutAnimations: value });
  },

  setOpenLinksInBrowserPanel: (value) => {
    set({ openLinksInBrowserPanel: value });
  },

  setLiveBrowserTabLimit: (value) => {
    set({ liveBrowserTabLimit: clampLiveBrowserTabs(value) });
  },

  setAgentBrowserSharesLogins: (value) => {
    set({ agentBrowserSharesLogins: value });
  },

  setOpenTrackerLinksOnBoard: (value) => {
    set({ openTrackerLinksOnBoard: value });
  },

  setFileTreeSide: (side) => {
    set({ fileTreeSide: side === 'left' ? 'left' : 'right' });
  },

  setAutoDeleteAfterDays: (days) => {
    const clampedDays = Math.max(1, Math.min(365, days));
    set({ autoDeleteAfterDays: clampedDays });
  },

  setSessionRetentionAction: (value) => {
    set((state) => ({ sessionRetentionAction: state.sessionRetentionOnlyArchived ? 'delete' : value }));
  },

  setSessionRetentionOnlyArchived: (value) => {
    set((state) => ({
      sessionRetentionOnlyArchived: value,
      sessionRetentionAction: value ? 'delete' : state.sessionRetentionAction,
    }));
  },

  setSessionRetentionIncludeInWork: (value) => {
    set({ sessionRetentionIncludeInWork: value });
  },

  setAutoDeleteLastRunAt: (timestamp) => {
    set({ autoDeleteLastRunAt: timestamp });
  },

  setMessageLimit: (value) => {
    const clamped = Math.max(10, Math.min(500, Math.round(value)));
    set({ messageLimit: clamped });
  },

  setGlobalDraftStarters: (refs) => {
    set({ globalDraftStarters: refs });
  },

  setDraftStartersVisible: (value) => {
    set({ draftStartersVisible: value });
  },

  setDiffLayoutPreference: (mode) => {
    set({ diffLayoutPreference: mode });
  },

  setDiffLayoutForAllFiles: (mode) => {
    set({ diffLayoutPreference: mode, diffFileLayout: {} });
  },

  setDiffFileLayout: (filePath, mode) => {
    set((state) => ({
      diffFileLayout: {
        ...state.diffFileLayout,
        [filePath]: mode,
      },
    }));
  },

  setDiffFileListMode: (mode) => {
    set({ diffFileListMode: mode });
  },

  setDiffFileTreeWidth: (width) => {
    set({ diffFileTreeWidth: Math.round(width) });
  },

  setDiffWrapLines: (wrap) => {
    set({ diffWrapLines: wrap });
  },

  setDiffHideWhitespace: (hide) => {
    set({ diffHideWhitespace: hide });
  },

  setWalkthroughTocWidth: (width) => {
    set({ walkthroughTocWidth: Math.round(width) });
  },

  setGitChangesViewMode: (mode) => {
    set({ gitChangesViewMode: mode });
  },

  setToolJsonViewMode: (mode) => {
    set({ toolJsonViewMode: mode });
  },

  setInputBarOffset: (offset) => {
    set({ inputBarOffset: offset });
  },

  setMobileKeyboardMode: (mode) => {
    set((state) => state.mobileKeyboardMode === mode ? state : { mobileKeyboardMode: mode });
  },

  setShowTerminalQuickKeysOnDesktop: (value) => {
    set({ showTerminalQuickKeysOnDesktop: value });
  },

  setSessionTabsEnabled: (value) => {
    set({ sessionTabsEnabled: value });
  },

  setSessionTabsPerWorkspace: (value) => {
    set({ sessionTabsPerWorkspace: value });
  },

  setAlwaysShowScrollbars: (value) => {
    set({ alwaysShowScrollbars: value });
  },

  setMobileKeepScreenAwake: (value) => {
    set({ mobileKeepScreenAwake: value });
  },

  setQuestionsInChat: (value) => {
    set({ questionsInChat: value });
  },

  setShowOpenCodeUpdateNotifications: (value) => {
    set({ showOpenCodeUpdateNotifications: value });
  },

  setInputSpellcheckEnabled: (value) => {
    set({ inputSpellcheckEnabled: value });
  },

  setLargeTextPasteBehavior: (value) => {
    set({ largeTextPasteBehavior: normalizeLargeTextPasteBehavior(value) });
  },

  setDocumentAttachBehavior: (value) => {
    set({ documentAttachBehavior: value });
  },

  setEnterToSend: (value) => {
    set({ enterToSend: value });
  },

  setEnterToSendConfigured: (value) => {
    set({ enterToSendConfigured: value });
  },

  setMobileReturnKeySends: (value) => {
    set({ mobileReturnKeySends: value });
  },

  setChatWidth: (value) => {
    set({ chatWidth: value });
  },

  setCodeBlockLineWrap: (value) => {
    set({ codeBlockLineWrap: value });
  },

  setTableCellWrap: (value) => {
    set({ tableCellWrap: value });
  },

  setSelectionApprovalText: (value) => {
    set({ selectionApprovalText: value });
  },

  setCopyMessagesAsPlainText: (value) => {
    set({ copyMessagesAsPlainText: value });
  },

  setShowToolFileIcons: (value) => {
    set({ showToolFileIcons: value });
  },

  setKeepEarlierReplies: (value) => {
    set({ keepEarlierReplies: value });
  },

  setShowTurnChangedFiles: (value) => {
    set({ showTurnChangedFiles: value });
  },

  setTimeFormatPreference: (value) => {
    set({ timeFormatPreference: value });
  },

  setWeekStartPreference: (value) => {
    set({ weekStartPreference: value });
  },

  setDesktopWindowControlsPosition: (value) => {
    set({ desktopWindowControlsPosition: value === 'left' ? 'left' : 'right' });
  },

  setDesktopWindowControlsStyle: (value) => {
    set({ desktopWindowControlsStyle: value === 'traffic-lights' ? 'traffic-lights' : 'classic' });
  },

  setMermaidRenderingMode: (value) => {
    set({ mermaidRenderingMode: value });
  },

  setUserMessageRenderingMode: (value) => {
    set({ userMessageRenderingMode: value });
  },

  setCollapsibleUserMessages: (value) => {
    set({ collapsibleUserMessages: value });
  },

  setStickyUserHeader: (value) => {
    set({ stickyUserHeader: value });
  },

  setPromptNavigatorEnabled: (value) => {
    set({ promptNavigatorEnabled: value });
  },

  setShowSplitAssistantMessageActions: (value) => {
    set({ showSplitAssistantMessageActions: value });
  },

  setAllowPromptingSubagentSessions: (value) => {
    set({ allowPromptingSubagentSessions: value });
  },

  setSavePastedImagesAsFiles: (value) => {
    set({ savePastedImagesAsFiles: value });
  },

  setReportUsage: (value) => {
    set({ reportUsage: value });
  },

  setShortcutOverride: (actionId, combo) => {
    set((state) => ({
      shortcutOverrides: {
        ...state.shortcutOverrides,
        [actionId]: combo,
      },
    }));
  },

  clearShortcutOverride: (actionId) => {
    set((state) => {
      const rest = { ...state.shortcutOverrides };
      delete rest[actionId];
      return { shortcutOverrides: rest };
    });
  },

  resetAllShortcutOverrides: () => {
    set({ shortcutOverrides: {} });
  },

  setFileEditorKeymap: (value) => {
    set({ fileEditorKeymap: normalizeFileEditorKeymap(value) });
  },

  setFileEditorVimMappings: (value) => {
    set({ fileEditorVimMappings: value.slice(0, 10_000) });
  },

});
