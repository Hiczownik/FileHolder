/** A build of the UI or the API: its version and the first 7 characters of its commit ("unknown" without one). */
export interface BuildInfo {
    readonly version: string;
    readonly commit: string;
}

/** This UI's build, fixed at build time (vite.config.ts). */
export const UI_BUILD: BuildInfo = { version: __APP_VERSION__, commit: __GIT_SHA__ };

/** "v0.9.0 · abc1234", or just "v0.9.0" when the commit isn't known. */
export function describeBuild(build: BuildInfo): string {
    return build.commit === 'unknown' ? `v${build.version}` : `v${build.version} · ${build.commit}`;
}
