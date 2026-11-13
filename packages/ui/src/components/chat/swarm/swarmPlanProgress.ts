import type { Session as SessionInfo } from '@/lib/opencode/model';
import type { SessionMessageRecord } from '@/lib/exportSession';

export type PlanStatus = 'done' | 'current' | 'todo' | 'blocked';

export interface PlanSubBullet {
  id: string;
  text: string;
  status: PlanStatus;
}

export interface PlanBullet {
  id: string;
  text: string;
  status: PlanStatus;
  children: PlanSubBullet[];
}

export interface ExecutionChild {
  id: string;
  session: SessionInfo;
  status: 'busy' | 'done' | 'failed';
}

export interface ExecutionNode {
  id: string;
  session: SessionInfo;
  status: 'busy' | 'done' | 'failed';
  children: ExecutionChild[];
}

type RowLike = { child: SessionInfo; busy: boolean; failed: boolean };

const CHECK_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+\[([ xX~!-])\]\s+(.+)$/;
const SUB_RE = /^(\s{2,})[-*+]\s+(.+)$/;
const STEPS_RE = /Steps\(\s*\[([\s\S]*?)\]\s*\)/g;
const STEP_ITEM_RE = /\{\s*title:\s*"((?:[^"\\]|\\.)*)"\s*,\s*status:\s*"(done|current|todo|blocked)"/g;

const markerStatus = (marker: string): PlanStatus => {
  if (marker === 'x' || marker === 'X') return 'done';
  if (marker === '~') return 'current';
  if (marker === '!') return 'blocked';
  return 'todo';
};

const normalize = (text: string) => text.toLowerCase().replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();

const parseText = (text: string): PlanBullet[] => {
  const out: PlanBullet[] = [];
  let inCode = false;
  let current: PlanBullet | null = null;
  let parentIndent = 0;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) { inCode = !inCode; continue; }
    if (inCode) continue;
    const check = CHECK_RE.exec(line);
    if (check) {
      const indent = check[1].length;
      const status = markerStatus(check[2]);
      const body = check[3].trim();
      if (current && indent > parentIndent) {
        current.children.push({ id: normalize(body), text: body, status });
      } else {
        current = { id: normalize(body), text: body, status, children: [] };
        parentIndent = indent;
        out.push(current);
      }
      continue;
    }
    const sub = SUB_RE.exec(line);
    if (sub && current && sub[1].length > parentIndent) {
      const body = sub[2].trim();
      current.children.push({ id: normalize(body), text: body, status: current.status === 'done' ? 'done' : 'todo' });
      continue;
    }
    if (line.trim() === '') continue;
    if (!sub) current = null;
  }
  return out;
};

const parseSteps = (text: string): PlanBullet[] => {
  const out: PlanBullet[] = [];
  for (const block of text.matchAll(STEPS_RE)) {
    for (const item of block[1].matchAll(STEP_ITEM_RE)) {
      const title = item[1].replace(/\\"/g, '"').trim();
      if (title) out.push({ id: normalize(title), text: title, status: item[2] as PlanStatus, children: [] });
    }
  }
  return out;
};

export function extractSessionPlanItems(records: SessionMessageRecord[]): PlanBullet[] {
  const merged = new Map<string, PlanBullet>();
  for (const record of records) {
    const role = record.info?.role;
    if (role !== 'assistant' && role !== 'user') continue;
    for (const part of record.parts ?? []) {
      const p = part as { type?: string; text?: string };
      if (p.type !== 'text' || typeof p.text !== 'string') continue;
      const items = [...parseText(p.text), ...(role === 'assistant' ? parseSteps(p.text) : [])];
      for (const item of items) {
        if (!item.id) continue;
        merged.set(item.id, item);
      }
    }
  }
  return [...merged.values()];
}

export function buildExecutionTree(
  rows: RowLike[],
  allSessions: SessionInfo[],
  statuses: Record<string, { type?: string } | undefined>,
  workflowAgentIds: Set<string>,
): ExecutionNode[] {
  const resolve = (id: string): ExecutionChild['status'] => {
    const type = statuses[id]?.type;
    return type === 'busy' || type === 'retry' ? 'busy' : 'done';
  };
  return rows
    .slice()
    .sort((a, b) => (a.child.time?.created ?? 0) - (b.child.time?.created ?? 0))
    .map((row) => ({
      id: row.child.id,
      session: row.child,
      status: row.busy ? 'busy' as const : row.failed ? 'failed' as const : 'done' as const,
      children: allSessions
        .filter((s) => s.parentID === row.child.id && !workflowAgentIds.has(s.id))
        .sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))
        .map((s) => ({ id: s.id, session: s, status: resolve(s.id) })),
    }));
}
