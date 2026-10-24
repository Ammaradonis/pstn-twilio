/**
 * Meta Ads Library prospecting (workers/meta-ads + the Dial page's
 * "Meta ad filter" button).
 *
 * The worker on the user's PC reads facebook.com/ads/library, matches the
 * advertisers it finds to a tab's `title` and `facebookUrl` cells, and uploads
 * every verified school↔ad pair here. The button then copies the matching rows
 * of the selected tab into a new tab of the same spreadsheet.
 */

/**
 * Which schools the new tab keeps:
 *  - `ACTIVE` (the default): the school has an ad Meta reports as running,
 *    seen in the last `freshDays`.
 *  - `PAST`: the school has an ad that has ended, whether or not it is also
 *    advertising now.
 */
export type MetaAdFilterMode = 'ACTIVE' | 'PAST';

export type MetaAdEvidenceStatus = 'ACTIVE' | 'INACTIVE';

/**
 * How the worker tied the tab's row to the advertiser:
 *  - `page`: the tab's own `facebookUrl` cell is the ad's page (blue backgrounds
 *    in the sheet require this).
 *  - `name`: the tab has no page URL, so an exact normalized school name is
 *    what matched. The filter tab shows the advertiser's page next to it.
 */
export type MetaAdMatchKind = 'page' | 'name';

/** One verified school↔ad pair the worker observed in the Ads Library. */
export interface MetaAdEvidenceDto {
  spreadsheetId: string;
  sheetId: number;
  sheetTitle: string;
  /** Row in the tab, 1-based; the header is row 1. */
  rowIndex: number;
  /** The tab's `title` cell at the time of the match. */
  schoolTitle: string;
  /**
   * The tab's `facebookUrl` cell. Empty when the match was by name and the cell
   * was empty. A worker older than the API may have sent the advertiser's page
   * here instead — an earlier API rejected an empty string — which is why
   * `matchKind` is the authority on how the row was matched.
   */
  facebookUrl: string;
  /** The advertiser name Meta printed on the ad card. */
  advertiserName: string;
  /** The advertiser's Facebook page as linked from the ad card. */
  advertiserUrl: string;
  /** Meta's Ads Library ID. */
  adId: string;
  status: MetaAdEvidenceStatus;
  /** First day Meta printed for the ad (yyyy-mm-dd), when it printed one. */
  startedAt: string | null;
  /** Last day for an ad that has stopped; null while it is running. */
  endedAt: string | null;
  /** When the worker read the Ads Library. */
  observedAt: string;
  /** Which identity matched; older uploads are treated as `page`. */
  matchKind?: MetaAdMatchKind;
}

/** The worker's upload: a batch of verified observations. */
export interface MetaAdsEvidenceUploadDto {
  observations: MetaAdEvidenceDto[];
}

/** What the API stored after an upload. */
export interface MetaAdsEvidenceSavedDto {
  saved: number;
  /** Distinct tabs the batch touched. */
  tabs: number;
}

/** How much evidence the API holds for one tab, for the button's label. */
export interface MetaAdsStatusDto {
  spreadsheetId: string;
  sheetTitle: string;
  /** Rows with an ad Meta reports as running now (observed within `freshDays`). */
  active: number;
  /** Rows with an ad that has ended. */
  past: number;
  /** Rows in both lists: ended ads and a running one. */
  both: number;
  /** Rows with any evidence at all. */
  matched: number;
  /** Stored school↔ad pairs for this tab. */
  evidence: number;
  lastObservedAt: string | null;
  /** Observations older than this no longer count as "running now". */
  freshDays: number;
}

/** The new tab the button created, in the same spreadsheet as the source tab. */
export interface MetaAdFilterResultDto {
  spreadsheetId: string;
  sourceSheetTitle: string;
  /** Title of the tab that holds the result. */
  tabTitle: string;
  /** True when the tab already existed and was rewritten instead of created. */
  reused: boolean;
  mode: MetaAdFilterMode;
  /** Rows copied into the new tab (the header row is not counted). */
  rows: number;
  /** Rows in the source tab (header excluded). */
  sourceRows: number;
  /** Matches that only an observation older than `freshDays` supports (ACTIVE mode). */
  staleRows: number;
  /** Stored evidence whose school is no longer in the tab (renamed, sorted out or deleted). */
  orphaned: number;
  createdAt: string;
}
