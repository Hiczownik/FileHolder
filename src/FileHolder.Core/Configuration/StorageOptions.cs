using System.ComponentModel.DataAnnotations;

namespace FileHolder.Core.Configuration;

public class StorageOptions
{
    public const string SectionName = "Storage";

    [Required(ErrorMessage = "Storage:ServiceUrl is required.")]
    public string ServiceUrl { get; set; } = "http://localhost:9000";
    
    [Required(ErrorMessage = "Storage:PublicBaseUrl is required.")]
    public string PublicBaseUrl { get; set; } = "http://localhost:9000";
    
    [Required(ErrorMessage = "Storage:AccessKey is required.")]
    public string AccessKey { get; set; } = "minioadmin";
    
    [Required(ErrorMessage = "Storage:SecretKey is required.")]
    public string SecretKey { get; set; } = "minioadmin";
    
    [Required(ErrorMessage = "Storage:BucketName is required.")]
    public string BucketName { get; set; } = "fileholder-bucket";
}