import React, { useState } from 'react';
import { Button } from '../../shared/components/Button';
import { CopyButton } from '../../shared/components/CopyButton';
import { benchmarkReport, BENCHMARK_SETTINGS, describeResult, runBenchmark, type BenchmarkResult } from './argon2Benchmark';

const CARD = "bg-surface border border-line rounded-2xl p-5 sm:p-7 space-y-5 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_rgb(0_0_0/0.05)]";

/**
 * How long this device takes to stretch a passkey with each Argon2id setting (#78), to choose the settings new
 * uploads use: about 1 s on a computer and under 3 s on a phone. Not linked from anywhere; open /diagnostics/argon2.
 */
const Argon2BenchmarkPage: React.FC = () => {
    const [results, setResults] = useState<readonly BenchmarkResult[]>([]);
    const [isRunning, setIsRunning] = useState<boolean>(false);

    const handleRun = async (): Promise<void> => {
        setIsRunning(true);
        setResults([]);
        try {
            await runBenchmark((result) => setResults((previous) => [...previous, result]));
        } finally {
            setIsRunning(false);
        }
    };

    const isDone = !isRunning && results.length === BENCHMARK_SETTINGS.length;

    return (
        <div className="max-w-[640px] mx-auto px-4 py-10 sm:py-14">
            <section aria-labelledby="benchmark-title" className={CARD}>
                <div className="space-y-2">
                    <h1 id="benchmark-title" className="text-xl font-semibold">Passkey speed test</h1>
                    <p className="text-sm text-muted">
                        Times Argon2id, which protects passkeys, at {BENCHMARK_SETTINGS.length} settings on this device.
                        It takes up to a minute and may warm up a phone. Keep this tab in front until it finishes.
                    </p>
                </div>

                <Button type="button" variant="primary" size="lg" onClick={handleRun} isLoading={isRunning}
                    loadingText={`Timing ${results.length + 1} of ${BENCHMARK_SETTINGS.length}...`}>
                    {results.length > 0 ? 'Run again' : 'Run the test'}
                </Button>

                {results.length > 0 && (
                    <ol aria-label="Timings" className="text-sm font-mono space-y-1">
                        {results.map((result) => <li key={describeResult(result)}>{describeResult(result)}</li>)}
                    </ol>
                )}

                {isDone && <CopyButton text={benchmarkReport(results)} label="Copy results" variant="secondary" size="md" />}
            </section>
        </div>
    );
};

export default Argon2BenchmarkPage;
