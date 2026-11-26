import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../lib/api-client';

import { dialableFromCell, SheetDialer } from './sheet-dialer';

vi.mock('../lib/api-client', () => ({
  api: { sheets: { dialList: vi.fn() } },
}));

const LIST = {
  sheetTitle: 'Texas',
  phoneColumn: 'G',
  rows: [
    { row: 2, name: 'Tiger Dojo', phone: '(512) 555-0101', status: '' },
    { row: 3, name: 'Broken Number', phone: 'call us', status: '' },
    {
      row: 5,
      name: 'Dragon BJJ',
      phone: '512-555-0102 / 512-555-0103',
      status: 'Voicemail, from: 6672206726, time: 9:45am on a Friday',
    },
    { row: 9, name: 'Eagle Karate', phone: '+1 512 555 0104', status: '' },
  ],
};

function setup(props: Partial<ComponentProps<typeof SheetDialer>> = {}) {
  const onDial = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (extra: Partial<ComponentProps<typeof SheetDialer>> = {}) => (
    <QueryClientProvider client={client}>
      <SheetDialer
        spreadsheetId="ss1"
        sheetTitle="Texas"
        dialingCountry="US"
        canDial
        inCall={false}
        onDial={onDial}
        {...props}
        {...extra}
      />
    </QueryClientProvider>
  );
  const view = render(ui());
  return {
    onDial,
    view,
    rerender: (extra: Partial<ComponentProps<typeof SheetDialer>>) => view.rerender(ui(extra)),
  };
}

const next = () => screen.getByRole('button', { name: /^(Next|Hang up and call next)/ });

describe('SheetDialer', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(api.sheets.dialList).mockReset();
    vi.mocked(api.sheets.dialList).mockResolvedValue(LIST);
  });

  it('lists every phone number of the tab before the first call', async () => {
    setup();
    const list = await screen.findByRole('list', { name: 'Phone numbers in Texas' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent('Tiger Dojo');
    expect(items[0]).toHaveTextContent('+1 (512) 555-0101');
    expect(items[1]).toHaveTextContent('call us (not dialable)');
    expect(items[2]).toHaveTextContent('Voicemail');
    expect(screen.getByText(/3 numbers \(column G\) · 1 with a status/)).toBeInTheDocument();
    expect(api.sheets.dialList).toHaveBeenCalledWith('ss1', 'Texas');
  });

  it('Start calls the first row, and Next walks down the tab skipping rows it cannot dial', async () => {
    const { onDial } = setup();
    await screen.findByRole('list');
    expect(next()).toHaveAccessibleName('Next: Row 2 · Tiger Dojo · +1 (512) 555-0101');

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(onDial).toHaveBeenLastCalledWith('+15125550101', expect.objectContaining({ row: 2 }));

    fireEvent.click(next());
    // Row 3 has no dialable number; row 5's cell lists two, the first is used.
    expect(onDial).toHaveBeenLastCalledWith('+15125550102', expect.objectContaining({ row: 5 }));
    fireEvent.click(next());
    expect(onDial).toHaveBeenLastCalledWith('+15125550104', expect.objectContaining({ row: 9 }));

    expect(next()).toBeDisabled();
    expect(screen.getByText('No more numbers in this tab')).toBeInTheDocument();
  });

  it('remembers the last row called, so Next carries on after a reload', async () => {
    const first = setup();
    await screen.findByRole('list');
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    first.view.unmount();

    const { onDial } = setup();
    await screen.findByRole('list');
    expect(screen.getByText(/Last called:/)).toHaveTextContent('Row 2 · Tiger Dojo');
    fireEvent.click(next());
    expect(onDial).toHaveBeenLastCalledWith('+15125550102', expect.objectContaining({ row: 5 }));
  });

  it('Start from row takes the row on a keypad and calls it', async () => {
    const { onDial } = setup();
    await screen.findByRole('list');
    fireEvent.click(screen.getByRole('button', { name: 'Start from row…' }));
    const keypad = screen.getByRole('dialog', { name: 'Start from row' });
    fireEvent.click(within(keypad).getByRole('button', { name: '9' }));
    expect(within(keypad).getByLabelText('Row number')).toHaveTextContent('9');
    fireEvent.click(within(keypad).getByRole('button', { name: 'Call row 9' }));

    expect(onDial).toHaveBeenLastCalledWith('+15125550104', expect.objectContaining({ row: 9 }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('moves on to the next row with a number when the typed row has none', async () => {
    const { onDial } = setup();
    await screen.findByRole('list');
    fireEvent.click(screen.getByRole('button', { name: 'Start from row…' }));
    // The physical keyboard types into the keypad too.
    fireEvent.keyDown(window, { key: '3' });
    fireEvent.keyDown(window, { key: 'Enter' });

    expect(onDial).toHaveBeenLastCalledWith('+15125550102', expect.objectContaining({ row: 5 }));
    expect(screen.getByRole('status')).toHaveTextContent(
      'Row 3 has no number to dial, so row 5 is next.',
    );
  });

  it('says so when no row at or after the typed one has a number', async () => {
    const { onDial } = setup();
    await screen.findByRole('list');
    fireEvent.click(screen.getByRole('button', { name: 'Start from row…' }));
    const keypad = screen.getByRole('dialog');
    fireEvent.click(within(keypad).getByRole('button', { name: '4' }));
    fireEvent.click(within(keypad).getByRole('button', { name: '0' }));
    fireEvent.click(within(keypad).getByRole('button', { name: 'Call row 40' }));
    expect(onDial).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('No phone number at or after row 40');
  });

  it('during a call, Next hangs up and calls the next row; Start and Start from row wait', async () => {
    const { onDial, rerender } = setup();
    await screen.findByRole('list');
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    rerender({ inCall: true });

    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Start from row…' })).toBeDisabled();
    expect(next()).toHaveTextContent('Hang up & next');
    fireEvent.click(next());
    expect(onDial).toHaveBeenLastCalledWith('+15125550102', expect.objectContaining({ row: 5 }));
  });

  it('keeps every button off while a call cannot be placed', async () => {
    setup({ canDial: false });
    await screen.findByRole('list');
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(next()).toBeDisabled();
  });

  it('asks for a tab when none is picked', () => {
    setup({ spreadsheetId: null, sheetTitle: null });
    expect(screen.getByText(/Pick a spreadsheet and tab/)).toBeInTheDocument();
    expect(api.sheets.dialList).not.toHaveBeenCalled();
  });
});

describe('dialableFromCell', () => {
  it('takes the first dialable number in a cell', () => {
    expect(dialableFromCell('(512) 555-0101', 'US')).toBe('+15125550101');
    expect(dialableFromCell('main: 512-555-0102 / cell 512-555-0103', 'US')).toBe('+15125550102');
    expect(dialableFromCell('n/a', 'US')).toBeNull();
    expect(dialableFromCell('020 7946 0018 / 0161 496 0123', 'GB')).toBe('+442079460018');
  });
});
