-- After scenario 5 (run.ps1 sets :run_id to the run's id). Every row printed is a failure.

-- The uploader's correct password reset each bundle's count, and the one typo after it is a free attempt:
-- one failed attempt and no lockout.
SELECT 'bundle ' || "Title" || ': FailedPasswordAttempts ' || "FailedPasswordAttempts"
       || ', PasswordLockedUntil ' || coalesce("PasswordLockedUntil"::text, 'none') || ' (expected 1, none)'
FROM "FileGroups"
WHERE "Title" LIKE 'k6 ' || :'run_id' || ' password guessing %'
  AND ("FailedPasswordAttempts" <> 1 OR "PasswordLockedUntil" IS NOT NULL);

SELECT 'no bundles of this run found'
WHERE NOT EXISTS (SELECT 1 FROM "FileGroups" WHERE "Title" LIKE 'k6 ' || :'run_id' || ' password guessing %');
