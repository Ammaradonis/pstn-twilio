import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import type { RedisService } from '../redis/redis.service';

import { BATCH, FB_STAGES, FbGroupsService, planOf, stageOf, statusOf } from './fb-groups.service';

type Run = Record<string, unknown> & { id: string; userId: string; status: string };

/** Enough of Prisma to be honest: findFirst reads back what create wrote. */
function fakePrisma() {
  const runs: Run[] = [];
  const matches = (run: Run, where: Record<string, unknown> = {}) => {
    if (typeof where.id === 'string' && run.id !== where.id) return false;
    if (typeof where.userId === 'string' && run.userId !== where.userId) return false;
    const status = where.status as string | { in?: string[] } | undefined;
    if (typeof status === 'string' && run.status !== status) return false;
    if (status && typeof status === 'object' && status.in && !status.in.includes(run.status)) {
      return false;
    }
    return true;
  };
  return {
    runs,
    fbGroupsRun: {
      findFirst: async ({ where }: { where?: Record<string, unknown> } = {}) =>
        runs.filter((run) => matches(run, where)).at(-1) ?? null,
      findUnique: async ({ where }: { where: { id: string } }) =>
        runs.find((run) => run.id === where.id) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const run: Run = {
          id: 'run-1',
          userId: '',
          searches: 0,
          groupsFound: 0,
          joined: 0,
          likes: 0,
          comments: 0,
          replies: 0,
          follows: 0,
          dms: 0,
          reviewQueued: 0,
          note: null,
          plan: null,
          stage: 'SEARCH',
          status: 'RUNNING',
          startedAt: new Date(),
          updatedAt: new Date(),
          ...(data as object),
        } as Run;
        runs.push(run);
        return run;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const run = runs.find((row) => row.id === where.id);
        if (!run) throw new Error('missing run');
        Object.assign(run, data);
        return run;
      },
    },
  };
}

function fakeRedis(lastSeen: string | null = null) {
  return { client: { get: async () => lastSeen } };
}

const service = (prisma: unknown, redis: unknown) =>
  new FbGroupsService(prisma as unknown as PrismaService, redis as unknown as RedisService);

describe('facebook groups run', () => {
  it('knows which stages and statuses this build may trust', () => {
    expect(FB_STAGES).toContain(stageOf('ENGAGE'));
    // A row written by a newer build must not crash an older API.
    expect(stageOf('SPAMMING')).toBe('SEARCH');
    expect(statusOf('RUNNING')).toBe('RUNNING');
    expect(statusOf('nonsense')).toBe('CANCELLED');
  });

  it('gives every stage a batch that adds up', () => {
    for (const stage of FB_STAGES) {
      const batch = BATCH[stage];
      // A batch that asks for work in a stage other than its own would have the
      // worker doing two things in one tick, which is how caps get skipped.
      const active = Object.entries(batch).filter(([, value]) => value > 0);
      expect(active.length).toBe(1);
      expect(active[0]![0]).toBe(
        { SEARCH: 'searches', JOIN: 'joins', ENGAGE: 'engagements', OUTREACH: 'dms' }[stage],
      );
    }
  });

  it('reads the plan the worker reported, and null before it has one', () => {
    expect(planOf(null)).toBeNull();
    expect(planOf({ addresses: 27_965, covered: 27_965, searches: 49_083, uncovered: 0 })).toEqual({
      addresses: 27_965,
      covered: 27_965,
      searches: 49_083,
      uncovered: 0,
      builtAt: null,
    });
  });

  it('starts one run and resumes it rather than starting a second', async () => {
    const prisma = fakePrisma();
    const groups = service(prisma, fakeRedis());

    const first = await groups.start('user-1');
    expect(first.runId).toBe('run-1');
    expect(first.status).toBe('RUNNING');

    const second = await groups.start('user-1');
    expect(prisma.runs).toHaveLength(1);
    expect(second.runId).toBe('run-1');
  });

  it('reports the worker as offline until it checks in', async () => {
    const prisma = fakePrisma();
    const offline = await service(prisma, fakeRedis(null)).status('user-1');
    expect(offline.workerOnline).toBe(false);

    const prisma2 = fakePrisma();
    const seen = new Date().toISOString();
    const online = await service(prisma2, fakeRedis(seen)).status('user-1');
    expect(online.workerOnline).toBe(true);
    expect(online.workerLastSeen).toBe(seen);
  });

  it('hands the worker the open run and the stage batch', async () => {
    const prisma = fakePrisma();
    await service(prisma, fakeRedis()).start('user-1');
    const tick = await service(prisma, fakeRedis()).tick();
    expect(tick.run).toEqual({ id: 'run-1', status: 'RUNNING', stage: 'SEARCH' });
    expect(tick.batch).toEqual(BATCH.SEARCH);
  });

  it('says nothing to do when no run is open', async () => {
    const tick = await service(fakePrisma(), fakeRedis()).tick();
    expect(tick).toEqual({ run: null, batch: null });
  });

  it('accumulates the deltas the worker posts', async () => {
    const prisma = fakePrisma();
    const groups = service(prisma, fakeRedis());
    await groups.start('user-1');

    await groups.progress({
      runId: 'run-1',
      searches: 3,
      groupsFound: 2,
      stage: 'SEARCH',
      note: '3 search(es), 2 new group(s)',
      plan: { addresses: 27_965, covered: 27_965, searches: 49_083, uncovered: 0, builtAt: null },
    });
    await groups.progress({ runId: 'run-1', likes: 4, comments: 1, stage: 'ENGAGE' });

    const status = await groups.status('user-1');
    expect(status.searches).toBe(3);
    expect(status.groupsFound).toBe(2);
    expect(status.likes).toBe(4);
    expect(status.comments).toBe(1);
    expect(status.stage).toBe('ENGAGE');
    expect(status.note).toBe('3 search(es), 2 new group(s)');
    expect(status.plan?.covered).toBe(27_965);
  });

  it('ignores nonsense counts instead of corrupting the scoreboard', async () => {
    const prisma = fakePrisma();
    const groups = service(prisma, fakeRedis());
    await groups.start('user-1');
    await groups.progress({ runId: 'run-1', searches: Number.NaN, likes: -5, stage: 'SEARCH' });
    const status = await groups.status('user-1');
    expect(status.searches).toBe(0);
    expect(status.likes).toBe(0);
  });

  it('pauses, resumes and stops', async () => {
    const prisma = fakePrisma();
    const groups = service(prisma, fakeRedis());
    await groups.start('user-1');

    expect((await groups.setStatus('user-1', 'run-1', 'PAUSED')).status).toBe('PAUSED');
    expect((await groups.setStatus('user-1', 'run-1', 'RUNNING')).status).toBe('RUNNING');
    const stopped = await groups.setStatus('user-1', 'run-1', 'CANCELLED');
    expect(stopped.status).toBe('CANCELLED');
    // A stopped run is not handed to the worker again.
    expect((await groups.tick()).run).toBeNull();
  });

  it('will not touch another user’s run', async () => {
    const prisma = fakePrisma();
    const groups = service(prisma, fakeRedis());
    await groups.start('user-1');
    await expect(groups.setStatus('user-2', 'run-1', 'PAUSED')).rejects.toThrow();
  });
});
