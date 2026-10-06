import { normalizeDialablePhoneNumber, type SmsMessageDto } from '@pstn-twilio/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { useCalls } from '../components/call-manager';
import { Icon } from '../components/icons';
import { NumberSheet } from '../components/number-sheet';
import {
  Avatar,
  EmptyState,
  IconButton,
  PageLoading,
  PrimaryButton,
  TextButton,
  errorMessage,
  useSnackbar,
} from '../components/ui';
import { useBlocking, useMarkRead } from '../hooks/use-voice-actions';
import {
  invalidateKinds,
  useBootstrap,
  useContactLookup,
  useContacts,
  useConversations,
  useThread,
  voiceKeys,
} from '../hooks/use-voice-data';
import { searchContacts } from '../lib/contacts';
import { formatClock, formatListTime, formatNumber, groupByDay } from '../lib/format';
import { voiceApi } from '../lib/voice-api';

export function MessagesPage() {
  const { data, isLoading, isError, refetch } = useConversations();
  const lookup = useContactLookup();
  const navigate = useNavigate();

  if (isLoading) return <PageLoading />;
  if (isError) {
    return (
      <EmptyState
        icon="refresh"
        title="Couldn't load your messages"
        action={<PrimaryButton onClick={() => void refetch()}>Try again</PrimaryButton>}
      />
    );
  }
  if (!data?.length) {
    return (
      <EmptyState
        icon="message"
        title="No messages yet"
        body="Texts you send and receive with your Voice number show up here, on all your devices."
        action={
          <PrimaryButton onClick={() => navigate('/voice/messages/new')}>
            Send a message
          </PrimaryButton>
        }
      />
    );
  }
  return (
    <ul className="pt-1">
      {data.map((conversation) => {
        const contact = lookup(conversation.counterpart);
        const unread = conversation.unread > 0;
        const snippet =
          conversation.last.body ||
          (conversation.last.numMedia > 0
            ? 'Picture'
            : conversation.last.direction === 'OUTBOUND'
              ? ''
              : 'Message');
        return (
          <li key={conversation.counterpart}>
            <Link
              to={`/voice/messages/${encodeURIComponent(conversation.counterpart)}`}
              className="flex items-center gap-4 px-4 py-3 hover:bg-gv-surface"
            >
              <Avatar name={contact?.name ?? null} seed={contact?.id ?? conversation.counterpart} />
              <span className="min-w-0 flex-1">
                <span
                  className={`block truncate text-[15px] ${unread ? 'font-semibold text-gv-ink' : 'text-gv-ink'}`}
                >
                  {contact?.name ?? formatNumber(conversation.counterpart)}
                </span>
                <span
                  className={`block truncate text-sm ${unread ? 'font-medium text-gv-ink' : 'text-gv-muted'}`}
                >
                  {conversation.last.direction === 'OUTBOUND' ? 'You: ' : ''}
                  {snippet}
                </span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-1">
                <span
                  className={`text-xs ${unread ? 'font-semibold text-gv-blue' : 'text-gv-muted'}`}
                >
                  {formatListTime(conversation.last.createdAt)}
                </span>
                {unread ? (
                  <span className="h-2.5 w-2.5 rounded-full bg-gv-blue" aria-label="Unread" />
                ) : null}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function statusText(message: SmsMessageDto): { text: string; error: boolean } | null {
  if (message.direction !== 'OUTBOUND') return null;
  switch (message.status) {
    case 'QUEUED':
      return { text: 'Sending…', error: false };
    case 'SENT':
      return { text: 'Sent', error: false };
    case 'DELIVERED':
      return { text: 'Delivered', error: false };
    case 'FAILED':
    case 'UNDELIVERED':
      return {
        text: `Not delivered${message.errorMessage ? `: ${message.errorMessage}` : ''}`,
        error: true,
      };
    default:
      return null;
  }
}

export function ThreadPage() {
  const params = useParams();
  const counterpart =
    normalizeDialablePhoneNumber(params.counterpart ?? '') ?? params.counterpart ?? '';
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const snackbar = useSnackbar();
  const lookup = useContactLookup();
  const contact = lookup(counterpart);
  const { placeCall } = useCalls();
  const { isBlocked, unblock } = useBlocking();
  const thread = useThread(counterpart);
  const { data: boot } = useBootstrap();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [menu, setMenu] = useState(false);
  const bottom = useRef<HTMLDivElement | null>(null);

  const messages = useMemo(
    () => [...(thread.data?.pages.flatMap((page) => page.messages) ?? [])].reverse(),
    [thread.data],
  );
  const { data: conversations } = useConversations();
  const unread = conversations?.find((c) => c.counterpart === counterpart)?.unread ?? 0;
  useMarkRead(`sms:${counterpart}`, unread > 0);

  const lastId = messages[messages.length - 1]?.id;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [lastId]);

  const canText = boot?.numbers.some((n) => n.sms) ?? true;

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await voiceApi.send(counterpart, body);
      setDraft('');
      void queryClient.invalidateQueries({ queryKey: voiceKeys.thread(counterpart) });
      invalidateKinds(queryClient, ['messages']);
    } catch (err) {
      snackbar(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  const groups = groupByDay(messages, (m) => m.createdAt);
  const blocked = isBlocked(counterpart);

  return (
    <div className="fixed inset-0 z-[35] flex flex-col bg-white pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] md:static md:inset-auto md:z-auto md:h-[calc(100vh-5rem)]">
      <header className="flex items-center gap-2 border-b border-gv-line px-2 py-2">
        <IconButton icon="back" label="Back" onClick={() => navigate('/voice/messages')} />
        <button
          type="button"
          onClick={() => setMenu(true)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <Avatar name={contact?.name ?? null} seed={contact?.id ?? counterpart} size="sm" />
          <span className="min-w-0">
            <span className="block truncate text-base text-gv-ink">
              {contact?.name ?? formatNumber(counterpart)}
            </span>
            {contact ? (
              <span className="block text-xs text-gv-muted">{formatNumber(counterpart)}</span>
            ) : null}
          </span>
        </button>
        <IconButton icon="phone" label="Call" onClick={() => void placeCall(counterpart)} />
        <IconButton icon="more" label="More" onClick={() => setMenu(true)} />
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {thread.hasNextPage ? (
          <div className="flex justify-center pb-2">
            <TextButton
              onClick={() => void thread.fetchNextPage()}
              disabled={thread.isFetchingNextPage}
            >
              {thread.isFetchingNextPage ? 'Loading…' : 'Load earlier messages'}
            </TextButton>
          </div>
        ) : null}
        {thread.isLoading ? <PageLoading /> : null}
        {!thread.isLoading && messages.length === 0 ? (
          <p className="py-10 text-center text-sm text-gv-muted">
            Send a message to {contact?.name ?? formatNumber(counterpart)}.
          </p>
        ) : null}
        {groups.map((group) => (
          <section key={group.day}>
            <p className="py-3 text-center text-xs text-gv-muted">{group.day}</p>
            {group.items.map((message, index) => {
              const outbound = message.direction === 'OUTBOUND';
              const status = statusText(message);
              const isLast =
                index === group.items.length - 1 ||
                group.items[index + 1]?.direction !== message.direction;
              return (
                <div
                  key={message.id}
                  className={`flex ${outbound ? 'justify-end' : 'justify-start'} mb-1`}
                >
                  <div
                    className={`max-w-[80%] ${outbound ? 'items-end' : 'items-start'} flex flex-col`}
                  >
                    <div
                      className={`whitespace-pre-wrap break-words rounded-3xl px-4 py-2 text-[15px] ${
                        outbound
                          ? 'rounded-br-md bg-gv-blue text-white'
                          : 'rounded-bl-md bg-gv-soft text-gv-ink'
                      } ${status?.error ? 'bg-[#fce8e6] text-[#a50e0e]' : ''}`}
                    >
                      {message.body || (message.numMedia > 0 ? '📷 Picture' : '')}
                      {message.mediaUrls.length > 0 && !outbound ? (
                        <span className="mt-1 block text-xs opacity-80">
                          {message.mediaUrls.length} attachment
                          {message.mediaUrls.length > 1 ? 's' : ''}
                        </span>
                      ) : null}
                    </div>
                    {isLast || status?.error ? (
                      <span
                        className={`mt-0.5 px-2 text-[11px] ${status?.error ? 'text-gv-red' : 'text-gv-muted'}`}
                      >
                        {formatClock(message.createdAt)}
                        {status ? ` · ${status.text}` : ''}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </section>
        ))}
        <div ref={bottom} />
      </div>

      {blocked ? (
        <div className="flex items-center justify-between border-t border-gv-line px-4 py-3 text-sm text-gv-muted">
          You blocked this number.
          <TextButton onClick={() => void unblock(counterpart)}>Unblock</TextButton>
        </div>
      ) : canText ? (
        <form
          onSubmit={(event) => void send(event)}
          className="flex items-end gap-2 border-t border-gv-line px-3 py-2"
        >
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                window.matchMedia('(pointer: fine)').matches
              ) {
                event.preventDefault();
                void send();
              }
            }}
            rows={1}
            maxLength={1600}
            placeholder="Type a message"
            aria-label="Message"
            className="max-h-32 min-h-[44px] flex-1 resize-none rounded-3xl border-0 bg-gv-soft px-4 py-3 text-[15px] focus:ring-2 focus:ring-gv-blue"
          />
          <button
            type="submit"
            disabled={!draft.trim() || sending}
            aria-label="Send"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-gv-blue hover:bg-gv-blue-soft disabled:text-gv-line"
          >
            <Icon name="send" />
          </button>
        </form>
      ) : (
        <p className="border-t border-gv-line px-4 py-3 text-sm text-gv-muted">
          Your number can&apos;t send texts.
        </p>
      )}

      <NumberSheet e164={counterpart} open={menu} onClose={() => setMenu(false)} />
    </div>
  );
}

export function NewMessagePage() {
  const navigate = useNavigate();
  const [to, setTo] = useState('');
  const { data: contacts } = useContacts();
  const matches = useMemo(() => searchContacts(contacts ?? [], to, 20), [contacts, to]);
  const direct = normalizeDialablePhoneNumber(to);
  const open = (e164: string) =>
    navigate(`/voice/messages/${encodeURIComponent(e164)}`, { replace: true });

  return (
    <div className="fixed inset-0 z-[35] flex flex-col bg-white pt-[env(safe-area-inset-top)] md:static md:z-auto">
      <header className="flex items-center gap-2 border-b border-gv-line px-2 py-2">
        <IconButton icon="back" label="Back" onClick={() => navigate(-1)} />
        <span className="text-base text-gv-ink">New message</span>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (direct) open(direct);
          else if (matches[0]?.phones[0]) open(matches[0].phones[0].e164);
        }}
        className="flex items-center gap-2 border-b border-gv-line px-4"
      >
        <span className="text-sm text-gv-muted">To</span>
        <input
          autoFocus
          value={to}
          onChange={(event) => setTo(event.target.value)}
          placeholder="Name or phone number"
          aria-label="To"
          className="h-12 flex-1 border-0 bg-transparent text-[15px] focus:ring-0"
        />
      </form>
      <ul className="flex-1 overflow-y-auto">
        {direct ? (
          <li>
            <button
              type="button"
              onClick={() => open(direct)}
              className="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-gv-surface"
            >
              <Avatar name={null} seed={direct} />
              <span className="text-[15px] text-gv-ink">Send to {formatNumber(direct)}</span>
            </button>
          </li>
        ) : null}
        {matches.flatMap((contact) =>
          contact.phones.map((phone) => (
            <li key={`${contact.id}-${phone.e164}`}>
              <button
                type="button"
                onClick={() => open(phone.e164)}
                className="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-gv-surface"
              >
                <Avatar name={contact.name} seed={contact.id} />
                <span className="min-w-0">
                  <span className="block truncate text-[15px] text-gv-ink">{contact.name}</span>
                  <span className="block text-sm text-gv-muted">
                    {formatNumber(phone.e164)}
                    {phone.label ? ` · ${phone.label}` : ''}
                  </span>
                </span>
              </button>
            </li>
          )),
        )}
      </ul>
    </div>
  );
}
