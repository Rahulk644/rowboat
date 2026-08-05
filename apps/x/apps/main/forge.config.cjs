// Electron Forge config file
// NOTE: Must be .cjs (CommonJS) because package.json has "type": "module"
// Forge loads configs with require(), which fails on ESM files

const path = require('path');
const pkg = require('./package.json');

// The Arch Linux (pacman) package is meant only for local builds on an Arch host
// with makepkg. It already self-skips elsewhere (maker-pacman checks for makepkg),
// but CI sets ROWBOAT_SKIP_PACMAN=1 to disable it explicitly — GitHub runners are
// Ubuntu and shouldn't attempt to ship an Arch package.
const SKIP_PACMAN = process.env.ROWBOAT_SKIP_PACMAN === '1';
const SKIP_CODE_SIGNING = process.env.ROWBOAT_SKIP_CODE_SIGNING === '1';
// Contributors without a certificate use Forge's recursive signer with an
// ad-hoc identity. Do not post-sign only the outer .app: that leaves nested
// executables, including meeting-bridge, outside the sealed signature.
const LOCAL_SIGNING_IDENTITY = process.env.ROWBOAT_LOCAL_SIGNING_IDENTITY?.trim() || undefined;
const LOCAL_ADHOC_SIGNING = process.env.ROWBOAT_LOCAL_ADHOC_SIGNING === '1';
const MEETING_CONTRIBUTOR_BUILD = process.env.ROWBOAT_MEETING_CONTRIBUTOR_BUILD === '1';
if (LOCAL_SIGNING_IDENTITY && LOCAL_ADHOC_SIGNING) {
    throw new Error('ROWBOAT_LOCAL_SIGNING_IDENTITY and ROWBOAT_LOCAL_ADHOC_SIGNING are mutually exclusive');
}
// The native meeting bridge is an alpha resource. Keep normal Rowboat
// packages byte-for-byte on their current path unless this exact build flag is
// deliberately provided by the release engineer.
const MEETING_BRIDGE_ALPHA = process.env.ROWBOAT_MEETING_BRIDGE_ALPHA === '1';
// Operational LocalVQE qualification is a stricter subset of the meeting
// bridge alpha. The stage script refuses unreviewed paths/checksums and this
// flag must never affect a normal package.
const MEETING_AEC_ALPHA = process.env.ROWBOAT_MEETING_AEC_ALPHA === '1';
if (MEETING_AEC_ALPHA && !MEETING_BRIDGE_ALPHA) {
    throw new Error('ROWBOAT_MEETING_AEC_ALPHA requires ROWBOAT_MEETING_BRIDGE_ALPHA=1');
}
if (MEETING_AEC_ALPHA && !MEETING_CONTRIBUTOR_BUILD) {
    throw new Error('ROWBOAT_MEETING_AEC_ALPHA is qualification-only and requires ROWBOAT_MEETING_CONTRIBUTOR_BUILD=1');
}
// Optional offline source for the exact Electron release ZIP. This is useful
// on restricted build hosts that already have the matching runtime installed;
// Electron Packager still owns extraction and bundle construction.
const ELECTRON_ZIP_DIR = process.env.ROWBOAT_ELECTRON_ZIP_DIR?.trim() || undefined;
if (ELECTRON_ZIP_DIR && !path.isAbsolute(ELECTRON_ZIP_DIR)) {
    throw new Error('ROWBOAT_ELECTRON_ZIP_DIR must be an absolute path');
}
const MEETING_BRIDGE_STAGE_DIR = path.join(__dirname, '.package', 'resources', 'meeting-bridge');
const MEETING_BRIDGE_STAGE_SCRIPT = path.resolve(
    __dirname,
    '../../../../native/meeting-bridge/scripts/stage.mjs',
);
const MEETING_CONTRIBUTOR_MARKER = path.resolve(__dirname, '../../../../script/meeting-contributor-build.json');

const ENTITLEMENTS = path.join(__dirname, 'entitlements.plist');
const LOCAL_ADHOC_APP_ENTITLEMENTS = [
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.disable-library-validation',
    'com.apple.security.device.audio-input',
    'com.apple.security.device.screen-capture',
];
const LOCAL_ADHOC_HELPER_ENTITLEMENTS = [
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.disable-library-validation',
];
const LOCAL_ADHOC_PLUGIN_ENTITLEMENTS = [
    'com.apple.security.cs.allow-unsigned-executable-memory',
    'com.apple.security.cs.disable-library-validation',
];
const MACOS_PRODUCT_NAME = MEETING_CONTRIBUTOR_BUILD ? 'Rowboat Meetings Dev' : 'Rowboat';
const MACOS_APP_BUNDLE_NAME = `${MACOS_PRODUCT_NAME}.app`;
const MACOS_HELPER_BUNDLE_PREFIX = `${path.sep}Frameworks${path.sep}${MACOS_PRODUCT_NAME} Helper`;
const signingOptionsForFile = (filePath) => {
    // The Rust bridge and its model/library are not Electron processes. Keep
    // JIT and device entitlements out of that trust boundary.
    if (filePath.includes(`${path.sep}Resources${path.sep}meeting-bridge${path.sep}`)) {
        return { entitlements: [] };
    }
    if (LOCAL_ADHOC_SIGNING && filePath.includes(MACOS_HELPER_BUNDLE_PREFIX)) {
        return {
            entitlements: filePath.includes('(Plugin).app')
                ? LOCAL_ADHOC_PLUGIN_ENTITLEMENTS
                : LOCAL_ADHOC_HELPER_ENTITLEMENTS,
        };
    }
    if (path.basename(filePath) === MACOS_APP_BUNDLE_NAME) {
        return {
            // Independently ad-hoc-signed Mach-O files have no common Team ID,
            // so only local contributor bundles need library validation off.
            // Developer ID/release packages continue to use the strict plist.
            entitlements: LOCAL_ADHOC_SIGNING ? LOCAL_ADHOC_APP_ENTITLEMENTS : ENTITLEMENTS,
        };
    }
    // Preserve @electron/osx-sign's purpose-built helper entitlements.
    return {};
};

const MACOS_SIGNING = SKIP_CODE_SIGNING
    ? {}
    : (LOCAL_SIGNING_IDENTITY || LOCAL_ADHOC_SIGNING)
        ? {
              // Forge/@electron/osx-sign walks code objects deepest-first. This
              // seals `Resources/meeting-bridge`, which Electron main launches
              // as an independently executed helper.
              osxSign: {
                  batchCodesignCalls: true,
                  // A package that failed to seal is not a usable macOS
                  // artifact. Never let Packager continue with a partial or
                  // inherited Electron linker signature.
                  continueOnError: false,
                  identity: LOCAL_SIGNING_IDENTITY ?? '-',
                  // `-` is deliberately an ad-hoc identity and cannot be
                  // discovered in Keychain.
                  ...(LOCAL_ADHOC_SIGNING && !LOCAL_SIGNING_IDENTITY
                      ? {
                            identityValidation: false,
                            preAutoEntitlements: false,
                            preEmbedProvisioningProfile: false,
                        }
                      : {}),
                  optionsForFile: signingOptionsForFile,
              },
          }
        : {
              osxSign: {
                  batchCodesignCalls: true,
                  continueOnError: false,
                  optionsForFile: signingOptionsForFile,
              },
              osxNotarize: {
                  appleId: process.env.APPLE_ID,
                  appleIdPassword: process.env.APPLE_PASSWORD,
                  teamId: process.env.APPLE_TEAM_ID,
              },
          };

// Windows code signing via Azure Trusted Signing — CI-only. The GitHub workflow
// downloads the Azure dlib, writes metadata.json, and exports these env vars;
// when they're absent (local builds, mac/linux jobs) Windows signing is skipped.
// signtool loads Azure.CodeSigning.Dlib.dll (/dlib), which reads metadata.json
// (/dmdf) for the endpoint/account/profile and authenticates via
// AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET.
// NOTE: @electron/windows-sign splits signWithParams on spaces, so the dlib and
// metadata paths must not contain spaces (the workflow stages them in C:\azsign).
const WINDOWS_SIGN =
    !SKIP_CODE_SIGNING &&
    process.env.AZURE_CODE_SIGNING_DLIB &&
    process.env.AZURE_METADATA_JSON
        ? {
              // The signtool vendored by @electron/windows-sign is too old for the
              // Azure dlib; the workflow points this at the Windows SDK's signtool.
              ...(process.env.SIGNTOOL_PATH ? { signToolPath: process.env.SIGNTOOL_PATH } : {}),
              signWithParams: `/v /debug /dlib ${process.env.AZURE_CODE_SIGNING_DLIB} /dmdf ${process.env.AZURE_METADATA_JSON}`,
              timestampServer: 'http://timestamp.acs.microsoft.com',
              hashes: ['sha256'],
          }
        : undefined;

// Stage the ACP coding-adapters (@agentclientprotocol/*-acp) and their full
// production dependency closure into the packaged app.
//
// Why this is needed: code mode spawns each adapter as a SEPARATE `node <entry>`
// process and locates it at runtime via require.resolve — so it must ship as a real
// on-disk file. esbuild can't inline it (dynamic resolve + spawn target), and Forge
// strips the workspace node_modules (see `ignore` below). Without this, packaged
// builds throw `Cannot find module '@agentclientprotocol/...'`.
//
// Why we reconstruct the tree instead of copying node_modules: pnpm's store is a
// symlink farm that legitimately holds multiple versions of the same package (e.g.
// @agentclientprotocol/sdk 0.21 for claude vs 0.22 for codex). We rebuild an npm-style
// node_modules — dereferencing symlinks — that resolves correctly regardless of pnpm
// layout. We HOIST every package to the top-level node_modules and only nest a package
// under its requirer on a genuine version conflict. Hoisting (vs. always nesting) keeps
// the tree shallow: without it, transitive chains like codex-acp → open → wsl-utils →
// is-wsl → is-inside-container → is-docker nest 5+ deep and produce ~260-char paths that
// break the Windows Squirrel/nuget maker's MAX_PATH limit. Node resolution stays correct
// because the top-level node_modules is an ancestor of every staged file, so a hoisted
// package resolves for all requirers and a conflicting version shadows it via nesting.
// verifyAcpStaging() below asserts this held for every dependency edge.
//
// What we DON'T bundle: the agents' native engines (claude / codex, ~200 MB each, shipped
// as platform-specific packages). Those are PROVISIONED on demand into
// ~/.rowboat/engines/<agent>/<version>/ and the adapters are pointed at them via
// CLAUDE_CODE_EXECUTABLE / CODEX_PATH (see packages/core/src/code-mode/acp/). Skipping
// them keeps each OS installer ~400 MB smaller while code mode stays fully functional.
// Shared by stageAcpAdapters and verifyAcpStaging so staging and verification use
// identical resolution semantics.
const ACP_ADAPTERS = [
    '@agentclientprotocol/claude-agent-acp',
    '@agentclientprotocol/codex-acp',
];

// The native engines, shipped as platform packages. Provisioned on demand
// (see header comment), so they're excluded from staging.
const isAcpNativeEngine = (key) =>
    /^@anthropic-ai\/claude-agent-sdk-(win32|darwin|linux)/.test(key) || // native claude
    /^@openai\/codex-(win32|darwin|linux)/.test(key);                    // native codex

// Resolve a dependency's real directory by walking node_modules the way Node does,
// looking for the package DIRECTORY. We deliberately do NOT use
// require.resolve(`${key}/package.json`): that throws for packages whose `exports`
// map doesn't expose package.json (e.g. @anthropic-ai/claude-agent-sdk), which would
// silently drop them and their subtrees. realpathSync dereferences pnpm's symlinks.
// Returns null for deps not installed for this OS (platform-optional binaries).
const acpRealDirOf = (key, fromDir) => {
    const fs = require('fs');
    let dir = fromDir;
    for (;;) {
        const cand = path.join(dir, 'node_modules', ...key.split('/'));
        if (fs.existsSync(path.join(cand, 'package.json'))) return fs.realpathSync(cand);
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
};

function stageAcpAdapters(mainDir, destNodeModules) {
    const fs = require('fs');

    let copied = 0;
    const skippedEngines = new Set();
    // srcRealDir -> the staged directory whose content represents it. Lets
    // verifyAcpStaging map every source package to where it landed.
    const placements = new Map();
    // package key -> version placed at the TOP-LEVEL node_modules. We hoist every
    // package to the top level and only nest a package under its requirer when a
    // DIFFERENT version is already hoisted there. See the header comment for why
    // (a shallow tree stays under Windows' MAX_PATH).
    const rootHoisted = new Map();
    const install = (srcDir, key, parentNM, chain) => {
        if (chain.has(srcDir)) return;      // dependency cycle — resolves to ancestor copy
        const pj = JSON.parse(fs.readFileSync(path.join(srcDir, 'package.json'), 'utf8'));
        const version = pj.version;
        const hoisted = rootHoisted.get(key);
        let destNM;
        if (hoisted === undefined) {
            destNM = destNodeModules;       // first sighting → hoist to the top level
            rootHoisted.set(key, version);
        } else if (hoisted === version) {
            // identical version already hoisted at root → reuse it (its subtree is
            // already staged); just record where this srcDir resolves to.
            placements.set(srcDir, path.join(destNodeModules, ...key.split('/')));
            return;
        } else {
            destNM = parentNM;              // genuine version conflict → nest under requirer
        }
        const destDir = path.join(destNM, ...key.split('/'));
        placements.set(srcDir, destDir);
        if (fs.existsSync(destDir)) return; // already placed at this exact location
        fs.mkdirSync(path.dirname(destDir), { recursive: true });
        fs.cpSync(srcDir, destDir, {
            recursive: true,
            dereference: true,
            filter: (s) => path.basename(s) !== 'node_modules', // deps handled by recursion
        });
        copied++;
        const deps = { ...pj.dependencies, ...pj.optionalDependencies };
        const nextChain = new Set(chain).add(srcDir);
        for (const depKey of Object.keys(deps)) {
            if (isAcpNativeEngine(depKey)) { skippedEngines.add(depKey); continue; }
            const depDir = acpRealDirOf(depKey, srcDir);
            if (depDir) install(depDir, depKey, path.join(destDir, 'node_modules'), nextChain);
        }
    };

    for (const key of ACP_ADAPTERS) {
        const srcDir = acpRealDirOf(key, mainDir);
        if (!srcDir) {
            throw new Error(`ACP adapter '${key}' is not installed in ${mainDir} — run pnpm install`);
        }
        install(srcDir, key, destNodeModules, new Set());
    }
    if (skippedEngines.size) {
        console.log(`  (skipped native engines — provisioned on demand: ${[...skippedEngines].join(', ')})`);
    }
    return { copied, placements };
}

// Fail the build LOUDLY if hoisting misplaced anything. Re-walk the source dependency
// closure and assert that every (package → dependency) edge resolves, in the STAGED
// tree, to the SAME version it resolves to in the SOURCE pnpm tree. This converts a
// silent runtime "Cannot find module" (or a wrong-version resolution from a botched
// hoist) into an immediate build failure. Expectations are derived from the source
// tree — nothing is hardcoded — so it keeps working as the dependency set changes.
function verifyAcpStaging(mainDir, placements) {
    const fs = require('fs');
    const versionAt = (dir) =>
        JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
    // Resolve `key`'s staged version as seen from `fromStagedDir`, via Node's own
    // upward node_modules walk. Reads package.json directly (not require.resolve, whose
    // `${key}/package.json` subpath some exports maps block).
    const stagedVersionOf = (key, fromStagedDir) => {
        let dir = fromStagedDir;
        for (;;) {
            const cand = path.join(dir, 'node_modules', ...key.split('/'));
            if (fs.existsSync(path.join(cand, 'package.json'))) return versionAt(cand);
            const parent = path.dirname(dir);
            if (parent === dir) return null;
            dir = parent;
        }
    };
    const errors = [];
    const visited = new Set();
    const walk = (srcDir) => {
        if (visited.has(srcDir)) return;
        visited.add(srcDir);
        const pj = JSON.parse(fs.readFileSync(path.join(srcDir, 'package.json'), 'utf8'));
        const stagedDir = placements.get(srcDir);
        if (!stagedDir) { errors.push(`not staged: ${pj.name}@${pj.version}`); return; }
        const deps = { ...pj.dependencies, ...pj.optionalDependencies };
        for (const depKey of Object.keys(deps)) {
            if (isAcpNativeEngine(depKey)) continue;
            const depSrc = acpRealDirOf(depKey, srcDir);
            if (!depSrc) continue; // platform-optional / not installed for this OS
            const want = versionAt(depSrc);
            const got = stagedVersionOf(depKey, stagedDir);
            if (got === null) {
                errors.push(`${pj.name} → ${depKey}: unresolved in staged tree (expected ${want})`);
            } else if (got !== want) {
                errors.push(`${pj.name} → ${depKey}: staged resolves ${got}, source resolves ${want}`);
            }
            walk(depSrc);
        }
    };
    for (const key of ACP_ADAPTERS) {
        const srcDir = acpRealDirOf(key, mainDir);
        if (srcDir) walk(srcDir);
    }
    if (errors.length) {
        throw new Error(
            `ACP staging verification failed — the staged tree resolves differently than source:\n  - ${errors.join('\n  - ')}`
        );
    }
}

module.exports = {
    // Skip @electron/rebuild entirely. Both native deps (node-pty,
    // uiohook-napi) are N-API modules whose prebuilt binaries are staged by
    // bundle.mjs — there is nothing to rebuild, and the default rebuild pass
    // tries to DOWNLOAD Electron-ABI prebuilds from github.com (fails
    // offline, and uiohook-napi has none to download anyway).
    rebuildConfig: {
        onlyModules: [],
    },
    packagerConfig: {
        // Electron Packager derives both the .app bundle name and the output
        // directory from `name`. Keep contributor qualification visibly
        // distinct from the installed Rowboat release, not only by bundle ID.
        ...(MEETING_CONTRIBUTOR_BUILD ? { name: 'Rowboat Meetings Dev' } : {}),
        executableName: MEETING_CONTRIBUTOR_BUILD ? 'Rowboat Meetings Dev' : 'rowboat',
        ...(ELECTRON_ZIP_DIR ? { electronZipDir: ELECTRON_ZIP_DIR } : {}),
        icon: './icons/icon',  // .icns extension added automatically
        appBundleId: MEETING_CONTRIBUTOR_BUILD ? 'com.rowboat.meetings-dev' : 'com.rowboat.app',
        appCategoryType: 'public.app-category.productivity',
        ...(MEETING_CONTRIBUTOR_BUILD ? {} : {
            protocols: [
                { name: 'Rowboat', schemes: ['rowboat'] },
            ],
        }),
        extendInfo: {
            ...(MEETING_CONTRIBUTOR_BUILD ? {
                CFBundleDisplayName: 'Rowboat Meetings Dev',
                CFBundleName: 'Rowboat Meetings Dev',
            } : {}),
            NSAudioCaptureUsageDescription: 'Rowboat needs access to system audio to transcribe meetings from other apps (Zoom, Meet, etc.)',
            NSCameraUsageDescription: 'Rowboat uses your camera in video chat mode so the assistant can see you and give feedback (e.g. pitch practice).',
        },
        // Signs the packaged app's executables (rowboat.exe etc.); the Squirrel
        // maker below separately signs the installer it produces.
        ...(WINDOWS_SIGN ? { windowsSign: WINDOWS_SIGN } : {}),
        ...MACOS_SIGNING,
        // Since we bundle the main process with esbuild, we don't need the workspace
        // node_modules. These settings prevent Forge's dependency walker (flora-colossus)
        // from trying to analyze/copy node_modules, which fails with pnpm's symlinked
        // workspaces.
        prune: false,
        // Electron Packager copies this directory to
        // process.resourcesPath/meeting-bridge. It is absent from normal
        // packages; the alpha script creates it deterministically in
        // generateAssets before Packager reads it.
        ...((MEETING_BRIDGE_ALPHA || MEETING_CONTRIBUTOR_BUILD) ? {
            extraResource: [
                ...(MEETING_BRIDGE_ALPHA ? [MEETING_BRIDGE_STAGE_DIR] : []),
                ...(MEETING_CONTRIBUTOR_BUILD ? [MEETING_CONTRIBUTOR_MARKER] : []),
            ],
        } : {}),
        // Strip the workspace src/node_modules (paths are ANCHORED to the app root), BUT
        // always keep everything under `.package/` — that's our staged output: the
        // bundled main process, the ACP adapters + their dependency closure (staged by
        // the generateAssets hook), and the native node-pty module (staged into
        // .package/node_modules by bundle.mjs). Without the `.package` exemption the
        // node_modules rule would strip those and code mode / the embedded terminal
        // would break in packaged builds.
        ignore: (p) => {
            if (p === '/.package' || p.startsWith('/.package/')) return false;
            return [/^\/src\//, /^\/node_modules\//, /\.gitignore/, /bundle\.mjs/, /tsconfig\.json/]
                .some((re) => re.test(p));
        },
    },
    makers: [
        {
            name: '@electron-forge/maker-dmg',
            config: (arch) => ({
                format: 'ULFO',
                name: `Rowboat-darwin-${arch}-${pkg.version}`,  // Architecture-specific name to avoid conflicts
            })
        },
        {
            name: '@electron-forge/maker-squirrel',
            config: (arch) => ({
                authors: 'rowboatlabs',
                description: 'AI coworker with memory',
                name: `Rowboat-win32-${arch}`,
                setupExe: `Rowboat-win32-${arch}-${pkg.version}-setup.exe`,
                setupIcon: path.join(__dirname, 'icons/icon.ico'),
                // The animation is Squirrel's ONLY install UI — without this
                // users stare at Squirrel's unbranded default mid-install.
                loadingGif: path.join(__dirname, 'icons/install-loading.gif'),
                // Add/Remove Programs icon. Must be a remote URL (Squirrel
                // limitation); defaults to the Atom feather otherwise.
                iconUrl: 'https://raw.githubusercontent.com/rowboatlabs/rowboat/main/apps/x/apps/main/icons/icon.ico',
                // Skip the machine-wide MSI deployment stub — it lands on the
                // GitHub release page next to setup.exe and users grab the
                // wrong one (it neither launches the app nor auto-updates).
                noMsi: true,
                // Sign the Squirrel installer (setup.exe) and the binaries it
                // repackages. No-op unless the CI signing env vars are set.
                ...(WINDOWS_SIGN ? { windowsSign: WINDOWS_SIGN } : {}),
            })
        },
        {
            name: '@electron-forge/maker-deb',
            config: (arch) => ({
                options: {
                    name: `Rowboat-linux`,
                    bin: "rowboat",
                    description: 'AI coworker with memory',
                    maintainer: 'rowboatlabs',
                    homepage: 'https://rowboatlabs.com',
                    icon: path.join(__dirname, 'icons/icon.png'),
                    mimeType: ['x-scheme-handler/rowboat'],
                }
            })
        },
        {
            name: '@electron-forge/maker-rpm',
            config: {
                options: {
                    name: `Rowboat-linux`,
                    bin: "rowboat",
                    description: 'AI coworker with memory',
                    homepage: 'https://rowboatlabs.com',
                    icon: path.join(__dirname, 'icons/icon.png'),
                    mimeType: ['x-scheme-handler/rowboat'],
                }
            }
        },
        // Arch Linux package — local-only; disabled in CI via ROWBOAT_SKIP_PACMAN.
        ...(SKIP_PACMAN ? [] : [{
            name: require.resolve('./makers/maker-pacman.cjs'),
            platforms: ['linux'],
            config: {
                name: 'rowboat',
                bin: 'rowboat',
                executableName: 'rowboat',
                description: 'AI coworker with memory',
                maintainer: 'rowboatlabs',
                homepage: 'https://rowboatlabs.com',
                license: 'Apache',
                icon: path.join(__dirname, 'icons/icon.png'),
                mimeType: ['x-scheme-handler/rowboat'],
            }
        }]),
        {
            name: '@electron-forge/maker-zip',
            platform: ["darwin", "win32", "linux"],
        }
    ],
    publishers: [
        {
            name: '@electron-forge/publisher-github',
            config: {
                repository: {
                    owner: 'rowboatlabs',
                    name: 'rowboat'
                },
                prerelease: true
            }
        }
    ],
    hooks: {
        // Hook signature: (forgeConfig, platform, arch)
        // Note: Console output only shows if DEBUG or CI env vars are set
        generateAssets: async (forgeConfig, platform, arch) => {
            const { execSync, execFileSync } = require('child_process');
            const fs = require('fs');

            const packageDir = path.join(__dirname, '.package');

            // Clean staging directory (ensures fresh build every time)
            console.log('Cleaning staging directory...');
            if (fs.existsSync(packageDir)) {
                fs.rmSync(packageDir, { recursive: true });
            }
            fs.mkdirSync(packageDir, { recursive: true });

            // Build order matters! Dependencies must be built before dependents:
            // shared → core → (renderer, preload, main)

            // Build shared (TypeScript compilation) - no dependencies
            console.log('Building shared...');
            execSync('pnpm run build', {
                cwd: path.join(__dirname, '../../packages/shared'),
                stdio: 'inherit'
            });

            // Build core (TypeScript compilation) - depends on shared
            console.log('Building core...');
            execSync('pnpm run build', {
                cwd: path.join(__dirname, '../../packages/core'),
                stdio: 'inherit'
            });

            // Build renderer (Vite build) - depends on shared
            console.log('Building renderer...');
            execSync('pnpm run build', {
                cwd: path.join(__dirname, '../renderer'),
                stdio: 'inherit'
            });

            // Build preload (TypeScript compilation) - depends on shared
            console.log('Building preload...');
            execSync('pnpm run build', {
                cwd: path.join(__dirname, '../preload'),
                stdio: 'inherit'
            });

            // Build main (TypeScript compilation) - depends on core, shared
            console.log('Building main (tsc)...');
            execSync('pnpm run build', {
                cwd: __dirname,
                stdio: 'inherit'
            });

            // Bundle main process with esbuild (inlines all dependencies)
            console.log('Bundling main process...');
            execSync('node bundle.mjs', {
                cwd: __dirname,
                stdio: 'inherit'
            });

            if (MEETING_BRIDGE_ALPHA) {
                console.log(`Building and staging meeting bridge alpha for ${platform}/${arch}${MEETING_AEC_ALPHA ? ' with LocalVQE AEC assets' : ''}...`);
                // Fixed script + argument vector: platform and architecture
                // are validated by the script and never interpolated into a
                // shell command.
                execFileSync(process.execPath, [
                    MEETING_BRIDGE_STAGE_SCRIPT,
                    '--platform', platform,
                    '--arch', arch,
                    '--repository-root', path.resolve(__dirname, '../../../..'),
                    '--output-root', path.join(packageDir, 'resources'),
                ], {
                    cwd: __dirname,
                    stdio: 'inherit',
                    shell: false,
                });
            }

            // Copy preload dist into staging directory
            console.log('Copying preload...');
            const preloadSrc = path.join(__dirname, '../preload/dist');
            const preloadDest = path.join(packageDir, 'preload/dist');
            fs.mkdirSync(preloadDest, { recursive: true });
            fs.cpSync(preloadSrc, preloadDest, { recursive: true });

            // Copy renderer dist into staging directory
            console.log('Copying renderer...');
            const rendererSrc = path.join(__dirname, '../renderer/dist');
            const rendererDest = path.join(packageDir, 'renderer/dist');
            fs.mkdirSync(rendererDest, { recursive: true });
            fs.cpSync(rendererSrc, rendererDest, { recursive: true });

            // Stage the ACP coding-adapters (+ their JS dependency closure, minus native
            // engines) into .package/acp/node_modules. They are spawned as separate node
            // processes at runtime and Forge strips the workspace node_modules, so they
            // must be copied in explicitly. See stageAcpAdapters() above for the why.
            console.log('Staging ACP adapters...');
            const acpDest = path.join(packageDir, 'acp', 'node_modules');
            const { copied: staged, placements } = stageAcpAdapters(__dirname, acpDest);
            // Assert the hoisted tree resolves identically to source before shipping it.
            verifyAcpStaging(__dirname, placements);
            console.log(`✅ Staged ${staged} ACP adapter packages into .package/acp/node_modules (resolution verified)`);

            console.log('✅ All assets staged in .package/');
        },
    }
};
