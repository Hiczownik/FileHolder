using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace FileHolder.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class AllowMultipleMultipartUploadsPerToken : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_MultipartUploadSessions_UploadToken",
                table: "MultipartUploadSessions");

            migrationBuilder.CreateIndex(
                name: "IX_MultipartUploadSessions_UploadToken_UploadId",
                table: "MultipartUploadSessions",
                columns: new[] { "UploadToken", "UploadId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_MultipartUploadSessions_UploadToken_UploadId",
                table: "MultipartUploadSessions");

            migrationBuilder.CreateIndex(
                name: "IX_MultipartUploadSessions_UploadToken",
                table: "MultipartUploadSessions",
                column: "UploadToken",
                unique: true);
        }
    }
}
