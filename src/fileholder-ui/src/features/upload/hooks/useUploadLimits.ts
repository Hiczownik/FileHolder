import { useEffect, useState } from "react";
import { DEFAULT_UPLOAD_LIMITS, loadUploadLimits, type UploadLimits } from "../services/uploadLimits";

/** The deployment's upload limits: the defaults at first, then the server's once it answers. */
export function useUploadLimits(): UploadLimits {
    const [limits, setLimits] = useState<UploadLimits>(DEFAULT_UPLOAD_LIMITS);

    useEffect(() => {
        let active = true;
        const load = async (): Promise<void> => {
            const loaded = await loadUploadLimits();
            if (active) setLimits(loaded);
        };
        void load();
        return () => {
            active = false;
        };
    }, []);

    return limits;
}
