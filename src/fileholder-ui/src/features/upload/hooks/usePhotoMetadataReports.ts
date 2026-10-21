import { useEffect, useRef, useState } from "react";
import { detectPhotoMetadata, type MetadataReport } from "../../../shared/utils/imageMetadata";

/**
 * What metadata each picked file has, found in the background from its headers. A file's report appears once it is
 * ready (usually within milliseconds); until then it is simply absent, so labels can never hold up an upload.
 */
export function usePhotoMetadataReports(files: readonly File[]): ReadonlyMap<File, MetadataReport> {
    const [reports, setReports] = useState<ReadonlyMap<File, MetadataReport>>(() => new Map());
    // Files already being inspected, so a re-render never starts the same work twice.
    const requested = useRef(new WeakSet<File>());

    useEffect(() => {
        files.filter((file) => !requested.current.has(file)).forEach((file) => {
            requested.current.add(file);
            void (async () => {
                const report = await detectPhotoMetadata(file);
                setReports((previous) => new Map(previous).set(file, report));
            })();
        });
    }, [files]);

    return reports;
}
