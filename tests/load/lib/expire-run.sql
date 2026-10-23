-- run.ps1 runs this after a scenario's checks (with :since, when the run started), then restarts the API, whose purge
-- worker runs once at start. It makes everything the run created due for that purge at once: its bundles and their
-- download sessions as if long expired, its pending uploads (including the originals confirm left to the purge) and
-- its unfinished multipart uploads as if abandoned. Only rows created since the run started are touched; while the
-- load configuration is applied, nothing else can upload.
UPDATE "DownloadSessions" s SET "ExpiresAt" = now() - interval '2 days'
FROM "FileGroups" g
WHERE s."FileGroupId" = g."Id" AND g."CreatedAt" >= :'since'::timestamptz;

UPDATE "FileGroups" SET "ExpiresAt" = now() - interval '2 days'
WHERE "CreatedAt" >= :'since'::timestamptz AND "StoragePurgedAt" IS NULL;

UPDATE "PendingUploads" SET "ExpiresAt" = now() - interval '2 days'
WHERE "CreatedAt" >= :'since'::timestamptz;

UPDATE "MultipartUploadSessions" SET "ExpiresAt" = now() - interval '2 days'
WHERE "CreatedAt" >= :'since'::timestamptz AND NOT "IsCompleted" AND NOT "IsAborted";
