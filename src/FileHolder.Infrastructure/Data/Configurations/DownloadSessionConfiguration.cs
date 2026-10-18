using FileHolder.Core.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace FileHolder.Infrastructure.Data.Configurations;

public class DownloadSessionConfiguration : IEntityTypeConfiguration<DownloadSession>
{
    public void Configure(EntityTypeBuilder<DownloadSession> builder)
    {
        builder.ToTable("DownloadSessions");

        builder.HasKey(s => s.Id);

        builder.Property(s => s.CreatedAt)
            .HasColumnType("timestamp with time zone")
            .IsRequired();

        builder.Property(s => s.ExpiresAt)
            .HasColumnType("timestamp with time zone")
            .IsRequired();

        builder.HasOne(s => s.FileGroup)
            .WithMany()
            .HasForeignKey(s => s.FileGroupId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasIndex(s => s.ExpiresAt);
    }
}
