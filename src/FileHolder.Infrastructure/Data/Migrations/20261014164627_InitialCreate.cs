using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace FileHolder.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class InitialCreate : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "FileGroups",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ShareToken = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    Title = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: true),
                    PasswordHash = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: true),
                    MaxDownloads = table.Column<int>(type: "integer", nullable: true),
                    DownloadCount = table.Column<int>(type: "integer", nullable: false),
                    ExpiresAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    IsDeleted = table.Column<bool>(type: "boolean", nullable: false),
                    IsEncrypted = table.Column<bool>(type: "boolean", nullable: false, defaultValue: false),
                    EncryptedManifest = table.Column<string>(type: "text", nullable: true),
                    KeyEnvelope = table.Column<string>(type: "text", nullable: true),
                    KeySalt = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_FileGroups", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "MultipartUploadSessions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UploadToken = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    UploadId = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
                    StorageKey = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: false),
                    FileName = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: false),
                    ContentType = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    TotalSizeBytes = table.Column<long>(type: "bigint", nullable: false),
                    PartSizeBytes = table.Column<long>(type: "bigint", nullable: false),
                    TotalParts = table.Column<int>(type: "integer", nullable: false),
                    IsCompleted = table.Column<bool>(type: "boolean", nullable: false),
                    IsAborted = table.Column<bool>(type: "boolean", nullable: false),
                    ExpiresAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MultipartUploadSessions", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "SharedFiles",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    FileGroupId = table.Column<Guid>(type: "uuid", nullable: false),
                    OriginalFileName = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: false),
                    StorageKey = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: false),
                    ContentType = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                    SizeBytes = table.Column<long>(type: "bigint", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SharedFiles", x => x.Id);
                    table.ForeignKey(
                        name: "FK_SharedFiles_FileGroups_FileGroupId",
                        column: x => x.FileGroupId,
                        principalTable: "FileGroups",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_FileGroups_ExpiresAt_DownloadCount_MaxDownloads",
                table: "FileGroups",
                columns: new[] { "ExpiresAt", "DownloadCount", "MaxDownloads" },
                filter: "\"IsDeleted\" = FALSE");

            migrationBuilder.CreateIndex(
                name: "IX_FileGroups_ShareToken",
                table: "FileGroups",
                column: "ShareToken",
                unique: true,
                filter: "\"IsDeleted\" = FALSE");

            migrationBuilder.CreateIndex(
                name: "IX_MultipartUploadSessions_IsCompleted_IsAborted_ExpiresAt",
                table: "MultipartUploadSessions",
                columns: new[] { "IsCompleted", "IsAborted", "ExpiresAt" });

            migrationBuilder.CreateIndex(
                name: "IX_MultipartUploadSessions_UploadToken",
                table: "MultipartUploadSessions",
                column: "UploadToken",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_SharedFiles_FileGroupId",
                table: "SharedFiles",
                column: "FileGroupId");

            migrationBuilder.CreateIndex(
                name: "IX_SharedFiles_StorageKey",
                table: "SharedFiles",
                column: "StorageKey",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "MultipartUploadSessions");

            migrationBuilder.DropTable(
                name: "SharedFiles");

            migrationBuilder.DropTable(
                name: "FileGroups");
        }
    }
}
