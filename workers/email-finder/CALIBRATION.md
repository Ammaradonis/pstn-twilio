# Calibration completed October 2, 2026

The experiment processed 2,400 random rows: 1,200 each from
`England without London.csv` and `Texas.csv`, seed `20261001`. All rows completed
after retrying timeouts. Research used public website reads and cached DNS
validation, with six pages per site, no paid search, and no browser sessions.
It processed 5,650 pages and encountered contact forms on 340 rows. No messages
or forms were submitted by the experiment.

The CSVs contain no verified email or owner labels. This is heuristic
calibration using weak website evidence, not supervised training or an email
accuracy measurement. A mail-domain DNS check does not verify an individual
mailbox. The results do not measure the full browser/search workflow.

## Scoring results

Phone numbers, website domains, and social profiles define connected groups
that stay in one split: 1,401 training rows, 502 validation rows, and 497 final
holdout rows. Training selected among 81 combinations. The selected combination
passed the predefined checks on both holdouts; neither holdout was used to
search for an alternative combination.

| Split         |  Rows | Baseline emails | Selected emails | Baseline evidence objective | Selected evidence objective |
| ------------- | ----: | --------------: | --------------: | --------------------------: | --------------------------: |
| Training      | 1,401 |             338 |             271 |                     0.08958 |                     0.10296 |
| Validation    |   502 |             120 |              99 |                     0.10209 |                     0.11355 |
| Final holdout |   497 |             106 |              86 |                     0.08048 |                     0.08400 |
| Total         | 2,400 |             564 |             456 |                           — |                           — |

The selected threshold is more conservative: it retains 456 of the baseline's
564 findings, a reduction of 108. This trades coverage for the evidence objective;
it does **not** establish improved real-world precision. Evidence-supported
selections also declined from 344 to 332. The objective rewards explicit and
corroborated website evidence and penalizes designer-context and unlabelled
selections. Designer-context flags are weak negative signals, not proven errors.

| Parameter                                        | Baseline | Selected |
| ------------------------------------------------ | -------: | -------: |
| Decision-maker bonus                             |       25 |       20 |
| Own-domain bonus                                 |       25 |       20 |
| Free-mail bonus when own-domain candidates exist |        4 |        0 |
| Minimum accepted score                           |       50 |       60 |

England retained 237 findings versus 294 at baseline. Texas retained 219 versus 270. The selected weights are in `email_finder/scoring-parameters.json` and load
when an Engine is constructed. Ranking uses the same implementation in the
offline sweep and the worker. Concurrent requests for the same page reuse the
first completed download. Name/role matching groups by sentence; a comparison
on eight cached real pages returned identical people and roles after that change.

The detailed manifest, checkpoints, split assignments, candidate evidence,
row-level results, and all trial scores remain in the ignored local directory
`reports/training-20261001/`. Raw business contact data is not published here.

## U.S. Conquest cleanup

All 50 tabs were verified after cleanup. Alaska had 8 duplicates and Alabama
had 16; both used the legacy `number` column, which the previous script missed.
The other 48 tabs were already unique. A total of 24 rows were removed, leaving
24,264 data rows. The 1,397 rows with blank phone fields were retained. No
unrecognized nonblank phone fields remained.

Uniqueness is within each tab. Country codes and extensions remain distinct.
The first occurrence is retained. Workbook metadata, editable grid backups for
both changed tabs, and the verification report remain locally in
`reports/us-conquest-20261001T183554Z/`.
