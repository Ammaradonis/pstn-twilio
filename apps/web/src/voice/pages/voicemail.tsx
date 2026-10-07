import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useCalls } from '../components/call-manager';
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
import { useContactLookup, useVoicemail } from '../hooks/use-voice-data';
import { formatFullDate, formatListTime, formatNumber, formatTimer } from '../lib/format';

export function VoicemailPage() {
  const voicemail = useVoicemail();
  const lookup = useContactLookup();
  const navigate = useNavigate();
  const { placeCall } = useCalls();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const items = useMemo(
    () => voicemail.data?.pages.flatMap((page) => page.items) ?? [],
    [voicemail.data],
  );

  if (voicemail.isLoading) return <PageLoading />;
  if (voicemail.isError) {
    return (
      <EmptyState
        icon="refresh"
        title="Couldn't load your voicemail"
        action={<PrimaryButton onClick={() => void voicemail.refetch()}>Try again</PrimaryButton>}
      />
    );
  }
  if (items.length === 0) {
    return (
      <EmptyState
        icon="voicemail"
        title="No voicemail"
        body="When you miss a call, callers can leave a message. You'll listen to it here."
        action={
          <PrimaryButton onClick={() => navigate('/voice/settings#voicemail')}>
            Voicemail settings
          </PrimaryButton>
        }
      />
    );
  }

  return (
    <div>
      <ul className="pt-1">
        {items.map((item) => {
          const contact = lookup(item.from);
          const open = expanded === item.id || !item.heard;
          return (
            <li key={item.id} className="border-b border-gv-soft">
              <button
                type="button"
                onClick={() => setExpanded(expanded === item.id ? null : item.id)}
                className="flex w-full items-start gap-4 px-4 pt-3 text-left"
              >
                <Avatar name={contact?.name ?? null} seed={contact?.id ?? item.from} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span
                      className={`truncate text-[15px] ${item.heard ? 'text-gv-ink' : 'font-semibold text-gv-ink'}`}
                    >
                      {contact?.name ?? formatNumber(item.from)}
                    </span>
                    {!item.heard ? (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-gv-blue" aria-label="New" />
                    ) : null}
                  </span>
                  <span
                    className="block text-sm text-gv-muted"
                    title={formatFullDate(item.createdAt)}
                  >
                    {formatListTime(item.createdAt)} · {formatTimer(item.durationSeconds ?? 0)}
                  </span>
                </span>
              </button>
              <div className="pb-3 pl-[72px] pr-4">
                {/* Voicemail is no longer transcribed; older messages keep their text. */}
                {item.transcript ? (
                  <p className={`mt-1 text-sm text-gv-ink ${open ? '' : 'line-clamp-2'}`}>
                    {item.transcript}
                  </p>
                ) : null}
                {open ? (
                  <div className="mt-3 space-y-2">
                    <VoicemailPlayer
                      id={item.id}
                      durationSeconds={item.durationSeconds}
                      heard={item.heard}
                    />
                    <div className="flex items-center gap-1">
                      <TextButton onClick={() => void placeCall(item.from)}>Call back</TextButton>
                      <TextButton
                        onClick={() => navigate(`/voice/messages/${encodeURIComponent(item.from)}`)}
                      >
                        Message
                      </TextButton>
                      <span className="flex-1" />
                      <IconButton icon="more" label="More" onClick={() => setMenuFor(item.from)} />
                    </div>
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {voicemail.hasNextPage ? (
        <div className="flex justify-center py-4">
          <TextButton
            onClick={() => void voicemail.fetchNextPage()}
            disabled={voicemail.isFetchingNextPage}
          >
            {voicemail.isFetchingNextPage ? 'Loading…' : 'Show older voicemail'}
          </TextButton>
        </div>
      ) : null}
      <NumberSheet e164={menuFor} open={Boolean(menuFor)} onClose={() => setMenuFor(null)} />
    </div>
  );
}
