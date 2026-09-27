import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

interface PageConfig {
    template: string;
    out: string;
    entryPoints: string[];
}

function resolveOutputPath(
    outputs: esbuild.Metafile['outputs'],
    entryName: string,
    outdir: string
): string | null {
    for (const [file, meta] of Object.entries(outputs)) {
        if (
            meta.entryPoint &&
            path.basename(meta.entryPoint).startsWith(entryName)
        ) {
            return '/' + path.relative(outdir, file).replace(/\\/g, '/');
        }
    }
    return null;
}

function injectTags(
    html: string,
    cssHref: string | null,
    jsSrc: string | null
): string {
    let out = html;
    if (cssHref) {
        out = out.replace(
            '</head>',
            `<link rel="stylesheet" href="${cssHref}"></head>`
        );
    }
    if (jsSrc) {
        out = out.replace(
            '</body>',
            `<script src="${jsSrc}" defer></script></body>`
        );
    }
    return out;
}

export function htmlEntryPlugin(
    pages: PageConfig[],
    outdir: string
): esbuild.Plugin {
    return {
        name: 'html-entry',
        setup(build) {
            build.onEnd(async (result) => {
                if (!result.metafile)
                    throw new Error(
                        'metafile must be enabled for html-entry-plugin'
                    );
                const { outputs } = result.metafile;

                await Promise.all(
                    pages.map(async (page) => {
                        const raw = await fs.promises.readFile(
                            page.template,
                            'utf-8'
                        );

                        // resolve each requested entry point to its real hashed filename
                        let cssHref: string | null = null;
                        let jsSrc: string | null = null;
                        for (const entry of page.entryPoints) {
                            const resolved = resolveOutputPath(
                                outputs,
                                entry,
                                outdir
                            );
                            if (!resolved) continue;
                            if (resolved.endsWith('.css')) cssHref = resolved;
                            if (resolved.endsWith('.js')) jsSrc = resolved;
                        }

                        const html = injectTags(raw, cssHref, jsSrc);
                        const outPath = path.join(outdir, page.out);
                        await fs.promises.mkdir(path.dirname(outPath), {
                            recursive: true,
                        });
                        await fs.promises.writeFile(outPath, html);
                    })
                );
            });
        },
    };
}
