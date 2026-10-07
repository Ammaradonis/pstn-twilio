/**
 * SpreadsheetPicker
 *
 * Two-level dropdown:
 *  1. Spreadsheet selector — lists all Google Sheets the account can access,
 *     sorted by most-recently-modified (API default). Loads on mount.
 *  2. Sheet tab selector — lists all tabs in the chosen spreadsheet.
 *     Appears (and re-fetches) whenever the spreadsheet changes.
 *
 * Persists the last selection to localStorage so it survives page refreshes.
 */

import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../lib/api-client';

const LS_SPREADSHEET_KEY = 'pstn-twilio.sheets.spreadsheetId';
const LS_SPREADSHEET_NAME_KEY = 'pstn-twilio.sheets.spreadsheetName';
const LS_SHEET_TITLE_KEY = 'pstn-twilio.sheets.sheetTitle';

interface SpreadsheetPickerProps {
  spreadsheetId: string | null;
  sheetTitle: string | null;
  onSpreadsheetChange: (id: string, name: string) => void;
  onSheetTitleChange: (title: string) => void;
}

export function SpreadsheetPicker({
  spreadsheetId,
  sheetTitle,
  onSpreadsheetChange,
  onSheetTitleChange,
}: SpreadsheetPickerProps) {
  // Whether Google Sheets is connected — skip fetches if not.
  const statusQuery = useQuery({
    queryKey: ['sheets', 'status'],
    queryFn: () => api.sheets.status(),
    staleTime: 60_000,
  });

  const connected = statusQuery.data?.connected ?? false;

  const spreadsheetsQuery = useQuery({
    queryKey: ['sheets', 'spreadsheets'],
    queryFn: () => api.sheets.listSpreadsheets(),
    enabled: connected,
    staleTime: 5 * 60_000,
  });

  const tabsQuery = useQuery({
    queryKey: ['sheets', 'tabs', spreadsheetId],
    queryFn: () => api.sheets.listTabs(spreadsheetId!),
    enabled: connected && spreadsheetId != null,
    staleTime: 5 * 60_000,
  });

  // Auto-select first sheet tab when tabs load for a new spreadsheet.
  useEffect(() => {
    if (!tabsQuery.data || tabsQuery.data.length === 0) return;
    // Only auto-select if no tab is currently selected or the tab doesn't
    // belong to the current spreadsheet's tabs.
    const titles = tabsQuery.data.map((t) => t.title);
    if (!sheetTitle || !titles.includes(sheetTitle)) {
      const firstTitle = tabsQuery.data[0]!.title;
      onSheetTitleChange(firstTitle);
      try {
        localStorage.setItem(LS_SHEET_TITLE_KEY, firstTitle);
      } catch {
        /* ignore */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabsQuery.data]);

  if (!connected) {
    if (statusQuery.isLoading) {
      return <p className="text-xs text-slate-400">Checking Sheets connection…</p>;
    }
    return (
      <p className="text-xs text-amber-700">
        Google Sheets is not connected.{' '}
        <Link to="/settings/sheets" className="underline hover:text-amber-900">
          Connect in Settings
        </Link>
        .
      </p>
    );
  }

  return (
    <div className="flex flex-wrap gap-2 items-end">
      {statusQuery.data?.needsReconnect && (
        <p className="w-full text-xs text-amber-700">
          Google no longer accepts the saved access, so pushes and follow-up emails are on hold.{' '}
          <Link to="/settings/sheets" className="underline hover:text-amber-900">
            Reconnect in Settings
          </Link>
          .
        </p>
      )}
      {/* Spreadsheet selector */}
      <div className="flex flex-col gap-1 min-w-0 flex-1">
        <label htmlFor="spreadsheet-picker" className="text-xs font-medium text-slate-600">
          Spreadsheet
        </label>
        <select
          id="spreadsheet-picker"
          value={spreadsheetId ?? ''}
          onChange={(e) => {
            const id = e.target.value;
            const name = spreadsheetsQuery.data?.find((s) => s.spreadsheetId === id)?.name ?? '';
            onSpreadsheetChange(id, name);
            try {
              localStorage.setItem(LS_SPREADSHEET_KEY, id);
              localStorage.setItem(LS_SPREADSHEET_NAME_KEY, name);
              localStorage.removeItem(LS_SHEET_TITLE_KEY);
            } catch {
              /* ignore */
            }
          }}
          disabled={spreadsheetsQuery.isLoading}
          className="rounded border border-slate-300 px-2 py-1 text-xs focus:border-slate-500 focus:outline-none disabled:opacity-60 max-w-xs"
        >
          <option value="" disabled>
            {spreadsheetsQuery.isLoading ? 'Loading…' : '— select spreadsheet —'}
          </option>
          {spreadsheetsQuery.data?.map((s) => (
            <option key={s.spreadsheetId} value={s.spreadsheetId}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      {/* Sheet tab selector */}
      {spreadsheetId && (
        <div className="flex flex-col gap-1 min-w-0 flex-1">
          <label htmlFor="sheet-tab-picker" className="text-xs font-medium text-slate-600">
            Sheet tab
          </label>
          <select
            id="sheet-tab-picker"
            value={sheetTitle ?? ''}
            onChange={(e) => {
              const title = e.target.value;
              onSheetTitleChange(title);
              try {
                localStorage.setItem(LS_SHEET_TITLE_KEY, title);
              } catch {
                /* ignore */
              }
            }}
            disabled={tabsQuery.isLoading}
            className="rounded border border-slate-300 px-2 py-1 text-xs focus:border-slate-500 focus:outline-none disabled:opacity-60 max-w-xs"
          >
            <option value="" disabled>
              {tabsQuery.isLoading ? 'Loading…' : '— select tab —'}
            </option>
            {tabsQuery.data?.map((t) => (
              <option key={t.sheetId} value={t.title}>
                {t.title}
              </option>
            ))}
          </select>
        </div>
      )}

      <button
        type="button"
        onClick={() => {
          void spreadsheetsQuery.refetch();
          if (spreadsheetId) void tabsQuery.refetch();
        }}
        disabled={spreadsheetsQuery.isFetching}
        className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-60"
        title="Reload the spreadsheet list"
      >
        {spreadsheetsQuery.isFetching ? 'Loading…' : 'Refresh'}
      </button>

      {/* Inline error */}
      {(spreadsheetsQuery.isError || tabsQuery.isError) && (
        <p className="text-xs text-rose-600 w-full">
          {(spreadsheetsQuery.error ?? tabsQuery.error)?.message ?? 'Could not load spreadsheets.'}
        </p>
      )}
    </div>
  );
}

// ── Persistence helpers ───────────────────────────────────────────────────────

/** Read the persisted spreadsheet selection from localStorage. */
export function readPersistedSpreadsheet(): {
  spreadsheetId: string | null;
  spreadsheetName: string | null;
  sheetTitle: string | null;
} {
  try {
    return {
      spreadsheetId: localStorage.getItem(LS_SPREADSHEET_KEY),
      spreadsheetName: localStorage.getItem(LS_SPREADSHEET_NAME_KEY),
      sheetTitle: localStorage.getItem(LS_SHEET_TITLE_KEY),
    };
  } catch {
    return { spreadsheetId: null, spreadsheetName: null, sheetTitle: null };
  }
}
