import { normalizeDialablePhoneNumber } from '@pstn-twilio/shared';
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { useCalls } from '../components/call-manager';
import { Avatar, IconButton } from '../components/ui';
import {
  useCallLog,
  useContactLookup,
  useContacts,
  useConversations,
} from '../hooks/use-voice-data';
import { searchContacts } from '../lib/contacts';
import { formatListTime, formatNumber } from '../lib/format';

function Heading({ children }: { children: string }) {
  return (
    <h2 className="px-4 pb-1 pt-4 text-xs font-medium uppercase tracking-wide text-gv-muted">
      {children}
    </h2>
  );
}

export function SearchPage() {
  const [params] = useSearchParams();
  const query = (params.get('q') ?? '').trim();
  const lower = query.toLowerCase();
  const digits = query.replace(/\D/g, '');
  const { data: contacts } = useContacts();
  const { data: conversations } = useConversations();
  const calls = useCallLog();
  const lookup = useContactLookup();
  const { placeCall } = useCalls();
  const direct = normalizeDialablePhoneNumber(query);

  const contactHits = useMemo(() => searchContacts(contacts ?? [], query, 20), [contacts, query]);
  const messageHits = useMemo(() => {
    if (!query) return [];
    return (conversations ?? []).filter((c) => {
      const name = lookup(c.counterpart)?.name?.toLowerCase() ?? '';
      return (
        name.includes(lower) ||
        (digits.length >= 3 && c.counterpart.includes(digits)) ||
        c.last.body.toLowerCase().includes(lower)
      );
    });
  }, [conversations, query, lower, digits, lookup]);
  const callHits = useMemo(() => {
    if (!query) return [];
    const seen = new Set<string>();
    return (calls.data?.pages.flatMap((p) => p.items) ?? []).filter((item) => {
      if (seen.has(item.counterpart)) return false;
      const name = lookup(item.counterpart)?.name?.toLowerCase() ?? '';
      const hit = name.includes(lower) || (digits.length >= 3 && item.counterpart.includes(digits));
      if (hit) seen.add(item.counterpart);
      return hit;
    });
  }, [calls.data, query, lower, digits, lookup]);

  if (!query) {
    return (
      <p className="px-6 py-10 text-center text-sm text-gv-muted">
        Search your contacts, messages and calls.
      </p>
    );
  }
  const nothing = !direct && contactHits.length + messageHits.length + callHits.length === 0;

  return (
    <div>
      {direct ? (
        <div className="flex items-center gap-4 px-4 py-3">
          <Avatar name={null} seed={direct} />
          <span className="flex-1 text-[15px] text-gv-ink">{formatNumber(direct)}</span>
          <Link
            to={`/voice/messages/${encodeURIComponent(direct)}`}
            className="rounded-full p-2 text-gv-blue hover:bg-gv-blue-soft"
          >
            Text
          </Link>
          <IconButton
            icon="phone"
            label="Call"
            onClick={() => void placeCall(direct)}
            className="text-gv-green"
          />
        </div>
      ) : null}
      {contactHits.length ? (
        <>
          <Heading>Contacts</Heading>
          <ul>
            {contactHits.map((contact) => (
              <li key={contact.id}>
                <Link
                  to={`/voice/contacts/${contact.id}`}
                  className="flex items-center gap-4 px-4 py-2 hover:bg-gv-surface"
                >
                  <Avatar name={contact.name} seed={contact.id} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] text-gv-ink">{contact.name}</span>
                    <span className="block truncate text-sm text-gv-muted">
                      {contact.phones[0] ? formatNumber(contact.phones[0].e164) : contact.company}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {messageHits.length ? (
        <>
          <Heading>Messages</Heading>
          <ul>
            {messageHits.map((c) => (
              <li key={c.counterpart}>
                <Link
                  to={`/voice/messages/${encodeURIComponent(c.counterpart)}`}
                  className="flex items-center gap-4 px-4 py-2 hover:bg-gv-surface"
                >
                  <Avatar
                    name={lookup(c.counterpart)?.name ?? null}
                    seed={lookup(c.counterpart)?.id ?? c.counterpart}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] text-gv-ink">
                      {lookup(c.counterpart)?.name ?? formatNumber(c.counterpart)}
                    </span>
                    <span className="block truncate text-sm text-gv-muted">{c.last.body}</span>
                  </span>
                  <span className="text-xs text-gv-muted">{formatListTime(c.last.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {callHits.length ? (
        <>
          <Heading>Calls</Heading>
          <ul>
            {callHits.map((item) => (
              <li key={item.id} className="flex items-center gap-4 px-4 py-2">
                <Avatar
                  name={lookup(item.counterpart)?.name ?? null}
                  seed={lookup(item.counterpart)?.id ?? item.counterpart}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] text-gv-ink">
                    {lookup(item.counterpart)?.name ?? formatNumber(item.counterpart)}
                  </span>
                  <span className="block text-sm text-gv-muted">
                    {formatListTime(item.startedAt)}
                  </span>
                </span>
                <IconButton
                  icon="phone"
                  label="Call"
                  onClick={() => void placeCall(item.counterpart)}
                  className="text-gv-green"
                />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {nothing ? (
        <p className="px-6 py-10 text-center text-sm text-gv-muted">No results for “{query}”.</p>
      ) : null}
    </div>
  );
}
