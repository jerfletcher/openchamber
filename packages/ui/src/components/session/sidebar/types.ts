import type { Session } from '@/lib/opencode/model';
import type { WorktreeMetadata } from '@/types/worktree';
import type { SpaceMark } from '@/lib/spaces/spaces-store';

export type SessionNode = {
  session: Session;
  children: SessionNode[];
  worktree: WorktreeMetadata | null;
};

export type SessionGroupFolderScope = {
  scopeKey: string;
  directory: string | null;
};

export type SessionGroup = {
  id: string;
  label: string;
  branch: string | null;
  description: string | null;
  isMain: boolean;
  isArchivedBucket?: boolean;
  worktree: WorktreeMetadata | null;
  /** The isolated space this group shows, with the state of its last answer. */
  space?: SpaceMark;
  directory: string | null;
  folderScopeKey?: string | null;
  /**
   * Flat display groups merge sessions from the project root and every
   * worktree; their folders come from all of these scopes. When present, the
   * group section gathers folders across every listed scope (in order)
   * instead of reading the single folderScopeKey.
   */
  folderScopes?: SessionGroupFolderScope[];
  draftTarget?: 'chat' | 'project';
  emptyMessage?: string;
  sessions: SessionNode[];
};

export type GroupSearchData = {
  filteredNodes: SessionNode[];
  matchedSessionCount: number;
  folderNameMatchCount: number;
  groupMatches: boolean;
  hasMatch: boolean;
};

export type AcpAgentFolderMeta = {
  agentId: string;
  folderName: string;
  folderIdPrefix: string;
};

const ACP_AGENT_FOLDERS: Record<string, { folderName: string; folderIdPrefix: string }> = {
  antigravity: { folderName: 'Antigravity', folderIdPrefix: 'antigravity' },
  'claude-code': { folderName: 'Claude Code', folderIdPrefix: 'acp:claude-code' },
  'opencode-headless': { folderName: 'OpenCode ACP', folderIdPrefix: 'acp:opencode-headless' },
};

export const getAcpSessionFolderMeta = (session: Session | null | undefined): AcpAgentFolderMeta | null => {
  if (!session) return null;
  const agent = session.agent || '';
  const providerID = session.model?.providerID || '';
  const known = ACP_AGENT_FOLDERS[agent] || ACP_AGENT_FOLDERS[providerID];
  if (known) {
    const agentId = ACP_AGENT_FOLDERS[agent] ? agent : providerID;
    return { agentId, folderName: known.folderName, folderIdPrefix: known.folderIdPrefix };
  }
  if (typeof session.id === 'string') {
    if (session.id.startsWith('ses_agy_')) {
      return { agentId: 'antigravity', ...ACP_AGENT_FOLDERS.antigravity };
    }
    if (session.id.startsWith('ses_acp_')) {
      const resolvedAgent = agent || 'antigravity';
      const fallback = ACP_AGENT_FOLDERS[resolvedAgent] ?? {
        folderName: resolvedAgent.replace(/(^|-)([a-z])/g, (_, sep, ch) => `${sep ? ' ' : ''}${ch.toUpperCase()}`),
        folderIdPrefix: `acp:${resolvedAgent}`,
      };
      return { agentId: resolvedAgent, ...fallback };
    }
  }
  if ((session as { acpSessionId?: string }).acpSessionId) {
    const resolvedAgent = agent || 'antigravity';
    const fallback = ACP_AGENT_FOLDERS[resolvedAgent] ?? {
      folderName: resolvedAgent.replace(/(^|-)([a-z])/g, (_, sep, ch) => `${sep ? ' ' : ''}${ch.toUpperCase()}`),
      folderIdPrefix: `acp:${resolvedAgent}`,
    };
    return { agentId: resolvedAgent, ...fallback };
  }
  return null;
};

export const getAutoAgentFolderAgentId = (folder: { id: string; name: string } | null | undefined): string | null => {
  if (!folder) return null;
  if (folder.id.startsWith('antigravity:') || folder.name.toLowerCase() === 'antigravity') {
    return 'antigravity';
  }
  if (folder.id.startsWith('acp:')) {
    const parts = folder.id.split(':');
    if (parts[1]) return parts[1];
  }
  for (const [agentId, meta] of Object.entries(ACP_AGENT_FOLDERS)) {
    if (folder.name.toLowerCase() === meta.folderName.toLowerCase()) {
      return agentId;
    }
  }
  return null;
};

export const isAntigravitySession = (session: Session | null | undefined): boolean =>
  Boolean(getAcpSessionFolderMeta(session));

