import assert from 'node:assert/strict';
import test from 'node:test';
import { LatestRequest, resumeEpisode } from '../shared/selection.ts';
import type { AnimeDetail, HistoryEntry } from '../shared/types.ts';

test('a late anime detail response cannot replace the newer selection', async () => {
  const gate = new LatestRequest();
  let finishOld!: (value: string) => void;
  let finishNew!: (value: string) => void;
  const old = new Promise<string>((resolve) => { finishOld = resolve; });
  const newer = new Promise<string>((resolve) => { finishNew = resolve; });
  let selected = '';
  const first = gate.next();
  const firstWork = old.then((value) => { if (gate.isCurrent(first)) selected = value; });
  const second = gate.next();
  const secondWork = newer.then((value) => { if (gate.isCurrent(second)) selected = value; });
  finishNew('newer');
  await secondWork;
  finishOld('old');
  await firstWork;
  assert.equal(selected, 'newer');
});

test('resume uses updatedAt rather than episode number', () => {
  const detail = { episodes: [1, 2, 3].map((number) => ({ number, label: `Episode ${number}`, audio: ['sub'] })) } as AnimeDetail;
  const progress = new Map<number, HistoryEntry>([
    [1, { updatedAt: 300, completed: false } as HistoryEntry],
    [2, { updatedAt: 100, completed: false } as HistoryEntry],
    [3, { updatedAt: 400, completed: true } as HistoryEntry],
  ]);
  assert.equal(resumeEpisode(detail, (number) => progress.get(number))?.number, 1);
  progress.get(1)!.completed = true;
  assert.equal(resumeEpisode(detail, (number) => progress.get(number))?.number, 2);
});
