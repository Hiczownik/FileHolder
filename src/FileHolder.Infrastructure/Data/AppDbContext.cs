using FileHolder.Core.Entities;
using Microsoft.EntityFrameworkCore;

namespace FileHolder.Infrastructure.Data;

public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<FileGroup> FileGroups => Set<FileGroup>();
    public DbSet<SharedFile> SharedFiles => Set<SharedFile>();
    public DbSet<MultipartUploadSession> MultipartUploadSessions => Set<MultipartUploadSession>();
    public DbSet<DownloadSession> DownloadSessions => Set<DownloadSession>();
    public DbSet<PendingUpload> PendingUploads => Set<PendingUpload>();
    public DbSet<ServiceModeChange> ServiceModeChanges => Set<ServiceModeChange>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(AppDbContext).Assembly);
    }
}