import type { Session } from '@/lib/opencode/model';
import { isWorkflowAgentSession } from '@/lib/sessionWorkflowMetadata';

export interface WorkflowRunLike {
  agents: ReadonlyArray<{ sessionId?: string | null }>;
}

/**
 * The session ids of a workflow run's agent sessions. Kept beside the filter
 * that consumes it so the two cannot drift: a workflow run spawns its agents
 * as children of the proposing session, but the tiled view is not the place to
 * show them (the run card is).
 */
export const collectWorkflowAgentIds = (runs: readonly WorkflowRunLike[]): Set<string> => new Set(
  runs.flatMap((run) => run.agents.flatMap((agent) => (agent.sessionId ? [agent.sessionId] : []))),
);

/**
 * Which sessions the swarm preset tiles: exactly the direct children of the
 * session that owns the deck, minus workflow-agent sessions. This is the set
 * the pre-generic `TiledSwarmView` computed inline; it stays here (a pure
 * function, no React) so it can be asserted directly.
 */
export const computeSwarmSessions = (
  liveSessions: readonly Session[],
  currentSessionId: string | null,
  workflowAgentIds: ReadonlySet<string>,
): Session[] => (currentSessionId
  ? liveSessions.filter((candidate) => candidate.parentID === currentSessionId
    && !workflowAgentIds.has(candidate.id)
    && !isWorkflowAgentSession(candidate))
  : []);

/** The ids `computeSwarmSessions` selects, in the order they were observed. */
export const computeSwarmSessionIds = (
  liveSessions: readonly Session[],
  currentSessionId: string | null,
  workflowAgentIds: ReadonlySet<string>,
): string[] => computeSwarmSessions(liveSessions, currentSessionId, workflowAgentIds)
  .map((candidate) => candidate.id);
