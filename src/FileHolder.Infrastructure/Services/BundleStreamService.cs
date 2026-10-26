using System.IO.Compression;
using System.IO.Pipelines;
using FileHolder.Core.Dtos;
using FileHolder.Core.Interfaces;
using FileHolder.Core.Security;
using FileHolder.Infrastructure.Diagnostics;

namespace FileHolder.Infrastructure.Services;

public class BundleStreamService(
    IS3StorageProvider storageProvider,
    IDownloadSessionService downloadSessionService
    )
    : IBundleStreamService
{
    private static readonly HashSet<string> PreCompressedExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp4", ".mov", ".avi", ".mkv",
        ".zip", ".tar", ".gz", ".7z", ".rar", ".pdf", ".mp3", ".wav"
    };

    private readonly IS3StorageProvider _storageProvider = storageProvider;
    private readonly IDownloadSessionService _downloadSessionService = downloadSessionService;

    public async Task<StreamZipResult> StreamBundleZipAsync(
        string shareToken,
        string? password,
        Guid? downloadSessionId,
        Stream destinationStream,
        Action<string>? onBeforeStream = null,
        CancellationToken ct = default)
    {
        // Reuse the recipient's session when given; otherwise this ZIP counts as one new download.
        Guid sessionId;
        if (downloadSessionId.HasValue)
        {
            sessionId = downloadSessionId.Value;
        }
        else
        {
            var opened = await _downloadSessionService.OpenSessionAsync(shareToken, password, ct);
            switch (opened.Status)
            {
                case OpenDownloadSessionStatus.NotFound:
                    return new StreamZipResult(StreamZipStatus.NotFound, null);
                case OpenDownloadSessionStatus.InvalidPassword:
                    return new StreamZipResult(StreamZipStatus.InvalidPassword, null);
                case OpenDownloadSessionStatus.Expired:
                    return new StreamZipResult(StreamZipStatus.Expired, null);
                case OpenDownloadSessionStatus.Removed:
                    return new StreamZipResult(StreamZipStatus.Removed, null);
                case OpenDownloadSessionStatus.LockedOut:
                    return new StreamZipResult(StreamZipStatus.LockedOut, null, opened.LockedUntil);
            }

            sessionId = opened.Session!.DownloadSessionId;
        }

        var session = await _downloadSessionService.GetActiveSessionAsync(shareToken, sessionId, ct);
        if (session == null)
        {
            return new StreamZipResult(StreamZipStatus.SessionInvalid, null);
        }

        var group = session.FileGroup;
        if (group.Files.Count == 0)
        {
            return new StreamZipResult(StreamZipStatus.EmptyBundle, null);
        }

        // Two files may share a name; as ZIP entries one would silently overwrite the other on extraction.
        var files = group.Files.ToList();
        var entryNames = FileSecurityUtils.MakeFileNamesUnique(files.Select(f => f.OriginalFileName).ToList());
        var fileEntries = files
            .Select((f, i) => new BundleFileEntry(entryNames[i], f.StorageKey))
            .ToList();

        var bundleTitle = group.Title ?? group.ShareToken;

        onBeforeStream?.Invoke(bundleTitle);

        // Storage is never deleted here: other recipients' sessions may still be using it.
        // The purge worker removes it once every session and presigned URL has expired.
        await FileHolderTracing.StepAsync("bundle_zip.stream", async activity =>
        {
            activity?.SetTag("fileholder.file_count", fileEntries.Count);
            await StreamArchiveInternalAsync(fileEntries, destinationStream, ct);
        });

        return new StreamZipResult(StreamZipStatus.Success, bundleTitle);
    }

    private async Task StreamArchiveInternalAsync(IEnumerable<BundleFileEntry> files, Stream destinationStream, CancellationToken ct)
    {
        var pipe = new Pipe(new PipeOptions(
            pauseWriterThreshold: 128 * 1024,
            resumeWriterThreshold: 64 * 1024,
            useSynchronizationContext: false));

        var fileList = files.ToList();
        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(ct);

        var producerTask = Task.Run(async () =>
        {
            Exception? producerException = null;
            try
            {
                await using var pipeStream = pipe.Writer.AsStream(leaveOpen: true);
                await using var zipArchive = new ZipArchive(pipeStream, ZipArchiveMode.Create, leaveOpen: true);
                for (var index = 0; index < fileList.Count; index++)
                {
                    var file = fileList[index];
                    linkedCts.Token.ThrowIfCancellationRequested();

                    var compressionLevel = DetermineCompressionLevel(file.OriginalFileName);

                    // The entry's index, never its name: entry names are the bundle's file names.
                    await FileHolderTracing.StepAsync("bundle_zip.entry", async activity =>
                    {
                        activity?.SetTag("fileholder.zip.entry_index", index)
                            .SetTag("fileholder.zip.compression", compressionLevel.ToString());

                        var entry = zipArchive.CreateEntry(file.OriginalFileName, compressionLevel);

                        await using var entryStream = await entry.OpenAsync(linkedCts.Token);
                        await using var s3Stream = await _storageProvider.OpenReadStreamAsync(file.StorageKey, linkedCts.Token);

                        await s3Stream.CopyToAsync(entryStream, 65536, linkedCts.Token);
                    });
                }
            }
            catch (Exception ex)
            {
                producerException = ex;
                throw;
            }
            finally
            {
                await pipe.Writer.CompleteAsync(producerException);
            }
        }, linkedCts.Token);

        Exception? consumerException = null;
        try
        {
            await pipe.Reader.CopyToAsync(destinationStream, linkedCts.Token);
        }
        catch (Exception ex)
        {
            consumerException = ex;
            await linkedCts.CancelAsync();
            throw;
        }
        finally
        {
            await pipe.Reader.CompleteAsync(consumerException);
            try
            {
                await producerTask;
            }
            catch when (consumerException != null)
            {
                // Preserve the original consumer/client exception
            }
        }
    }

    private static CompressionLevel DetermineCompressionLevel(string fileName)
    {
        var ext = Path.GetExtension(fileName);
        return PreCompressedExtensions.Contains(ext)
            ? CompressionLevel.NoCompression
            : CompressionLevel.Fastest;
    }
}