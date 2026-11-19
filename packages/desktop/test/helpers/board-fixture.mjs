// The agent's board as contract D30 v4 writes it (briefs/contract-d30-board.md): a row's `board` and the
// `oats inspect --home <h> --board --json` answer's, for the agent view's tests. Times are fixed.
export const AT = '2026-11-19T10:00:00.000Z';
export const NOW = Date.parse('2026-11-19T10:04:00.000Z');
export const fact = (key, extra = {}) => ({ key, label: `${key} label`, value: '0.4312', unit: null, link: null, at: AT, ...extra });
export const question = (id, extra = {}) => ({ id, question: `Squash ${id}?`, options: ['Yes, one clean commit', 'No, keep them'], hasContext: false, since: AT, ...extra });
export const board = (extra = {}) => ({ facts: [fact('score', { label: 'best nDCG@10', value: '0.4312' }), fact('pr', { label: 'PR', value: '#1990', link: 'https://github.com/oats-project/oats/pull/1990' })],
  questions: [question('q1'), question('q2', { options: ['Merge', 'Wait', 'Close'] })], ...extra });
export const detail = () => ({ operationsApi: 2, board: {
  facts: [{ ...fact('score'), history: [{ value: '0.40', at: '2026-11-19T09:00:00.000Z' }, { value: '0.42', at: '2026-11-19T09:30:00.000Z' }, { value: '0.4312', at: AT }] }],
  questions: [{ ...question('q1'), hasContext: true, context: 'Three commits:\nfix, test, docs.' }] } });
