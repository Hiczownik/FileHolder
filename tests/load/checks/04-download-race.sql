-- After scenario 4 (run.ps1 sets :run_id to the run's id). Every row printed is a failure.

-- Each raced bundle was downloaded exactly MaxDownloads times, has that many sessions, and is used up.
SELECT 'bundle ' || g."Title" || ': DownloadCount ' || g."DownloadCount" || ', ' || count(s."Id")
       || ' sessions, IsDeleted ' || g."IsDeleted" || ' (expected ' || g."MaxDownloads" || ', ' || g."MaxDownloads" || ', true)'
FROM "FileGroups" g
LEFT JOIN "DownloadSessions" s ON s."FileGroupId" = g."Id"
WHERE g."Title" LIKE 'k6 ' || :'run_id' || ' download race %'
GROUP BY g."Id"
HAVING g."DownloadCount" <> g."MaxDownloads" OR count(s."Id") <> g."MaxDownloads" OR NOT g."IsDeleted";

-- The check above passes vacuously if the run made no bundles.
SELECT 'no bundles of this run found'
WHERE NOT EXISTS (SELECT 1 FROM "FileGroups" WHERE "Title" LIKE 'k6 ' || :'run_id' || ' download race %');
