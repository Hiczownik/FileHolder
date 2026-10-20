#!/usr/bin/env bash
# Flips one byte of a file stored in the local MinIO, to check that a tampered encrypted file fails to download
# instead of being saved. For local testing only: it edits the docker compose stack's storage directly.
#
# Usage (Git Bash on Windows, or any bash with docker):
#   scripts/tamper-stored-file.sh <share-token> [file-number] [byte-offset]
#
#   file-number  which of the bundle's files to tamper with, from 1 (default 1)
#   byte-offset  which byte to flip (default: the middle of the file, so the download fails part way)
#
# It saves the original first and prints the command that puts it back.
set -euo pipefail

POSTGRES_CONTAINER=fileholder-postgres
MINIO_CONTAINER=fileholder-minio
BUCKET=fileholder-bucket

share_token=${1:?Usage: scripts/tamper-stored-file.sh <share-token> [file-number] [byte-offset]}
file_number=${2:-1}
byte_offset=${3:-}

# Share tokens are letters and digits only; checked so the value is safe to put into the SQL below.
if [[ ! $share_token =~ ^[A-Za-z0-9]+$ ]]; then
    echo "Not a share token: $share_token" >&2
    exit 1
fi
if [[ ! $file_number =~ ^[1-9][0-9]*$ ]]; then
    echo "The file number must be 1 or more: $file_number" >&2
    exit 1
fi

row=$(docker exec "$POSTGRES_CONTAINER" psql -U fileholder_user -d fileholder_db -At -F '|' -c "
    SELECT f.\"StorageKey\", g.\"IsEncrypted\"
    FROM \"SharedFiles\" f JOIN \"FileGroups\" g ON g.\"Id\" = f.\"FileGroupId\"
    WHERE g.\"ShareToken\" = '$share_token' AND NOT g.\"IsDeleted\"
    ORDER BY f.\"StorageKey\"
    OFFSET $((file_number - 1)) LIMIT 1")

if [[ -z $row ]]; then
    echo "No file $file_number in a live bundle with share token $share_token." >&2
    exit 1
fi
storage_key=${row%%|*}
is_encrypted=${row##*|}
if [[ $is_encrypted != t ]]; then
    echo "Warning: this bundle isn't encrypted. Plain files have no integrity check, so the download will just be corrupted." >&2
fi

# mc runs inside the MinIO container, with the credentials compose gave it.
mc_in_minio() {
    docker exec -i "$MINIO_CONTAINER" sh -c "mc alias set local http://localhost:9000 \"\$MINIO_ROOT_USER\" \"\$MINIO_ROOT_PASSWORD\" >/dev/null && $1"
}

work_dir=$(mktemp -d)
original="$work_dir/original"
tampered="$work_dir/tampered"

mc_in_minio "mc cat 'local/$BUCKET/$storage_key'" > "$original"
size=$(wc -c < "$original" | tr -d ' ')
if (( size == 0 )); then
    echo "The stored file is empty; nothing to flip." >&2
    exit 1
fi

byte_offset=${byte_offset:-$((size / 2))}
if (( byte_offset < 0 || byte_offset >= size )); then
    echo "Byte offset $byte_offset is outside the file (0 to $((size - 1)))." >&2
    exit 1
fi

cp "$original" "$tampered"
old_byte=$(od -An -tu1 -j "$byte_offset" -N1 "$original" | tr -d ' ')
new_byte=$((old_byte ^ 1))
# shellcheck disable=SC2059 # the format is the octal escape of the new byte
printf "\\$(printf '%03o' "$new_byte")" | dd of="$tampered" bs=1 seek="$byte_offset" count=1 conv=notrunc status=none

mc_in_minio "mc --quiet pipe 'local/$BUCKET/$storage_key' >/dev/null" < "$tampered"

echo "Flipped byte $byte_offset of $size in $storage_key ($old_byte -> $new_byte)."
echo "Original saved at: $original"
echo "To put it back:"
echo "  docker exec -i $MINIO_CONTAINER sh -c 'mc alias set local http://localhost:9000 \"\$MINIO_ROOT_USER\" \"\$MINIO_ROOT_PASSWORD\" >/dev/null && mc --quiet pipe \"local/$BUCKET/$storage_key\" >/dev/null' < \"$original\""
