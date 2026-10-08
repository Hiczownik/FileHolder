export function saveBlobAsFile(blob: Blob, fileName: string): void {
    const objectUrl = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.setAttribute('download', fileName);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => {
        window.URL.revokeObjectURL(objectUrl);
    }, 1000);
}

export function triggerDirectDownload(url: string): void {
    window.location.href = url;
}