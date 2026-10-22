/**
 * Facebook groups.
 *
 * The Dial page's "FB groups" button creates one rolling run per user. The
 * worker on the user's PC (workers/email-finder) drives it: it claims a batch
 * with `tick()`, does the phone work, and posts deltas back with `progress()`.
 * This service only keeps the scoreboard — it never decides what the worker
 * should do next, because the worker is the one holding the search plan, the
 * phone's state and the caps.
 *
 * Why a run and not a queue of rows: the work is a pipeline (search → join →
 * engage → outreach) that loops, and each step costs the account differently. A
 * queue of "rows" would let the API schedule a comment it has no way to rate
 * limit; a run lets the worker pace everything against one set of counters.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  FbGroupsPlanDto,
  FbGroupsStage,
  FbGroupsStatusDto,
  FbGroupsRunStatus,
} from '@pstn-twilio/shared';

import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const WORKER_SEEN_KEY = 'email-finder:worker:last-seen';
const WORKER_ONLINE_MS = 2 * 60_000;

export const FB_STAGES: readonly FbGroupsStage[] = ['SEARCH', 'JOIN', 'ENGAGE', 'OUTREACH'];

/** How much one tick may do. Deliberately small: the worker polls often. */
export const BATCH: Record<
  FbGroupsStage,
  { searches: number; joins: number; engagements: number; dms: number }
> = {
  SEARCH: { searches: 3, joins: 0, engagements: 0, dms: 0 },
  JOIN: { searches: 0, joins: 2, engagements: 0, dms: 0 },
  ENGAGE: { searches: 0, joins: 0, engagements: 1, dms: 0 },
  OUTREACH: { searches: 0, joins: 0, engagements: 0, dms: 2 },
};

export interface FbGroupsProgress {
  runId: string;
  searches?: number;
  groupsFound?: number;
  joined?: number;
  likes?: number;
  comments?: number;
  replies?: number;
  follows?: number;
  dms?: number;
  reviewQueued?: number;
  stage?: FbGroupsStage;
  note?: string;
  plan?: FbGroupsPlanDto;
}

export interface FbGroupsTickDto {
  run: { id: string; status: FbGroupsRunStatus; stage: FbGroupsStage } | null;
  batch: (typeof BATCH)[FbGroupsStage] | null;
}

type RunRow = {
  id: string;
  status: string;
  stage: string;
  searches: number;
  groupsFound: number;
  joined: number;
  likes: number;
  comments: number;
  replies: number;
  follows: number;
  dms: number;
  reviewQueued: number;
  note: string | null;
  plan: unknown;
  startedAt: Date;
  updatedAt: Date;
};

/** A stage from the database is only trusted if it is one this build knows. */
export function stageOf(value: unknown): FbGroupsStage {
  return FB_STAGES.includes(value as FbGroupsStage) ? (value as FbGroupsStage) : 'SEARCH';
}

export function statusOf(value: unknown): FbGroupsRunStatus {
  return ['RUNNING', 'PAUSED', 'DONE', 'CANCELLED'].includes(value as string)
    ? (value as FbGroupsRunStatus)
    : 'CANCELLED';
}

/** The plan the worker reported, or null when it has not built one yet. */
export function planOf(value: unknown): FbGroupsPlanDto | null {
  if (!value || typeof value !== 'object') return null;
  const plan = value as Record<string, unknown>;
  const num = (key: string) => (Number.isFinite(Number(plan[key])) ? Number(plan[key]) : 0);
  return {
    addresses: num('addresses'),
    covered: num('covered'),
    searches: num('searches'),
    uncovered: num('uncovered'),
    builtAt: typeof plan.builtAt === 'string' ? plan.builtAt : null,
  };
}

@Injectable()
export class FbGroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** The Dial page button. Reuses an open run rather than starting a second one. */
  async start(userId: string): Promise<FbGroupsStatusDto> {
    const open = await this.prisma.fbGroupsRun.findFirst({
      where: { userId, status: { in: ['RUNNING', 'PAUSED'] } },
      orderBy: { updatedAt: 'desc' },
    });
    if (open) {
      if (open.status !== 'RUNNING') {
        await this.prisma.fbGroupsRun.update({
          where: { id: open.id },
          data: { status: 'RUNNING', note: 'resumed from the Dial page' },
        });
      }
      return this.status(userId);
    }
    await this.prisma.fbGroupsRun.create({
      data: { userId, status: 'RUNNING', stage: 'SEARCH', note: 'waiting for the worker' },
    });
    return this.status(userId);
  }

  async status(userId: string): Promise<FbGroupsStatusDto> {
    const run = await this.prisma.fbGroupsRun.findFirst({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    });
    const lastSeen = await this.redis.client.get(WORKER_SEEN_KEY).catch(() => null);
    const workerOnline = Boolean(lastSeen && Date.now() - Date.parse(lastSeen) < WORKER_ONLINE_MS);
    return this.toDto(run as RunRow | null, workerOnline, lastSeen);
  }

  async setStatus(
    userId: string,
    runId: string,
    status: Extract<FbGroupsRunStatus, 'RUNNING' | 'PAUSED' | 'CANCELLED'>,
  ): Promise<FbGroupsStatusDto> {
    const run = await this.prisma.fbGroupsRun.findFirst({ where: { id: runId, userId } });
    if (!run) throw new NotFoundException('No Facebook groups run with that id.');
    const finishing = status === 'CANCELLED';
    await this.prisma.fbGroupsRun.update({
      where: { id: run.id },
      data: {
        status,
        finishedAt: finishing ? new Date() : null,
        note: finishing ? 'stopped from the Dial page' : run.note,
      },
    });
    return this.status(userId);
  }

  /** Worker: the one run to work on, and how much of it this batch may do. */
  async tick(): Promise<FbGroupsTickDto> {
    const run = await this.prisma.fbGroupsRun.findFirst({
      where: { status: 'RUNNING' },
      orderBy: { updatedAt: 'asc' },
    });
    if (!run) return { run: null, batch: null };
    const stage = stageOf(run.stage);
    return {
      run: { id: run.id, status: 'RUNNING', stage },
      batch: BATCH[stage],
    };
  }

  /** Worker: what the last batch did, and the stage the run has reached. */
  async progress(body: FbGroupsProgress): Promise<{ ok: true; stage: FbGroupsStage }> {
    const run = await this.prisma.fbGroupsRun.findUnique({ where: { id: body.runId } });
    if (!run) throw new NotFoundException('No Facebook groups run with that id.');
    const stage = body.stage ? stageOf(body.stage) : stageOf(run.stage);
    const count = (value: number | undefined) =>
      Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 0;
    await this.prisma.fbGroupsRun.update({
      where: { id: run.id },
      data: {
        stage,
        searches: run.searches + count(body.searches),
        groupsFound: run.groupsFound + count(body.groupsFound),
        joined: run.joined + count(body.joined),
        likes: run.likes + count(body.likes),
        comments: run.comments + count(body.comments),
        replies: run.replies + count(body.replies),
        follows: run.follows + count(body.follows),
        dms: run.dms + count(body.dms),
        reviewQueued: run.reviewQueued + count(body.reviewQueued),
        note: body.note?.slice(0, 500) ?? run.note,
        ...(body.plan ? { plan: body.plan as unknown as object } : {}),
      },
    });
    return { ok: true, stage };
  }

  private toDto(
    run: RunRow | null,
    workerOnline: boolean,
    workerLastSeen: string | null,
  ): FbGroupsStatusDto {
    if (!run) {
      return {
        runId: null,
        status: null,
        stage: null,
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
        startedAt: null,
        updatedAt: null,
        workerOnline,
        workerLastSeen,
        plan: null,
      };
    }
    return {
      runId: run.id,
      status: statusOf(run.status),
      stage: stageOf(run.stage),
      searches: run.searches,
      groupsFound: run.groupsFound,
      joined: run.joined,
      likes: run.likes,
      comments: run.comments,
      replies: run.replies,
      follows: run.follows,
      dms: run.dms,
      reviewQueued: run.reviewQueued,
      note: run.note,
      startedAt: run.startedAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
      workerOnline,
      workerLastSeen,
      plan: planOf(run.plan),
    };
  }
}
