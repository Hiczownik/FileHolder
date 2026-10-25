import { execFileSync } from 'node:child_process';

/**
 * Checks of what a fault left behind, made after each scenario: rows in Postgres, unfinished multipart uploads in
 * storage, and errors in the API's log. They run against the compose stack's containers (fixed names in
 * docker-compose.yml) through `docker exec`, so the API needs no test-only endpoints.
 */

const POSTGRES_CONTAINER = 'fileholder-postgres';
const STORAGE_CONTAINER = 'fileholder-minio';
const API_CONTAINER = 'fileholder-api';
const BUCKET = 'fileholder-bucket';
// The storage container's own `mc` reaches it on localhost, signed in as the storage admin, whose credentials are in
// that container's environment (from .env), so this file needs none of its own.
const MC_HOST = 'http://$MINIO_ROOT_USER:$MINIO_ROOT_PASSWORD@localhost:9000';

const docker = (args: readonly string[], input?: string): string =>
  execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

/**
 * Runs a query with psql and returns its rows, each a list of column values. Values are passed as psql variables
 * (`:'name'` in the query), so they are quoted by psql and never pasted into the SQL.
 */
export function query(sql: string, variables: Readonly<Record<string, string>> = {}): string[][] {
  const variableArgs = Object.entries(variables).flatMap(([name, value]) => ['-v', `${name}=${value}`]);
  const output = docker(
    ['exec', '-i', POSTGRES_CONTAINER, 'psql', '-U', 'fileholder_user', '-d', 'fileholder_db', '-qtAX', '-F', '\t', '-v', 'ON_ERROR_STOP=1', ...variableArgs],
    sql
  );
  return output.split('\n').filter((line) => line !== '').map((line) => line.split('\t'));
}

export interface MultipartSessionRow {
  readonly storageKey: string;
  readonly uploadId: string;
  readonly isCompleted: boolean;
  readonly isAborted: boolean;
}

/** The multipart uploads presign started for one upload token. */
export function multipartSessions(uploadToken: string): MultipartSessionRow[] {
  return query(
    `SELECT "StorageKey", "UploadId", "IsCompleted", "IsAborted" FROM "MultipartUploadSessions" WHERE "UploadToken" = :'token' ORDER BY "StorageKey";`,
    { token: uploadToken }
  ).map(([storageKey, uploadId, isCompleted, isAborted]) => ({
    storageKey,
    uploadId,
    isCompleted: isCompleted === 't',
    isAborted: isAborted === 't',
  }));
}

export interface BundleCounts {
  readonly downloadCount: number;
  readonly downloadSessions: number;
}

/** How many downloads a bundle has counted, and how many download sessions were opened for it. */
export function bundleCounts(shareToken: string): BundleCounts {
  const [[downloadCount, downloadSessions]] = query(
    `SELECT g."DownloadCount", (SELECT count(*) FROM "DownloadSessions" s WHERE s."FileGroupId" = g."Id")
     FROM "FileGroups" g WHERE g."ShareToken" = :'token';`,
    { token: shareToken }
  );
  return { downloadCount: Number(downloadCount), downloadSessions: Number(downloadSessions) };
}

/** Multipart uploads storage still holds open for this object key, i.e. parts nobody completed or aborted. */
export function incompleteUploads(storageKey: string): string[] {
  // The container's shell expands the credentials; the key is passed as an argument ("$1"), never pasted into the script.
  const output = docker(['exec', STORAGE_CONTAINER, 'sh', '-c', `MC_HOST_local="${MC_HOST}" exec mc ls --incomplete --json "local/${BUCKET}/$1"`, 'sh', storageKey]);
  return output.split('\n').filter((line) => line.trim() !== '');
}

// Matches the level of an error-or-worse line in the API's Serilog console output: "[14:11:47 ERR] An unhandled
// exception has occurred" and "[14:11:47 FTL] Host terminated" match, "[14:11:47 INF] Executed DbCommand" doesn't.
// https://regex101.com/?regex=%5E%5C%5B%5Cd%7B2%7D%3A%5Cd%7B2%7D%3A%5Cd%7B2%7D%20(ERR%7CFTL)%5C%5D&flags=gm&testString=%5B14%3A11%3A47%20ERR%5D%20An%20unhandled%20exception%0A%5B14%3A11%3A47%20FTL%5D%20Host%20terminated%0A%5B14%3A11%3A47%20INF%5D%20Executed%20DbCommand
const ERROR_LINE = /^\[\d{2}:\d{2}:\d{2} (ERR|FTL)\]/;

/** Error lines the API has logged since `since`; faults on the browser's side should never cause any. */
export function apiErrorsSince(since: Date): string[] {
  // Serilog's console sink writes every level to stdout.
  const output = execFileSync('docker', ['logs', '--since', since.toISOString(), API_CONTAINER], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return output.split('\n').filter((line) => ERROR_LINE.test(line));
}
