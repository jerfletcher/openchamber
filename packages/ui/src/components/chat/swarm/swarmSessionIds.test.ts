import { describe, expect, test } from 'bun:test';

import type { Session } from '@/lib/opencode/model';
import { collectWorkflowAgentIds, computeSwarmSessionIds, computeSwarmSessions } from './swarmSessionIds';

/** Only the fields the swarm filter reads; the rest of `Session` is irrelevant here. */
const session = (id: string, parentID?: string, workflowAgent = false): Session => ({
  id,
  parentID,
  projectID: 'project',
  directory: '/project',
  title: id,
  cost: 0,
  tokens: {},
  time: { created: 0, updated: 0 },
  ...(workflowAgent ? { metadata: { openchamber: { kind: 'workflow-agent' } } } : {}),
}) as Session;

describe('computeSwarmSessionIds', () => {
  test('takes direct children of the deck owner, in observed order', () => {
    const live = [
      session('lead'),
      session('child-a', 'lead'),
      session('grandchild', 'child-a'),
      session('child-b', 'lead'),
      session('other-root'),
      session('other-child', 'other-root'),
    ];

    expect(computeSwarmSessionIds(live, 'lead', new Set())).toEqual(['child-a', 'child-b']);
  });

  test('excludes workflow-agent sessions by their server mark', () => {
    const live = [
      session('lead'),
      session('child', 'lead'),
      session('workflow', 'lead', true),
    ];

    expect(computeSwarmSessionIds(live, 'lead', new Set())).toEqual(['child']);
  });

  test('excludes workflow-agent sessions the runs reported', () => {
    const live = [session('lead'), session('child', 'lead'), session('run-agent', 'lead')];

    expect(computeSwarmSessionIds(live, 'lead', new Set(['run-agent']))).toEqual(['child']);
    expect(computeSwarmSessionIds(live, 'lead', new Set())).toEqual(['child', 'run-agent']);
  });

  test('is empty without an owning session, and the sessions it discards are not returned', () => {
    const live = [session('lead'), session('child', 'lead')];

    expect(computeSwarmSessionIds(live, null, new Set())).toEqual([]);
    expect(computeSwarmSessions(live, 'lead', new Set()).map((entry) => entry.id)).toEqual(['child']);
  });
});

describe('collectWorkflowAgentIds', () => {
  test('collects every started agent session of every run', () => {
    const ids = collectWorkflowAgentIds([
      { agents: [{ sessionId: 'a' }, { sessionId: null }, {}] },
      { agents: [{ sessionId: 'b' }] },
    ]);

    expect([...ids].sort()).toEqual(['a', 'b']);
  });
});
