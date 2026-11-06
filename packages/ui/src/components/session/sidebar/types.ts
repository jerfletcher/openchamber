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

export const isAntigravitySession = (session: Session | null | undefined): boolean => {
  if (!session) return false;
  if (typeof session.id === 'string' && (session.id.startsWith('ses_agy_') || session.id.startsWith('ses_acp_'))) return true;
  if (session.agent === 'antigravity') return true;
  if (session.model?.providerID === 'antigravity') return true;
  if ((session as { acpSessionId?: string }).acpSessionId) return true;
  return false;
};

