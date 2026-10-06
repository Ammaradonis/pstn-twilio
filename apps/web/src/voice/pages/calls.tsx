import type { VoiceCallLogItemDto } from '@pstn-twilio/shared';
import { useMemo, useState } from 'react';

import { useCalls } from '../components/call-manager';
import { Icon, type IconName } from '../components/icons';
import { NumberSheet } from '../components/number-sheet';
import {
  Avatar,
  EmptyState,
  IconButton,
  PageLoading,
  PrimaryButton,
  TextButton,
} from '../components/ui';
import { VoicemailPlayer } from '../components/voicemail-player';
import { useMarkRead } from '../hooks/use-voice-actions';
import { useCallLog, useContactLookup, useForwarding, useUnread } from '../hooks/use-voice-data';
import {
  formatCallLength,
  formatClock,
  formatFullDate,
  formatListTime,
  formatNumber,
  groupByDay,
} from '../lib/format';

const OUTCOMES: Record<string, string> = {
  NO_ANSWER: 'No answer',
  BUSY: 'Busy',
  CANCELED: 'Canceled',
  FAILED: "Didn't connect",
};

function isLive(item: VoiceCallLogItemDto): boolean {
  return !item.endedAt && ['INITIATED', 'RINGING', 'IN_PROGRESS'].includes(item.status);
}

export function callDescription(
  item: VoiceCallLogItemDto,
  linkedLabel: (e164: string) => string | null,
): { icon: IconName; tone: string; text: string } {
  const length = formatCallLength(item.durationSeconds);
  if (item.kind === 'outgoing') {
    const outcome = item.answeredAt
      ? length
      : (OUTCOMES[item.status] ?? (isLive(item) ? 'Calling…' : ''));
    return {
      icon: 'outgoing',
      tone: 'text-gv-muted',
      text: ['Outgoing', outcome].filter(Boolean).join(' · '),
    };
  }
  if (item.kind === 'answered') {
    const where = item.handledBy?.startsWith('phone:')
      ? `on ${linkedLabel(item.handledBy.slice(6)) ?? formatNumber(item.handledBy.slice(6))}`
      : '';
    return {
      icon: 'incoming',
      tone: 'text-gv-green',
      text: ['Incoming', isLive(item) ? 'On call' : length, where].filter(Boolean).join(' · '),
    };
  }
  if (item.kind === 'voicemail') {
    return {
      icon: 'voicemail',
      tone: 'text-gv-blue',
      text: `Voicemail · ${formatCallLength(item.voicemail?.durationSeconds) || 'new'}`,
    };
  }
  if (item.kind === 'declined') {
    return {
      icon: 'callEnd',
      tone: 'text-gv-muted',
      text: 'Declined',
    };
  }
  if (item.kind === 'blocked') {
    return {
      icon: 'block',
      tone: 'text-gv-red',
      text: 'Blocked',
    };
  }
  if (isLive(item)) return { icon: 'incoming', tone: 'text-gv-blue', text: 'Ringing…' };
  return { icon: 'missed', tone: 'text-gv-red', text: 'Missed call' };
}

export function CallsPage() {
  const [filter, setFilter] = useState<'all' | 'missed'>('all');
  const log = useCallLog(filter);
  const lookup = useContactLookup();
  const { data: unread } = useUnread();
  const { data: forwarding } = useForwarding();
  const { placeCall, openDialer } = useCalls();
  const [selected, setSelected] = useState<VoiceCallLogItemDto | null>(null);
  useMarkRead('calls', (unread?.missedCalls ?? 0) > 0);

  const items = useMemo(() => log.data?.pages.flatMap((page) => page.items) ?? [], [log.data]);
  const groups = useMemo(() => groupByDay(items, (item) => item.startedAt), [items]);
  const linkedLabel = (e164: string) => forwarding?.find((f) => f.e164 === e164)?.label ?? null;
  const history = selected
    ? items.filter((item) => item.counterpart === selected.counterpart).slice(0, 8)
    : [];

  if (log.isLoading) return <PageLoading />;
  if (log.isError) {
    return (
      <EmptyState
        icon="refresh"
        title="Couldn't load your calls"
        action={<PrimaryButton onClick={() => void log.refetch()}>Try again</PrimaryButton>}
      />
    );
  }
  if (items.length === 0 && filter === 'all') {
    return (
      <EmptyState
        icon="phone"
        title="No calls yet"
        body="Calls you make and receive with your Voice number show up here."
        action={<PrimaryButton onClick={() => openDialer()}>Make a call</PrimaryButton>}
      />
    );
  }

  return (
    <div>
      <div className="flex gap-2 px-4 pt-3">
        {(['all', 'missed'] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            aria-pressed={filter === value}
            className={`rounded-full px-3 py-1 text-sm ${
              filter === value ? 'bg-gv-blue text-white' : 'bg-gv-soft text-gv-ink hover:bg-gv-line'
            }`}
          >
            {value === 'all' ? 'All' : 'Missed'}
          </button>
        ))}
      </div>
      {items.length === 0 ? (
        <EmptyState
          icon="phone"
          title="No missed calls"
          body="Calls that rang out without an answer show up here."
        />
      ) : null}
      {groups.map((group) => (
        <section key={group.day}>
          <h2 className="px-4 pb-1 pt-4 text-xs font-medium uppercase tracking-wide text-gv-muted">
            {group.day}
          </h2>
          <ul>
            {group.items.map((item) => {
              const contact = lookup(item.counterpart);
              const description = callDescription(item, linkedLabel);
              const missed = item.kind === 'missed' && !isLive(item);
              return (
                <li key={item.id} className="flex items-center gap-1 pr-2 hover:bg-gv-surface">
                  <button
                    type="button"
                    onClick={() => setSelected(item)}
                    className="flex min-w-0 flex-1 items-center gap-4 py-2.5 pl-4 text-left"
                  >
                    <Avatar name={contact?.name ?? null} seed={contact?.id ?? item.counterpart} />
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate text-[15px] ${missed ? 'font-medium text-gv-red' : 'text-gv-ink'}`}
                      >
                        {contact?.name ?? formatNumber(item.counterpart)}
                      </span>
                      <span className="flex items-center gap-1 text-sm text-gv-muted">
                        <Icon
                          name={description.icon}
                          className={`h-4 w-4 shrink-0 ${description.tone}`}
                        />
                        <span className="truncate">{description.text}</span>
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-gv-muted">
                      {formatListTime(item.startedAt)}
                    </span>
                  </button>
                  <IconButton
                    icon="phone"
                    label={`Call ${contact?.name ?? formatNumber(item.counterpart)}`}
                    onClick={() => void placeCall(item.counterpart)}
                    className="text-gv-green"
                  />
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {log.hasNextPage ? (
        <div className="flex justify-center py-4">
          <TextButton onClick={() => void log.fetchNextPage()} disabled={log.isFetchingNextPage}>
            {log.isFetchingNextPage ? 'Loading…' : 'Show older calls'}
          </TextButton>
        </div>
      ) : null}

      <NumberSheet
        e164={selected?.counterpart ?? null}
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
      >
        {selected?.voicemail ? (
          <div className="space-y-2 px-6 py-4">
            <p className="text-xs font-medium uppercase tracking-wide text-gv-muted">Voicemail</p>
            <VoicemailPlayer
              id={selected.voicemail.id}
              durationSeconds={selected.voicemail.durationSeconds}
              heard={selected.voicemail.heard}
            />
            {selected.voicemail.transcript ? (
              <p className="text-sm text-gv-ink">{selected.voicemail.transcript}</p>
            ) : null}
          </div>
        ) : null}
        {history.length > 0 ? (
          <div className="px-6 py-4">
            <p className="text-xs font-medium uppercase tracking-wide text-gv-muted">Recent</p>
            <ul className="mt-2 space-y-2">
              {history.map((item) => {
                const description = callDescription(item, linkedLabel);
                return (
                  <li key={item.id} className="flex items-center gap-3 text-sm">
                    <Icon name={description.icon} className={`h-4 w-4 ${description.tone}`} />
                    <span className="flex-1 text-gv-ink">{description.text}</span>
                    <span className="text-xs text-gv-muted" title={formatFullDate(item.startedAt)}>
                      {formatListTime(item.startedAt) === formatClock(item.startedAt)
                        ? formatClock(item.startedAt)
                        : `${formatListTime(item.startedAt)}, ${formatClock(item.startedAt)}`}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </NumberSheet>
    </div>
  );
}
