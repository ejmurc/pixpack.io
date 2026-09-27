import esbuild from 'esbuild';
import fs from 'fs';
import { minify } from 'html-minifier-terser';
import { htmlEntryPlugin } from './html-entry-plugin';

const OUTDIR = 'dist';
const PORT = 3000;

const MINIFY_OPTIONS = {
    collapseWhitespace: true,
    removeComments: true,
    minifyCSS: true,
    minifyJS: false,
};

const PAGES = [
    {
        template: './src/pages/index.html',
        out: 'index.html',
        entryPoints: ['main', 'styles'],
    },
];

const config: esbuild.BuildOptions = {
    entryPoints: { main: './src/main.ts', styles: './src/styles.css' },
    bundle: true,
    outdir: OUTDIR,
    entryNames: '[name]-[hash]',
    assetNames: '[name]-[hash]',
    metafile: true,
    loader: { '.webp': 'copy', '.woff2': 'file', '.woff': 'file' },
    plugins: [htmlEntryPlugin(PAGES, OUTDIR)],
};

async function minifyOutput() {
    if (process.argv.includes('--serve')) return;
    await Promise.all(
        PAGES.map(async ({ out }) => {
            const p = `${OUTDIR}/${out}`;
            const raw = await fs.promises.readFile(p, 'utf-8');
            await fs.promises.writeFile(p, await minify(raw, MINIFY_OPTIONS));
        })
    );
}

if (process.argv.includes('--serve')) {
    const ctx = await esbuild.context({ ...config, sourcemap: true });
    await ctx.watch();
    await ctx.serve({ servedir: OUTDIR, port: PORT });
    console.log(`Server running at http://localhost:${PORT}`);
} else {
    await fs.promises.rm(OUTDIR, { recursive: true, force: true });
    await esbuild.build({ ...config, minify: true });
    await minifyOutput();
}
