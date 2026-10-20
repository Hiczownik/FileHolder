namespace FileHolder.Core.Configuration;

/// <summary>
/// Layout of an encrypted file as the browser writes it (streamCipher.ts in the UI): plaintext split into
/// fixed-size chunks, each encrypted separately and followed by its 16-byte AES-GCM tag. The server never
/// decrypts anything; it only needs the sizes, to keep multipart parts aligned with chunks and to bound uploads.
/// Keep <see cref="ChunkPlaintextBytes"/> in sync with STREAM_CHUNK_SIZE in the UI.
/// </summary>
public static class EncryptedStreamFormat
{
    public const long ChunkPlaintextBytes = 4L * 1024 * 1024;
    public const long TagBytes = 16;

    /// <summary>
    /// One encrypted chunk. Encrypted multipart parts are a whole number of these, so the browser can encrypt
    /// each part on its own, just before sending it.
    /// </summary>
    public const long EncryptedChunkBytes = ChunkPlaintextBytes + TagBytes;

    /// <summary>
    /// The ciphertext size for <paramref name="plaintextBytes"/>. Even an empty file has one (tag-only) chunk.
    /// </summary>
    public static long EncryptedSize(long plaintextBytes)
    {
        long chunks = Math.Max(1, (plaintextBytes + ChunkPlaintextBytes - 1) / ChunkPlaintextBytes);
        return plaintextBytes + chunks * TagBytes;
    }

    /// <summary>
    /// The most ciphertext <paramref name="fileCount"/> files holding at most <paramref name="maxPlaintextBytes"/>
    /// between them can encrypt to. Each file has at most its share of the full chunks plus one partial chunk,
    /// so the tags add at most one per full chunk of the total, plus one per file. The server only sees
    /// encrypted sizes, so this is how a plaintext limit is applied to an encrypted bundle.
    /// </summary>
    public static long MaxEncryptedTotal(long maxPlaintextBytes, int fileCount)
    {
        long fullChunks = (maxPlaintextBytes + ChunkPlaintextBytes - 1) / ChunkPlaintextBytes;
        return maxPlaintextBytes + (fullChunks + fileCount) * TagBytes;
    }
}
