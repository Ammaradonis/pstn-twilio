/**
 * The post-call panel shows what the push actually wrote, including the three
 * personalised sentences built from the school's own pages and the note when
 * there are fewer than three.
 */
import type { SheetsStatusDto } from '@pstn-twilio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../lib/api-client';

import { PostCallStatusPanel } from './post-call-status-panel';

vi.mock('../lib/api-client', () => ({
  api: { sheets: { push: vi.fn() } },
}));

const pushed: SheetsStatusDto = {
  spreadsheetId: 'sheet-1',
  sheetTitle: 'Texas',
  rowIndex: 42,
  duplicateRows: [],
  cellValue:
    'Voicemail, I rang on Tuesday, right around your kids karate class, from: 6672206726, time: 9:29pm on a Friday',
  personalisation: [
    'I rang on Tuesday, right around your kids karate class, so this note is shorter than the voicemail.',
    'You have taught karate since 1998; the calls that arrive mid-class are the ones that book.',
  ],
  personalisationNote: 'Only 2 of 3 sentences had facts behind them for this school.',
  timeZone: 'America/Chicago',
  timeZoneSource: 'zip',
  emailStatus: 'CANCELLED',
  emailTo: null,
  emailTemplate: null,
  emailDueAt: null,
  emailNote: 'Booked a demo — no follow-up email.',
};

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PostCallStatusPanel
        callId="call-1"
        destinationE164="+16672206726"
        callerE164="+12025550123"
        callEndedAt="2026-10-23T14:29:00.000Z"
        spreadsheetId="sheet-1"
        sheetTitle="Texas"
        onDismiss={() => undefined}
      />
    </QueryClientProvider>,
  );
}

describe('post-call status panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    vi.mocked(api.sheets.push).mockResolvedValue(pushed);
  });

  it('shows the personalised sentences and why there were not three', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Voicemail' }));
    fireEvent.click(screen.getByRole('button', { name: /^Push$/ }));
    await waitFor(() => expect(api.sheets.push).toHaveBeenCalled());
    expect(await screen.findByText('Personalised from their site:')).toBeInTheDocument();
    // Once in the cell text, once in the list of sentences.
    expect(
      screen.getAllByText(/I rang on Tuesday, right around your kids karate class/).length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Only 2 of 3 sentences/)).toBeInTheDocument();
  });

  it('says a row has no profile yet instead of leaving the cell bare', async () => {
    vi.mocked(api.sheets.push).mockResolvedValue({
      ...pushed,
      personalisation: [],
      personalisationNote:
        'No profile for this row yet. Run Personalize for this tab, then push again.',
    });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Voicemail' }));
    fireEvent.click(screen.getByRole('button', { name: /^Push$/ }));
    expect(await screen.findByText(/Run Personalize for this tab/)).toBeInTheDocument();
    expect(screen.queryByText('Personalised from their site:')).not.toBeInTheDocument();
  });
});
