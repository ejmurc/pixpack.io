import esbuild, { type BuildOptions, type Plugin } from 'esbuild';
import { watch, type FSWatcher } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { minify } from 'html-minifier-terser';

interface PageConfig {
    template: string;
    out: string;
    entryPoints: string[];
}

const ROOT = process.cwd();
const OUTDIR = 'dist';
const STATIC_DIR = 'src/assets';
const HOST = 'localhost';
const PORT = Number(process.env.PORT) || 3000;
const isServe = process.argv.includes('--serve');

const PAGES: PageConfig[] = [
    {
        template: 'src/pages/index.html',
        out: 'index.html',
        entryPoints: ['src/main.ts', 'src/styles/main.css'],
    },
];

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const dim = (text: string) => (useColor ? `\x1b[2m${text}\x1b[22m` : text);
const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} kB`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const isErrno = (e: unknown, code: string): e is NodeJS.ErrnoException =>
    e instanceof Error && 'code' in e && e.code === code;

const isBuildFailure = (e: unknown) =>
    typeof e === 'object' && e !== null && 'errors' in e;

const reportError = (e: unknown) => {
    if (isBuildFailure(e)) return;
    console.error(e instanceof Error ? e.message : String(e));
};

const brotliSize = (data: Buffer) => zlib.brotliCompressSync(data).length;

function inject(html: string, tag: string, content: string) {
    if (!html.includes(tag)) throw new Error(`Template is missing ${tag}`);
    return html.replace(tag, () => content + tag);
}

async function writeIfChanged(file: string, content: Buffer) {
    try {
        if ((await fs.readFile(file)).equals(content)) return;
    } catch (e) {
        if (!isErrno(e, 'ENOENT')) throw e;
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
}

function table(rows: string[][]) {
    const widths = rows[0].map((_, i) =>
        Math.max(...rows.map((row) => row[i].length))
    );
    return rows.map(
        (row) =>
            '  ' +
            row
                .map((cell, i) => {
                    if (i === 0) return cell.padEnd(widths[i]);
                    const padded = cell.padStart(widths[i]);
                    return i >= 2 ? dim(padded) : padded;
                })
                .join('   ')
                .trimEnd()
    );
}

async function walk(dir: string, base = dir): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(
        entries.map((entry) => {
            const full = path.join(dir, entry.name);
            return entry.isDirectory()
                ? walk(full, base)
                : Promise.resolve([path.relative(base, full)]);
        })
    );
    return nested.flat();
}

let staticFiles = new Set<string>();

async function syncStatic() {
    const source = path.resolve(ROOT, STATIC_DIR);
    const outdir = path.resolve(ROOT, OUTDIR);

    let files: string[] = [];
    try {
        files = await walk(source);
    } catch (e) {
        if (!isErrno(e, 'ENOENT')) throw e;
    }

    const current = new Set(files);
    await Promise.all(
        [...staticFiles]
            .filter((file) => !current.has(file))
            .map((file) => fs.rm(path.join(outdir, file), { force: true }))
    );
    await Promise.all(
        files.map(async (file) => {
            const dest = path.join(outdir, file);
            await fs.mkdir(path.dirname(dest), { recursive: true });
            await fs.copyFile(path.join(source, file), dest);
        })
    );
    staticFiles = current;
}

const htmlPlugin: Plugin = {
    name: 'html',
    setup(build) {
        const root = build.initialOptions.absWorkingDir ?? ROOT;
        const outdir = path.resolve(root, OUTDIR);
        const publicPath = (build.initialOptions.publicPath ?? '/').replace(
            /\/?$/,
            '/'
        );
        const rel = (abs: string) =>
            path.relative(outdir, abs).split(path.sep).join('/');
        const toUrl = (abs: string) => publicPath + rel(abs);

        let startedAt = 0;
        let builds = 0;
        let lastBuildOk = false;

        build.onStart(() => {
            startedAt = performance.now();
        });

        build.onEnd(async (result) => {
            if (result.errors.length > 0 || !result.metafile) {
                const note =
                    isServe && lastBuildOk
                        ? ' Still serving the previous build.'
                        : '';
                console.error(
                    `Build failed with ${plural(result.errors.length, 'error')}.${note}`
                );
                return;
            }

            const outputsByEntry = new Map<string, string[]>();
            const bundles: { name: string; abs: string; bytes: number }[] = [];
            for (const [file, meta] of Object.entries(
                result.metafile.outputs
            )) {
                if (!meta.entryPoint) continue;
                const abs = path.resolve(root, file);
                const key = path.resolve(root, meta.entryPoint);
                outputsByEntry.set(key, [
                    ...(outputsByEntry.get(key) ?? []),
                    abs,
                ]);
                bundles.push({ name: rel(abs), abs, bytes: meta.bytes });
            }

            const pages = await Promise.all(
                PAGES.map(async (page) => {
                    const css = new Set<string>();
                    const js = new Set<string>();

                    for (const entry of page.entryPoints) {
                        const outputs = outputsByEntry.get(
                            path.resolve(root, entry)
                        );
                        if (!outputs) {
                            throw new Error(
                                `No build output for entry "${entry}"`
                            );
                        }
                        for (const out of outputs) {
                            (out.endsWith('.css') ? css : js).add(toUrl(out));
                        }
                    }

                    const head = [
                        ...[...css].map(
                            (href) => `<link rel="stylesheet" href="${href}">`
                        ),
                        ...[...js].map(
                            (src) => `<script src="${src}" defer></script>`
                        ),
                    ].join('');

                    let html = inject(
                        await fs.readFile(
                            path.resolve(root, page.template),
                            'utf-8'
                        ),
                        '</head>',
                        head
                    );
                    if (!isServe) {
                        html = await minify(html, {
                            collapseWhitespace: true,
                            removeComments: true,
                            minifyCSS: true,
                            minifyJS: false,
                        });
                    }

                    const buffer = Buffer.from(html);
                    await writeIfChanged(path.join(outdir, page.out), buffer);
                    return { name: page.out, buffer };
                })
            );

            const rows: string[][] = [];
            for (const bundle of bundles) {
                const row = [bundle.name, kb(bundle.bytes)];
                if (!isServe) {
                    row.push(
                        `${kb(brotliSize(await fs.readFile(bundle.abs)))} br`
                    );
                }
                rows.push(row);
            }
            for (const page of pages) {
                const row = [page.name, kb(page.buffer.length)];
                if (!isServe) row.push(`${kb(brotliSize(page.buffer))} br`);
                rows.push(row);
            }

            const elapsed = Math.round(performance.now() - startedAt);
            const warnings = result.warnings.length;
            const verb = builds++ === 0 ? 'Build' : 'Rebuild';
            const note = warnings ? ` with ${plural(warnings, 'warning')}` : '';

            console.log(
                `${verb} complete${note} ${dim(`(${seconds(elapsed)})`)}`
            );
            console.log();
            for (const line of table(rows)) console.log(line);
            if (isServe) console.log();
            lastBuildOk = true;
        });
    },
};

const config: BuildOptions = {
    absWorkingDir: ROOT,
    entryPoints: [...new Set(PAGES.flatMap((p) => p.entryPoints))],
    outdir: OUTDIR,
    publicPath: '/',
    bundle: true,
    metafile: true,
    target: 'es2022',
    entryNames: isServe ? '[name]' : '[name]-[hash]',
    assetNames: isServe ? '[name]' : '[name]-[hash]',
    loader: {
        '.webp': 'file',
        '.png': 'file',
        '.svg': 'file',
        '.otf': 'file',
        '.woff': 'file',
        '.woff2': 'file',
    },
    plugins: [htmlPlugin],
};

function watchNonBundled(ctx: esbuild.BuildContext) {
    const staticDir = path.resolve(ROOT, STATIC_DIR);
    const templateDirs = [
        ...new Set(
            PAGES.map((p) => path.resolve(ROOT, path.dirname(p.template)))
        ),
    ];
    const watchers: FSWatcher[] = [];

    const debounce = (task: () => Promise<unknown>) => {
        let timer: NodeJS.Timeout | undefined;
        return () => {
            clearTimeout(timer);
            timer = setTimeout(() => task().catch(reportError), 50);
        };
    };

    const rebuild = debounce(() => ctx.rebuild());
    const resync = debounce(syncStatic);

    const add = (dir: string, onChange: () => void) => {
        try {
            watchers.push(watch(dir, { recursive: true }, onChange));
        } catch (e) {
            if (!isErrno(e, 'ENOENT')) throw e;
        }
    };

    for (const dir of templateDirs) add(dir, rebuild);
    add(staticDir, resync);

    return () => {
        for (const watcher of watchers) watcher.close();
    };
}

async function main() {
    await fs.rm(path.resolve(ROOT, OUTDIR), { recursive: true, force: true });
    await syncStatic();

    if (!isServe) {
        try {
            await esbuild.build({ ...config, minify: true });
        } catch {
            process.exitCode = 1;
        }
        return;
    }

    const ctx = await esbuild.context({ ...config, sourcemap: true });
    const stopWatching = watchNonBundled(ctx);

    const shutdown = async () => {
        stopWatching();
        await ctx.dispose();
        process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);

    await ctx.watch();
    const { hosts, port } = await ctx.serve({
        servedir: OUTDIR,
        host: HOST,
        port: PORT,
    });
    console.log(`Serving on http://${hosts[0] ?? HOST}:${port}`);
    console.log();
}

await main();
