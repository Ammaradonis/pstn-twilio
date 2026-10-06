import { normalizeDialablePhoneNumber, type ContactDto } from '@pstn-twilio/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { useCalls } from '../components/call-manager';
import { Icon } from '../components/icons';
import {
  Avatar,
  EmptyState,
  IconButton,
  PageLoading,
  PrimaryButton,
  Sheet,
  SheetAction,
  TextButton,
  errorMessage,
  useSnackbar,
} from '../components/ui';
import { useBlocking } from '../hooks/use-voice-actions';
import { invalidateKinds, useContacts } from '../hooks/use-voice-data';
import {
  contactPickerSupported,
  parseVCards,
  pickDeviceContacts,
  shareOrDownloadVCard,
} from '../lib/contacts';
import { formatNumber } from '../lib/format';
import { voiceApi, type ContactImportItem } from '../lib/voice-api';

function useImport() {
  const queryClient = useQueryClient();
  const snackbar = useSnackbar();
  return async (source: 'device' | 'vcard', items: ContactImportItem[]) => {
    if (items.length === 0) {
      snackbar('No contacts with phone numbers were found');
      return;
    }
    try {
      const result = await voiceApi.importContacts(source, items);
      invalidateKinds(queryClient, ['contacts']);
      const parts = [
        result.created ? `${result.created} added` : null,
        result.updated ? `${result.updated} updated` : null,
        result.skipped ? `${result.skipped} already saved or without a number` : null,
      ].filter(Boolean);
      snackbar(parts.length ? parts.join(', ') : 'Contacts are up to date');
    } catch (err) {
      snackbar(errorMessage(err));
    }
  };
}

export function ContactsPage() {
  const { data, isLoading, isError, refetch } = useContacts();
  const [menu, setMenu] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const importContacts = useImport();
  const snackbar = useSnackbar();
  const pickerSupported = contactPickerSupported();

  const sections = useMemo(() => {
    const contacts = data ?? [];
    const starred = contacts.filter((c) => c.starred);
    const byLetter = new Map<string, ContactDto[]>();
    for (const contact of contacts) {
      const first = contact.name.trim()[0]?.toUpperCase() ?? '#';
      const letter = /[A-Z]/.test(first) ? first : '#';
      byLetter.set(letter, [...(byLetter.get(letter) ?? []), contact]);
    }
    const letters = [...byLetter.keys()].sort((a, b) =>
      a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b),
    );
    return [
      ...(starred.length ? [{ title: 'Favorites', contacts: starred }] : []),
      ...letters.map((letter) => ({ title: letter, contacts: byLetter.get(letter)! })),
    ];
  }, [data]);

  async function fromPhone() {
    setMenu(false);
    try {
      await importContacts('device', await pickDeviceContacts());
    } catch (err) {
      if ((err as Error).name !== 'AbortError' && (err as Error).name !== 'InvalidStateError') {
        snackbar(errorMessage(err));
      }
    }
  }

  async function fromFile(file: File | undefined) {
    if (!file) return;
    try {
      await importContacts('vcard', parseVCards(await file.text()));
    } catch (err) {
      snackbar(errorMessage(err));
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function exportAll() {
    setMenu(false);
    if (!data?.length) return;
    const how = await shareOrDownloadVCard(data);
    if (how === 'downloaded')
      snackbar('Saved voice-contacts.vcf. Open it to add the contacts to your phone.');
  }

  const toolbar = (
    <div className="flex items-center justify-between px-4 pb-1 pt-2">
      <p className="text-sm text-gv-muted">{data?.length ? `${data.length} contacts` : ''}</p>
      <TextButton onClick={() => setMenu(true)}>
        <span className="flex items-center gap-1">
          <Icon name="refresh" className="h-4 w-4" />
          Sync with phone
        </span>
      </TextButton>
    </div>
  );

  const sheet = (
    <Sheet open={menu} onClose={() => setMenu(false)} title="Contacts on this device">
      <div className="pb-3">
        {pickerSupported ? (
          <SheetAction
            icon="smartphone"
            label="Import from phone contacts"
            onClick={() => void fromPhone()}
          />
        ) : null}
        <SheetAction
          icon="upload"
          label="Import a .vcf file"
          onClick={() => {
            setMenu(false);
            fileInput.current?.click();
          }}
        />
        {data?.length ? (
          <SheetAction
            icon="download"
            label="Save contacts to phone (.vcf)"
            onClick={() => void exportAll()}
          />
        ) : null}
        {!pickerSupported ? (
          <p className="px-6 pt-2 text-xs text-gv-muted">
            To bring contacts from an iPhone or computer, export them as a .vcf file (Contacts →
            Share or Export) and import it here. Contacts sync to all your signed-in devices.
          </p>
        ) : null}
      </div>
    </Sheet>
  );

  const hiddenInput = (
    <input
      ref={fileInput}
      type="file"
      accept=".vcf,text/vcard,text/x-vcard"
      className="hidden"
      onChange={(event) => void fromFile(event.target.files?.[0])}
    />
  );

  if (isLoading) return <PageLoading />;
  if (isError) {
    return (
      <EmptyState
        icon="refresh"
        title="Couldn't load your contacts"
        action={<PrimaryButton onClick={() => void refetch()}>Try again</PrimaryButton>}
      />
    );
  }
  if (!data?.length) {
    return (
      <>
        <EmptyState
          icon="person"
          title="No contacts yet"
          body="Bring in the contacts from this phone, import a .vcf file, or add someone yourself."
          action={<PrimaryButton onClick={() => setMenu(true)}>Sync contacts</PrimaryButton>}
        />
        {sheet}
        {hiddenInput}
      </>
    );
  }
  return (
    <div>
      {toolbar}
      {sections.map((section) => (
        <section key={section.title}>
          <h2 className="px-4 pb-1 pt-3 text-xs font-medium text-gv-blue">{section.title}</h2>
          <ul>
            {section.contacts.map((contact) => (
              <li key={`${section.title}-${contact.id}`}>
                <Link
                  to={`/voice/contacts/${contact.id}`}
                  className="flex items-center gap-4 px-4 py-2 hover:bg-gv-surface"
                >
                  <Avatar name={contact.name} seed={contact.id} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] text-gv-ink">{contact.name}</span>
                    {contact.company ? (
                      <span className="block truncate text-xs text-gv-muted">
                        {contact.company}
                      </span>
                    ) : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {sheet}
      {hiddenInput}
    </div>
  );
}

export function ContactDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const snackbar = useSnackbar();
  const { placeCall } = useCalls();
  const { isBlocked, block, unblock } = useBlocking();
  const { data, isLoading } = useContacts();
  const contact = data?.find((c) => c.id === id);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (isLoading) return <PageLoading />;
  if (!contact) {
    return (
      <EmptyState
        icon="person"
        title="Contact not found"
        action={
          <PrimaryButton onClick={() => navigate('/voice/contacts')}>All contacts</PrimaryButton>
        }
      />
    );
  }

  async function toggleStar() {
    if (!contact) return;
    try {
      await voiceApi.updateContact(contact.id, {
        name: contact.name,
        company: contact.company,
        email: contact.email,
        notes: contact.notes,
        starred: !contact.starred,
        phones: contact.phones.map((p) => ({ number: p.e164, label: p.label ?? undefined })),
      });
      invalidateKinds(queryClient, ['contacts']);
    } catch (err) {
      snackbar(errorMessage(err));
    }
  }

  async function remove() {
    if (!contact) return;
    try {
      await voiceApi.deleteContact(contact.id);
      invalidateKinds(queryClient, ['contacts']);
      snackbar(`${contact.name} deleted`);
      navigate('/voice/contacts', { replace: true });
    } catch (err) {
      snackbar(errorMessage(err));
    }
  }

  return (
    <div className="fixed inset-0 z-[35] overflow-y-auto bg-white pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] md:static md:z-auto">
      <header className="flex items-center gap-1 px-2 py-2">
        <IconButton icon="back" label="Back" onClick={() => navigate('/voice/contacts')} />
        <span className="flex-1" />
        <IconButton
          icon={contact.starred ? 'star' : 'starOutline'}
          label={contact.starred ? 'Unfavorite' : 'Favorite'}
          onClick={() => void toggleStar()}
          className={contact.starred ? 'text-[#f9ab00]' : ''}
        />
        <IconButton
          icon="edit"
          label="Edit"
          onClick={() => navigate(`/voice/contacts/${contact.id}/edit`)}
        />
        <IconButton icon="delete" label="Delete" onClick={() => setConfirmDelete(true)} />
      </header>
      <div className="flex flex-col items-center px-6 pb-6 pt-2 text-center">
        <Avatar name={contact.name} seed={contact.id} size="xl" />
        <h1 className="mt-4 text-3xl text-gv-ink">{contact.name}</h1>
        {contact.company ? <p className="mt-1 text-gv-muted">{contact.company}</p> : null}
        {contact.phones[0] ? (
          <div className="mt-5 flex gap-6">
            {[
              {
                icon: 'phone' as const,
                label: 'Call',
                onClick: () => void placeCall(contact.phones[0]!.e164),
              },
              {
                icon: 'message' as const,
                label: 'Text',
                onClick: () =>
                  navigate(`/voice/messages/${encodeURIComponent(contact.phones[0]!.e164)}`),
              },
            ].map((action) => (
              <button
                key={action.label}
                type="button"
                onClick={action.onClick}
                className="flex flex-col items-center gap-1 text-xs text-gv-blue"
              >
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-gv-blue-soft">
                  <Icon name={action.icon} />
                </span>
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="mx-4 rounded-2xl border border-gv-line">
        <p className="px-4 pt-3 text-sm font-medium text-gv-ink">Contact info</p>
        <ul className="py-1">
          {contact.phones.map((phone) => (
            <li key={phone.e164} className="flex items-center gap-2 px-4 py-2">
              <Icon name="phone" className="h-5 w-5 text-gv-muted" />
              <button
                type="button"
                onClick={() => void placeCall(phone.e164)}
                className="min-w-0 flex-1 text-left"
              >
                <span className="block text-[15px] text-gv-ink">{formatNumber(phone.e164)}</span>
                <span className="block text-xs capitalize text-gv-muted">
                  {phone.label ?? 'phone'}
                  {isBlocked(phone.e164) ? ' · Blocked' : ''}
                </span>
              </button>
              <IconButton
                icon="message"
                label="Text"
                onClick={() => navigate(`/voice/messages/${encodeURIComponent(phone.e164)}`)}
              />
              <IconButton
                icon="block"
                label={isBlocked(phone.e164) ? 'Unblock' : 'Block'}
                onClick={() =>
                  void (isBlocked(phone.e164) ? unblock(phone.e164) : block(phone.e164))
                }
                className={isBlocked(phone.e164) ? 'text-gv-red' : ''}
              />
            </li>
          ))}
          {contact.email ? (
            <li className="flex items-center gap-2 px-4 py-2">
              <Icon name="email" className="h-5 w-5 text-gv-muted" />
              <a href={`mailto:${contact.email}`} className="text-[15px] text-gv-blue">
                {contact.email}
              </a>
            </li>
          ) : null}
        </ul>
        {contact.notes ? (
          <p className="whitespace-pre-wrap border-t border-gv-line px-4 py-3 text-sm text-gv-muted">
            {contact.notes}
          </p>
        ) : null}
      </div>
      <div className="flex justify-center py-6">
        <TextButton onClick={() => void shareOrDownloadVCard([contact])}>Share contact</TextButton>
      </div>
      <Sheet
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${contact.name}?`}
      >
        <p className="px-6 text-sm text-gv-muted">The contact is removed from all your devices.</p>
        <div className="flex justify-end gap-2 px-4 py-4">
          <TextButton onClick={() => setConfirmDelete(false)}>Cancel</TextButton>
          <TextButton danger onClick={() => void remove()}>
            Delete
          </TextButton>
        </div>
      </Sheet>
    </div>
  );
}

const LABELS = ['mobile', 'home', 'work', 'other'];

export function ContactEditPage() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const snackbar = useSnackbar();
  const { data, isLoading } = useContacts();
  const existing = id ? data?.find((c) => c.id === id) : undefined;
  const [form, setForm] = useState(() => ({
    name: '',
    company: '',
    email: '',
    notes: '',
    phones: [{ number: search.get('number') ?? '', label: 'mobile' }],
  }));
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (existing && loadedFor !== existing.id) {
    setLoadedFor(existing.id);
    setForm({
      name: existing.name,
      company: existing.company ?? '',
      email: existing.email ?? '',
      notes: existing.notes ?? '',
      phones: existing.phones.length
        ? existing.phones.map((p) => ({ number: formatNumber(p.e164), label: p.label ?? 'mobile' }))
        : [{ number: '', label: 'mobile' }],
    });
  }
  if (id && isLoading) return <PageLoading />;

  const invalidPhone = form.phones.some(
    (p) => p.number.trim() && !normalizeDialablePhoneNumber(p.number),
  );

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form.name.trim() || invalidPhone) return;
    setSaving(true);
    const input = {
      name: form.name.trim(),
      company: form.company,
      email: form.email,
      notes: form.notes,
      starred: existing?.starred,
      phones: form.phones
        .filter((p) => p.number.trim())
        .map((p) => ({ number: p.number, label: p.label })),
    };
    try {
      const saved = existing
        ? await voiceApi.updateContact(existing.id, input)
        : await voiceApi.createContact(input);
      invalidateKinds(queryClient, ['contacts']);
      navigate(`/voice/contacts/${saved.id}`, { replace: true });
    } catch (err) {
      snackbar(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const field =
    'w-full rounded-lg border border-gv-line px-3 py-3 text-[15px] focus:border-gv-blue focus:ring-1 focus:ring-gv-blue';
  return (
    <form
      onSubmit={(event) => void save(event)}
      className="fixed inset-0 z-[35] overflow-y-auto bg-white pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] md:static md:z-auto"
    >
      <header className="flex items-center gap-2 px-2 py-2">
        <IconButton icon="close" label="Cancel" onClick={() => navigate(-1)} />
        <span className="flex-1 text-base text-gv-ink">
          {existing ? 'Edit contact' : 'Create contact'}
        </span>
        <PrimaryButton type="submit" disabled={saving || !form.name.trim() || invalidPhone}>
          {saving ? 'Saving…' : 'Save'}
        </PrimaryButton>
      </header>
      <div className="mx-auto max-w-lg space-y-4 px-4 py-4">
        <input
          className={field}
          placeholder="Name"
          aria-label="Name"
          value={form.name}
          autoFocus={!existing}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <input
          className={field}
          placeholder="Company"
          aria-label="Company"
          value={form.company}
          onChange={(e) => setForm({ ...form, company: e.target.value })}
        />
        {form.phones.map((phone, index) => {
          const bad = phone.number.trim() !== '' && !normalizeDialablePhoneNumber(phone.number);
          return (
            <div key={index} className="flex items-start gap-2">
              <div className="flex-1">
                <input
                  className={`${field} ${bad ? 'border-gv-red' : ''}`}
                  placeholder="Phone"
                  aria-label="Phone"
                  inputMode="tel"
                  value={phone.number}
                  onChange={(e) => {
                    const phones = [...form.phones];
                    phones[index] = { ...phone, number: e.target.value };
                    setForm({ ...form, phones });
                  }}
                />
                {bad ? (
                  <p className="mt-1 text-xs text-gv-red">
                    Enter a full number, e.g. (415) 555-0100 or +44 20 1234 5678
                  </p>
                ) : null}
              </div>
              <select
                aria-label="Label"
                value={phone.label}
                onChange={(e) => {
                  const phones = [...form.phones];
                  phones[index] = { ...phone, label: e.target.value };
                  setForm({ ...form, phones });
                }}
                className="rounded-lg border border-gv-line py-3 text-sm capitalize"
              >
                {LABELS.map((label) => (
                  <option key={label} value={label}>
                    {label}
                  </option>
                ))}
              </select>
              {form.phones.length > 1 ? (
                <IconButton
                  icon="close"
                  label="Remove number"
                  onClick={() =>
                    setForm({ ...form, phones: form.phones.filter((_, i) => i !== index) })
                  }
                />
              ) : null}
            </div>
          );
        })}
        {form.phones.length < 10 ? (
          <TextButton
            onClick={() =>
              setForm({ ...form, phones: [...form.phones, { number: '', label: 'mobile' }] })
            }
          >
            Add another number
          </TextButton>
        ) : null}
        <input
          className={field}
          type="email"
          placeholder="Email"
          aria-label="Email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
        <textarea
          className={field}
          rows={3}
          placeholder="Notes"
          aria-label="Notes"
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
        />
      </div>
    </form>
  );
}
