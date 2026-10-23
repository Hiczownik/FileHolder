-- After scenario 8 (run.ps1 sets :run_id and :since, when the run started). Every row printed is a failure.
-- Runs before run.ps1's own purge of the run, so it sees what the purge worker managed during the soak.

-- Every bundle of the run that became due for purging was purged in time. Due means expired, past the 10-minute
-- grace (DownloadTimings.StorageDeletionGracePeriod), with no session still open; the worker runs every 30 minutes
-- (PurgeTimings.CheckInterval), so 45 minutes past expiry it must have run since. Titles are cleared by the purge,
-- so the run's bundles are found by when they were made.
SELECT count(*) || ' bundle(s) were due for purging but kept their files, the oldest expired at ' || min(g."ExpiresAt")
FROM "FileGroups" g
WHERE g."CreatedAt" >= :'since'::timestamptz
  AND g."StoragePurgedAt" IS NULL
  AND g."ExpiresAt" < now() - interval '45 minutes'
  AND NOT EXISTS (SELECT 1 FROM "DownloadSessions" s WHERE s."FileGroupId" = g."Id" AND s."ExpiresAt" > now() - interval '45 minutes')
HAVING count(*) > 0;
