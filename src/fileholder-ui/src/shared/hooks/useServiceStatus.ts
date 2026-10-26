import { useEffect, useState } from 'react';
import {
    currentServiceStatus,
    loadServiceStatus,
    subscribeToServiceStatus,
    type ServiceStatus,
} from '../services/serviceStatus';

/** The deployment's mode: null until the server answers, then kept up to date when it's asked again. */
export function useServiceStatus(): ServiceStatus | null {
    const [status, setStatus] = useState<ServiceStatus | null>(currentServiceStatus);

    useEffect(() => {
        let active = true;
        const unsubscribe = subscribeToServiceStatus((next) => {
            if (active) setStatus(next);
        });
        const load = async (): Promise<void> => {
            const loaded = await loadServiceStatus();
            if (active) setStatus(loaded);
        };
        void load();
        return () => {
            active = false;
            unsubscribe();
        };
    }, []);

    return status;
}
