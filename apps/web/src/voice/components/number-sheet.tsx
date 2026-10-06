import { useNavigate } from 'react-router-dom';

import { useBlocking } from '../hooks/use-voice-actions';
import { useContactLookup } from '../hooks/use-voice-data';
import { formatNumber } from '../lib/format';

import { useCalls } from './call-manager';
import { Avatar, Sheet, SheetAction, useSnackbar } from './ui';

/** Everything you can do with a phone number: call, text, save, block. */
export function NumberSheet({
  e164,
  open,
  onClose,
  children,
}: {
  e164: string | null;
  open: boolean;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  const navigate = useNavigate();
  const { placeCall } = useCalls();
  const lookup = useContactLookup();
  const { isBlocked, block, unblock } = useBlocking();
  const snackbar = useSnackbar();
  if (!e164) return null;
  const contact = lookup(e164);
  const blocked = isBlocked(e164);
  const dialable = /\d{4}/.test(e164);

  return (
    <Sheet open={open} onClose={onClose}>
      <div className="flex items-center gap-4 px-6 pb-3 pt-4">
        <Avatar name={contact?.name ?? null} seed={contact?.id ?? e164} size="lg" />
        <div className="min-w-0">
          <p className="truncate text-xl text-gv-ink">{contact?.name ?? formatNumber(e164)}</p>
          {contact ? <p className="text-sm text-gv-muted">{formatNumber(e164)}</p> : null}
          {blocked ? <p className="mt-1 text-xs font-medium text-gv-red">Blocked</p> : null}
        </div>
      </div>
      {dialable ? (
        <div className="border-t border-gv-line py-2">
          <SheetAction
            icon="phone"
            label="Call"
            onClick={() => {
              onClose();
              void placeCall(e164);
            }}
          />
          <SheetAction
            icon="message"
            label="Send message"
            onClick={() => {
              onClose();
              navigate(`/voice/messages/${encodeURIComponent(e164)}`);
            }}
          />
          {contact ? (
            <SheetAction
              icon="person"
              label="View contact"
              onClick={() => {
                onClose();
                navigate(`/voice/contacts/${contact.id}`);
              }}
            />
          ) : (
            <SheetAction
              icon="personAdd"
              label="Add to contacts"
              onClick={() => {
                onClose();
                navigate(`/voice/contacts/new?number=${encodeURIComponent(e164)}`);
              }}
            />
          )}
          <SheetAction
            icon="link"
            label="Copy number"
            onClick={() => {
              void navigator.clipboard?.writeText(e164).then(
                () => snackbar('Number copied'),
                () => snackbar(e164),
              );
              onClose();
            }}
          />
          <SheetAction
            icon="block"
            label={blocked ? 'Unblock number' : 'Block number'}
            danger={!blocked}
            onClick={() => {
              onClose();
              void (blocked ? unblock(e164) : block(e164));
            }}
          />
        </div>
      ) : null}
      {children ? <div className="border-t border-gv-line">{children}</div> : null}
    </Sheet>
  );
}
