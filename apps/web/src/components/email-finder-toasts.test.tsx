import type { EmailFinderFindDto } from '@pstn-twilio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EmailFinderToasts } from './email-finder-toasts';

const socketHandlers = vi.hoisted(() => new Map<string, (payload: unknown) => void>());
vi.mock('../lib/realtime', () => ({
  getSocket: () => ({
    on: (event: string, handler: (payload: unknown) => void) => socketHandlers.set(event, handler),
    off: vi.fn(),
  }),
}));

function find(over: Partial<EmailFinderFindDto>): EmailFinderFindDto {
  return {
    rowId: 'r1',
    jobId: 'job1',
    spreadsheetId: 'ss1',
    sheetTitle: 'Texas',
    school: 'Tiger Dojo',
    email: 'info@tigerdojo.com',
    emailType: 'business',
    confidence: 72,
    method: "Mailto link in the footer of the school's homepage",
    sourceUrl: 'https://tigerdojo.com/',
    foundAt: new Date().toISOString(),
    ...over,
  };
}

function renderToasts(recent?: EmailFinderFindDto[]) {
  const client = new QueryClient();
  const ui = (r?: EmailFinderFindDto[]) => (
    <QueryClientProvider client={client}>
      <EmailFinderToasts spreadsheetId="ss1" sheetTitle="Texas" recent={r} />
    </QueryClientProvider>
  );
  const view = render(ui(recent));
  return { rerender: (r?: EmailFinderFindDto[]) => view.rerender(ui(r)) };
}

describe('EmailFinderToasts', () => {
  beforeEach(() => {
    socketHandlers.clear();
    window.localStorage.clear();
  });

  it('shows only the latest find on load, with the exact address and the method', () => {
    renderToasts([find({ rowId: 'new' }), find({ rowId: 'old', email: 'old@dojo.com' })]);
    const region = screen.getByLabelText('Email finder notifications');
    expect(within(region).getAllByRole('status')).toHaveLength(1);
    expect(region).toHaveTextContent('info@tigerdojo.com');
    expect(region).toHaveTextContent("Method: Mailto link in the footer of the school's homepage");
    expect(region).not.toHaveTextContent('old@dojo.com');
  });

  it('adds each find pushed over the socket the moment it arrives', () => {
    renderToasts([]);
    expect(screen.queryByLabelText('Email finder notifications')).not.toBeInTheDocument();
    act(() => {
      socketHandlers.get('email-finder.found')?.({
        find: find({
          rowId: 'fb',
          email: 'sensei.mike@gmail.com',
          emailType: 'decision-maker',
          sheetTitle: 'Florida',
          method: 'Facebook contact info via iPhone emulation (found via free Google search)',
        }),
      });
    });
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('sensei.mike@gmail.com');
    expect(notice).toHaveTextContent(
      'Method: Facebook contact info via iPhone emulation (found via free Google search)',
    );
    expect(notice).toHaveTextContent('decision-maker');
    expect(notice).toHaveTextContent('tab "Florida"');
  });

  it('replaces the card with each newer find instead of stacking them', () => {
    renderToasts([find({ rowId: 'a', email: 'a@dojo.com', foundAt: '2026-10-04T10:00:00Z' })]);
    act(() => {
      socketHandlers.get('email-finder.found')?.({
        find: find({ rowId: 'b', email: 'b@dojo.com', foundAt: '2026-10-04T10:01:00Z' }),
      });
    });
    const notices = screen.getAllByRole('status');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toHaveTextContent('b@dojo.com');
    expect(notices[0]).not.toHaveTextContent('a@dojo.com');
  });

  it('takes a find missed by the socket from the status poll, but never an older one', () => {
    const view = renderToasts([
      find({ rowId: 'a', email: 'a@dojo.com', foundAt: '2026-10-04T10:00:00Z' }),
    ]);
    view.rerender([
      find({ rowId: 'b', email: 'b@dojo.com', foundAt: '2026-10-04T10:02:00Z' }),
      find({ rowId: 'a', email: 'a@dojo.com', foundAt: '2026-10-04T10:00:00Z' }),
    ]);
    expect(screen.getByRole('status')).toHaveTextContent('b@dojo.com');
    view.rerender([
      find({ rowId: 'late', email: 'late@dojo.com', foundAt: '2026-10-04T10:01:00Z' }),
    ]);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('b@dojo.com');
  });

  it('says when the Galaxy A20e found the address', () => {
    renderToasts([
      find({
        rowId: 'g',
        email: 'info@calsma.com',
        method: 'Instagram Contact button in the app on the Galaxy A20e',
      }),
    ]);
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('via Galaxy A20e');
    expect(notice).toHaveTextContent(
      'Method: Instagram Contact button in the app on the Galaxy A20e',
    );
  });

  it('does not tag finds made in the browser', () => {
    renderToasts([find({ rowId: 'b' })]);
    expect(screen.getByRole('status')).not.toHaveTextContent('via Galaxy A20e');
  });

  it('stays dismissed after a reload', () => {
    const first = renderToasts([find({ rowId: 'x' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    first.rerender(undefined);
    renderToasts([find({ rowId: 'x' })]);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
