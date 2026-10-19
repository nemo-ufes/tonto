export function developmentVersion(stableVersion) {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(stableVersion);

    if (!match) {
        throw new Error(`The CLI release version must be stable SemVer before a local install; got ${stableVersion}.`);
    }

    const [, major, minor, patch] = match;
    return `${major}.${minor}.${Number(patch) + 1}-dev.${Date.now()}.${process.pid}`;
}
