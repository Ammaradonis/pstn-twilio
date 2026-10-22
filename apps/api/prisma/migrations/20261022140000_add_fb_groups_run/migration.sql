-- Facebook groups: one rolling run per user, started from the Dial page's
-- "FB groups" button and executed by the worker on the user's PC.
--
-- The counters are the scoreboard the button shows, not a per-action ledger:
-- the worker sends deltas with each batch and this table accumulates them, so a
-- worker restart resumes at the stage it reached without recounting history.
CREATE TABLE "fb_groups_runs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "stage" TEXT NOT NULL DEFAULT 'SEARCH',
    "searches" INTEGER NOT NULL DEFAULT 0,
    "groups_found" INTEGER NOT NULL DEFAULT 0,
    "joined" INTEGER NOT NULL DEFAULT 0,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "replies" INTEGER NOT NULL DEFAULT 0,
    "follows" INTEGER NOT NULL DEFAULT 0,
    "dms" INTEGER NOT NULL DEFAULT 0,
    "review_queued" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "plan" JSONB,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "fb_groups_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "fb_groups_runs_user_id_status_idx" ON "fb_groups_runs"("user_id", "status");
CREATE INDEX "fb_groups_runs_status_updated_at_idx" ON "fb_groups_runs"("status", "updated_at");

ALTER TABLE "fb_groups_runs" ADD CONSTRAINT "fb_groups_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
