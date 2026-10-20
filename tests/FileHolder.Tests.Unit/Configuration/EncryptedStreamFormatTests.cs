using FileHolder.Core.Configuration;
using FluentAssertions;

namespace FileHolder.Tests.Unit.Configuration;

public class EncryptedStreamFormatTests
{
    private const long Chunk = 4L * 1024 * 1024;

    // Same cases as encryptedSize in the UI's streamCipher tests: the two must agree byte for byte,
    // or the server would reject (or mis-size the parts of) every encrypted upload.
    [Theory]
    [InlineData(0, 16)]
    [InlineData(1, 17)]
    [InlineData(Chunk, Chunk + 16)]
    [InlineData(Chunk + 1, Chunk + 1 + 32)]
    [InlineData(1024L * 1024 * 1024, 1024L * 1024 * 1024 + 256 * 16)]
    public void EncryptedSize_AddsOneTagPerChunk(long plaintextBytes, long expected)
    {
        EncryptedStreamFormat.EncryptedSize(plaintextBytes).Should().Be(expected);
    }

    [Fact]
    public void EncryptedChunkBytes_IsAChunkPlusItsTag()
    {
        EncryptedStreamFormat.EncryptedChunkBytes.Should().Be(Chunk + 16);
    }

    // However the plaintext is split between files, the encrypted total never exceeds MaxEncryptedTotal: otherwise
    // the server would refuse an encrypted bundle that is within the limit before encryption.
    [Theory]
    [InlineData(new long[] { 5 * Chunk })]
    [InlineData(new long[] { 1, 5 * Chunk - 1 })]
    [InlineData(new long[] { Chunk + 1, Chunk + 1, Chunk + 1 })]
    [InlineData(new long[] { 1, 1, 1, 1, 1 })]
    [InlineData(new long[] { 2 * Chunk, 2 * Chunk, Chunk })]
    public void MaxEncryptedTotal_IsNeverExceededByFilesWithinThePlaintextLimit(long[] plaintextSizes)
    {
        long plaintextTotal = plaintextSizes.Sum();
        long encryptedTotal = plaintextSizes.Sum(EncryptedStreamFormat.EncryptedSize);

        encryptedTotal.Should().BeLessThanOrEqualTo(EncryptedStreamFormat.MaxEncryptedTotal(plaintextTotal, plaintextSizes.Length));
    }

    [Fact]
    public void MaxEncryptedTotal_AllowsATagPerChunkPlusOnePerFile()
    {
        EncryptedStreamFormat.MaxEncryptedTotal(5 * Chunk, 2).Should().Be(5 * Chunk + (5 + 2) * 16);
    }
}
