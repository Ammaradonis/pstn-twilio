'use strict';
// Google Sheets access as the service account in gcp-creds.json, which has edit
// access to U.S. Conquest. Values are written RAW, so a business name or phone
// starting with "=" or "+" is stored as text, never run as a formula.

const { sign } = require('node:crypto');
const fs = require('node:fs');

const { a1 } = require('./lib.cjs');

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

class SheetsClient {
  constructor({ credentialsFile, spreadsheetId, fetchImpl = fetch }) {
    this.key = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
    this.spreadsheetId = spreadsheetId;
    this.fetch = fetchImpl;
    this.accessToken = null;
    this.expiresAt = 0;
  }

  async token() {
    if (this.accessToken && Date.now() < this.expiresAt - 60_000) return this.accessToken;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: this.key.client_email,
      scope: SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = sign('RSA-SHA256', Buffer.from(unsigned), this.key.private_key).toString(
      'base64url',
    );
    const res = await this.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw new Error(`Google token request failed (${res.status} ${body.error || ''})`.trim());
    }
    this.accessToken = body.access_token;
    this.expiresAt = Date.now() + Number(body.expires_in || 3600) * 1000;
    return this.accessToken;
  }

  /** One Sheets API call; rate limits and server errors are retried with backoff. */
  async call(pathAndQuery, { method = 'GET', body } = {}) {
    for (let attempt = 1; ; attempt += 1) {
      const res = await this.fetch(`${API}/${this.spreadsheetId}${pathAndQuery}`, {
        method,
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.ok) return res.json();
      const text = await res.text().catch(() => '');
      if ((res.status === 429 || res.status >= 500) && attempt < 6) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, 2000 * 2 ** attempt)));
        continue;
      }
      throw new Error(
        `Sheets ${method} ${pathAndQuery.split('?')[0]} failed (${res.status}): ${text.slice(0, 300)}`,
      );
    }
  }

  async tabTitles() {
    const meta = await this.call('?fields=sheets(properties(title))');
    return meta.sheets.map((sheet) => sheet.properties.title);
  }

  /** [{ title, sheetId, columnCount }] for every tab. */
  async tabProps() {
    const meta = await this.call(
      '?fields=sheets(properties(title,sheetId,gridProperties(columnCount)))',
    );
    return meta.sheets.map(({ properties }) => ({
      title: properties.title,
      sheetId: properties.sheetId,
      columnCount: properties.gridProperties?.columnCount ?? 26,
    }));
  }

  /** Widens a tab's grid by `count` columns at the right edge. */
  async appendColumns(sheetId, count) {
    if (count <= 0) return null;
    return this.call(':batchUpdate', {
      method: 'POST',
      body: { requests: [{ appendDimension: { sheetId, dimension: 'COLUMNS', length: count } }] },
    });
  }

  /** Whole tabs: [{ title, headers, rows }], rows without the header (rows[i] is sheet row i + 2). */
  async readTabs(titles) {
    const out = [];
    for (let i = 0; i < titles.length; i += 25) {
      const chunk = titles.slice(i, i + 25);
      const query = chunk.map((title) => `ranges=${encodeURIComponent(a1(title))}`).join('&');
      const data = await this.call(`/values:batchGet?${query}&valueRenderOption=FORMATTED_VALUE`);
      data.valueRanges.forEach((range, j) => {
        const [headers = [], ...rows] = range.values || [];
        out.push({ title: chunk[j], headers, rows });
      });
    }
    return out;
  }

  /** One column of each tab, e.g. the place URLs, to re-check rows right before writing. */
  async readColumn(titles, column) {
    const query = titles
      .map((title) => `ranges=${encodeURIComponent(a1(title, `${column}1:${column}`))}`)
      .join('&');
    const data = await this.call(`/values:batchGet?${query}`);
    const out = new Map();
    data.valueRanges.forEach((range, i) => {
      out.set(
        titles[i],
        (range.values || []).map((row) => row[0] || ''),
      );
    });
    return out;
  }

  /** Writes single cells: [{ range: "'Texas'!G12", value }]. */
  async writeCells(cells) {
    for (let i = 0; i < cells.length; i += 500) {
      await this.call('/values:batchUpdate', {
        method: 'POST',
        body: {
          valueInputOption: 'RAW',
          data: cells
            .slice(i, i + 500)
            .map((cell) => ({ range: cell.range, values: [[cell.value]] })),
        },
      });
    }
  }

  /**
   * Adds rows under a tab's last filled row. Google appends after the block of
   * data around the given row, so it is anchored at the last filled row: a blank
   * row higher up can't pull new rows into the middle. New rows are inserted, so
   * nothing below is overwritten.
   */
  async appendRows(title, rows, lastFilledRow) {
    if (rows.length === 0) return null;
    const anchor = `A${Math.max(1, lastFilledRow || 1)}`;
    return this.call(
      `/values/${encodeURIComponent(a1(title, anchor))}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: 'POST', body: { values: rows } },
    );
  }
}

module.exports = { SheetsClient };
