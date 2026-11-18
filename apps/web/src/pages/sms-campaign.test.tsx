import { DEFAULT_SMS_CAMPAIGN_BODY, type SmsCampaignDto } from '@pstn-twilio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../lib/api-client';

import { SmsCampaignPage } from './sms-campaign';

vi.mock('../lib/api-client', () => ({
  api: {
    smsCampaign: {
      get: vi.fn(),
      update: vi.fn(),
      test: vi.fn(),
    },
  },
}));

const CAMPAIGN: SmsCampaignDto = {
  enabled: false,
  body: DEFAULT_SMS_CAMPAIGN_BODY,
  dailyCap: 100,
  from: '+18776524532',
  sentLast24h: 0,
  waiting: 374,
  totals: { sent: 0, delivered: 0, undelivered: 0, failed: 0, optedOut: 0 },
  lastError: null,
  lastSendAt: null,
  recent: [],
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SmsCampaignPage />
    </QueryClientProvider>,
  );
}

describe('SmsCampaignPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.smsCampaign.get).mockResolvedValue(CAMPAIGN);
    vi.mocked(api.smsCampaign.update).mockImplementation(async (input) => ({
      ...CAMPAIGN,
      ...input,
    }));
    window.confirm = vi.fn(() => true);
  });

  it('starts paused and previews the text with a school name filled in', async () => {
    renderPage();
    expect(await screen.findByText('Paused. No texts go out.')).toBeInTheDocument();
    const preview = screen.getByTestId('sms-preview');
    expect(preview.textContent).toMatch(/^Hey Lone Star Karate, Ammar here\./);
    expect(preview.textContent).toContain('https://www.loom.com/share/');
    expect(screen.getByText(/3 SMS per school/)).toBeInTheDocument();
    expect(screen.getByText('374')).toBeInTheDocument();
  });

  it('asks before starting, then starts', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Start campaign' }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('374 leads waiting'));
    await waitFor(() => expect(api.smsCampaign.update).toHaveBeenCalledWith({ enabled: true }));
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(screen.getByText(/^Running\. One text every 5 minutes, 9am to 8pm/)).toBeInTheDocument();
  });

  it('does nothing when the start is cancelled', async () => {
    window.confirm = vi.fn(() => false);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Start campaign' }));
    expect(api.smsCampaign.update).not.toHaveBeenCalled();
  });

  it('pauses', async () => {
    vi.mocked(api.smsCampaign.get).mockResolvedValue({ ...CAMPAIGN, enabled: true });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(api.smsCampaign.update).toHaveBeenCalledWith({ enabled: false }));
  });

  it('saves an edited text', async () => {
    renderPage();
    const box = await screen.findByLabelText(/becomes the school's name/);
    fireEvent.change(box, { target: { value: 'Hi {{school_name}}! Reply STOP to opt out' } });
    expect(screen.getByTestId('sms-preview').textContent).toBe(
      'Hi Lone Star Karate! Reply STOP to opt out',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save text' }));
    await waitFor(() =>
      expect(api.smsCampaign.update).toHaveBeenCalledWith({
        body: 'Hi {{school_name}}! Reply STOP to opt out',
      }),
    );
  });

  it('warns when a curly quote makes the texts expensive', async () => {
    renderPage();
    const box = await screen.findByLabelText(/becomes the school's name/);
    fireEvent.change(box, { target: { value: 'It’s Ammar. Reply STOP to opt out' } });
    expect(screen.getByText(/costs? more than double/)).toBeInTheDocument();
  });

  it('shows why the campaign paused itself', async () => {
    vi.mocked(api.smsCampaign.get).mockResolvedValue({
      ...CAMPAIGN,
      lastError: 'Paused itself: carriers blocked 5 of the last 20 texts (error 30007).',
    });
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('carriers blocked 5');
  });

  it('sends a test text', async () => {
    vi.mocked(api.smsCampaign.test).mockResolvedValue({ to: '+15125550123', body: 'x' });
    renderPage();
    fireEvent.change(await screen.findByPlaceholderText('(512) 555-0123'), {
      target: { value: '512 555 0123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send test' }));
    await waitFor(() => expect(api.smsCampaign.test).toHaveBeenCalledWith('512 555 0123'));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Test text sent to +1 (512) 555-0123',
    );
  });

  it('lists results with the delivery error', async () => {
    vi.mocked(api.smsCampaign.get).mockResolvedValue({
      ...CAMPAIGN,
      enabled: true,
      sentLast24h: 100,
      recent: [
        {
          id: 's1',
          to: '+15125550101',
          schoolName: 'Kicks Karate',
          status: 'SENT',
          delivery: 'UNDELIVERED',
          error: '30006: Landline or unreachable carrier',
          sentAt: '2026-11-18T16:00:00.000Z',
        },
        {
          id: 's2',
          to: '+15125550102',
          schoolName: 'Tiger Dojo',
          status: 'SENT',
          delivery: 'DELIVERED',
          error: null,
          sentAt: '2026-11-18T16:05:00.000Z',
        },
      ],
    });
    renderPage();
    expect(await screen.findByText(/Daily cap reached/)).toBeInTheDocument();
    const table = within(screen.getByRole('table'));
    expect(table.getByText('Not delivered')).toBeInTheDocument();
    expect(table.getByText('30006: Landline or unreachable carrier')).toBeInTheDocument();
    expect(table.getByText('Delivered')).toBeInTheDocument();
  });
});
