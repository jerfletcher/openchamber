import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { buildExecutionTree, extractSessionPlanItems } from './swarmPlanProgress';

const rec = (role: string, text: string) => ({ info: { role }, parts: [{ type: 'text', text }] }) as never;
const sess = (id: string, parentID?: string, created = 0) => ({ id, parentID, time: { created } }) as unknown as Session;

describe('extractSessionPlanItems', () => {
  test('parses checklists with nested sub-bullets and merges latest status', () => {
    const items = extractSessionPlanItems([
      rec('assistant', '- [ ] Build helper\n  - write tests\n- [ ] Wire UI'),
      rec('assistant', '- [x] Build helper\n  - [x] write tests\n- [~] Wire UI'),
    ]);
    expect(items.map((i) => i.status)).toEqual(['done', 'current']);
    expect(items[0].children).toEqual([{ id: 'write tests', text: 'write tests', status: 'done' }]);
  });
  test('plain sub-bullets under a checklist item', () => {
    const items = extractSessionPlanItems([rec('user', '1. [!] Deploy\n   - needs approval')]);
    expect(items[0].status).toBe('blocked');
    expect(items[0].children[0].text).toBe('needs approval');
  });
  test('parses Steps blocks', () => {
    const items = extractSessionPlanItems([
      rec('assistant', 'Steps([{ title: "Research", status: "done" }, { title: "Build", status: "current" }])'),
    ]);
    expect(items.map((i) => [i.text, i.status])).toEqual([['Research', 'done'], ['Build', 'current']]);
  });
});

describe('buildExecutionTree', () => {
  test('attaches grandchildren chronologically, skipping workflow agents', () => {
    const op = sess('op', 'lead', 1);
    const tree = buildExecutionTree(
      [{ child: op, busy: true, failed: false }],
      [op, sess('g2', 'op', 5), sess('g1', 'op', 2), sess('wf', 'op', 3)],
      { g1: { type: 'busy' } },
      new Set(['wf']),
    );
    expect(tree[0].status).toBe('busy');
    expect(tree[0].children.map((c) => [c.id, c.status])).toEqual([['g1', 'busy'], ['g2', 'done']]);
  });
});
