-- Facts about a school, for the three personalised sentences in the Status cell.
--
-- The worker's profile pass reads the pages a visitor reads (home, classes,
-- about, contact, and the Facebook/Instagram profile when the site has none of
-- it) and stores what it found here: programmes, instructors, the timetable,
-- events, what the first class costs and how long the school has run. The push
-- that writes a row's Status cell looks the profile up by `row_index` (filled
-- when the tab was queued) and falls back to the row's phone number for rows
-- queued before this migration.
ALTER TABLE "email_finder_rows" ADD COLUMN "row_index" INTEGER;
ALTER TABLE "email_finder_rows" ADD COLUMN "profile" JSONB;

-- The sentences a push actually wrote, so the Dial page can show them and the
-- next push of the same row is recognisable.
ALTER TABLE "sheets_push_logs" ADD COLUMN "personalisation" JSONB;
