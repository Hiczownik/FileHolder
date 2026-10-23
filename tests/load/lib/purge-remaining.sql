-- How much of what the run created (since :since) the purge still has to remove: one number, 0 when it's all gone.
SELECT (SELECT count(*) FROM "FileGroups" WHERE "CreatedAt" >= :'since'::timestamptz AND "StoragePurgedAt" IS NULL)
     + (SELECT count(*) FROM "PendingUploads" WHERE "CreatedAt" >= :'since'::timestamptz)
     + (SELECT count(*) FROM "MultipartUploadSessions"
        WHERE "CreatedAt" >= :'since'::timestamptz AND NOT "IsCompleted" AND NOT "IsAborted");
