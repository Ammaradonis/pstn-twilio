/**
 * The Dial page's sheet dialer reads a tab's phone numbers in sheet order.
 */
import { describe, expect, it, vi } from 'vitest';

import { SheetsService } from './sheets.service';

function service(rows: unknown[][], tabs = [{ sheetId: 1, title: 'Texas', columnCount: 26 }]) {
  const svc = new SheetsService({} as never, {} as never, {} as never);
  vi.spyOn(svc, 'getAccessToken').mockResolvedValue('token');
  vi.spyOn(svc, 'fetchTabs').mockResolvedValue(tabs);
  vi.spyOn(svc, 'fetchRows').mockResolvedValue(rows as never);
  return svc;
}

describe('sheet dial list', () => {
  it('lists every row with a phone, numbered as Google Sheets shows them', async () => {
    const svc = service([
      ['title', 'address', 'phoneNumber', 'Status'],
      ['Tiger Dojo', '1 Main St, Austin, TX', '(512) 555-0101', ''],
      ['No Phone Karate', '2 Main St', '', ''],
      ['Dragon BJJ', '3 Main St', ' 512-555-0102 / 512-555-0103 ', 'Voicemail, from: 6672206726'],
      ['Short row'],
    ]);
    const list = await svc.dialList('u1', 'sheet', 'Texas');
    expect(list.phoneColumn).toBe('C');
    expect(list.rows).toEqual([
      { row: 2, name: 'Tiger Dojo', phone: '(512) 555-0101', status: '' },
      {
        row: 4,
        name: 'Dragon BJJ',
        phone: '512-555-0102 / 512-555-0103',
        status: 'Voicemail, from: 6672206726',
      },
    ]);
  });

  it('says so when row 1 has no phone column', async () => {
    const svc = service([
      ['title', 'email'],
      ['Tiger Dojo', 'a@b.co'],
    ]);
    expect(await svc.dialList('u1', 'sheet', 'Texas')).toEqual({
      sheetTitle: 'Texas',
      phoneColumn: null,
      rows: [],
    });
  });

  it('rejects a tab that no longer exists', async () => {
    const svc = service([], []);
    await expect(svc.dialList('u1', 'sheet', 'Texas')).rejects.toThrow('no longer exists');
  });
});
