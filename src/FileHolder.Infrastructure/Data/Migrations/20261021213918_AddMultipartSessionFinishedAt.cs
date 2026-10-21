using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace FileHolder.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddMultipartSessionFinishedAt : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "FinishedAt",
                table: "MultipartUploadSessions",
                type: "timestamp with time zone",
                nullable: true);

            // When older sessions finished was never recorded. Nothing reads a finished session, so dating it from
            // its start just lets the purge delete it sooner.
            migrationBuilder.Sql(
                "UPDATE \"MultipartUploadSessions\" SET \"FinishedAt\" = \"CreatedAt\" " +
                "WHERE \"IsCompleted\" OR \"IsAborted\";");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "FinishedAt",
                table: "MultipartUploadSessions");
        }
    }
}
