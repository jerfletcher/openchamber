import { describe, expect, it } from 'bun:test';
import { transformAgyUsagePayload } from './index.js';

describe('antigravity quota provider', () => {
  it('groups usage by model group and 5h/weekly windows like agy /usage', () => {
    const payload = {
      command: {
        name: 'usage',
        data: {
          groups: [
            {
              name: 'Gemini Models',
              buckets: [
                {
                  id: 'gemini-weekly',
                  window: 'weekly',
                  remaining_fraction: 0.24,
                  reset_time: '2026-12-03T07:10:46Z'
                },
                {
                  id: 'gemini-5h',
                  window: '5h',
                  remaining_fraction: 0.98,
                  reset_time: '2026-11-27T19:05:41Z'
                }
              ]
            },
            {
              name: 'Claude and GPT models',
              buckets: [
                {
                  id: '3p-weekly',
                  window: 'weekly',
                  remaining_fraction: 0.2,
                  reset_time: '2026-12-02T22:43:14Z'
                },
                {
                  id: '3p-5h',
                  window: '5h',
                  remaining_fraction: 1,
                  reset_time: '1970-01-01T00:00:00Z'
                }
              ]
            }
          ]
        }
      }
    };

    const windows = transformAgyUsagePayload(payload);
    expect(Object.keys(windows)).toEqual([
      'Gemini Models (weekly)',
      'Gemini Models (5h)',
      'Claude and GPT models (weekly)',
      'Claude and GPT models (5h)'
    ]);

    expect(windows['Gemini Models (weekly)'].usedPercent).toBe(76);
    expect(windows['Gemini Models (weekly)'].windowSeconds).toBe(7 * 24 * 60 * 60);
    expect(windows['Gemini Models (weekly)'].resetAt).toBe(Date.parse('2026-12-03T07:10:46Z'));

    expect(windows['Gemini Models (5h)'].usedPercent).toBe(2);
    expect(windows['Gemini Models (5h)'].windowSeconds).toBe(5 * 60 * 60);

    expect(windows['Claude and GPT models (5h)'].usedPercent).toBe(0);
    expect(windows['Claude and GPT models (5h)'].resetAt).toBeNull();
  });
});
