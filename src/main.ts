const STEP_MS = 175;

async function main() {
    const container = document.querySelector('.hero__content');
    const heroH1 = document.getElementById('hero-h1');
    const heroP = document.getElementById('hero-p');
    const heroButtons = document.getElementById('hero-buttons');
    const targets = [heroH1, heroP];
    const originals = targets.map((el) => el.innerHTML);

    const render = (animate) => {
        let index = 1;
        targets.forEach((el, i) => {
            el.innerHTML = originals[i];
            el.removeAttribute('aria-label');
            const lines = splitLines(el);
            if (!animate) return;
            lines.forEach((line) => {
                line.style.animation = `slide-up-clipped 800ms cubic-bezier(0.2, 0.7, 0.2, 1) ${index * STEP_MS}ms backwards`;
                index++;
            });
        });
        heroButtons.style.animation = `slide-up 800ms cubic-bezier(0.2, 0.7, 0.2, 1) ${index++ * STEP_MS}ms both`;
    };

    try {
        await document.fonts.ready;
        render(true);
    } finally {
        targets.forEach((el) => el.classList.add('is-split'));
    }

    let width = container.clientWidth;
    let frame = 0;
    new ResizeObserver(() => {
        if (container.clientWidth === width) return;
        width = container.clientWidth;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => render(false));
    }).observe(container);
}

main();

const MIRRORED_PROPERTIES: readonly string[] = [
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'font-variant',
    'font-stretch',
    'font-kerning',
    'letter-spacing',
    'word-spacing',
    'word-break',
    'text-indent',
    'text-align',
    'text-rendering',
    'line-height',
    'tab-size',
    'direction',
    'writing-mode',
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
];

const EPSILON_PX = 0.5;

interface Position {
    node: Text;
    offset: number;
}

interface Line {
    text: string;
    range: Range;
}

function isInput(element: Element): element is HTMLInputElement {
    return element.localName === 'input';
}

function isTextArea(element: Element): element is HTMLTextAreaElement {
    return element.localName === 'textarea';
}

function isText(node: Node): node is Text {
    return node.nodeType === Node.TEXT_NODE;
}

function* graphemeOffsets(text: string): Generator<[number, number]> {
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
        const segmenter = new Intl.Segmenter(undefined, {
            granularity: 'grapheme',
        });
        for (const { index, segment } of segmenter.segment(text)) {
            yield [index, index + segment.length];
        }
        return;
    }
    let offset = 0;
    for (const codePoint of text) {
        yield [offset, offset + codePoint.length];
        offset += codePoint.length;
    }
}

function firstBox(rects: DOMRectList, vertical: boolean): DOMRect | null {
    for (let i = 0; i < rects.length; i++) {
        const rect = rects.item(i);
        if (rect !== null && (vertical ? rect.height : rect.width) > 0) {
            return rect;
        }
    }
    return null;
}

function measureLines(root: Element): Line[] {
    if (!root.isConnected) return [];

    const doc = root.ownerDocument;
    const view = doc.defaultView;
    if (view === null) return [];

    const style = view.getComputedStyle(root);
    const vertical =
        style.writingMode.startsWith('vertical') ||
        style.writingMode.startsWith('sideways');
    const preservesSpaces =
        style.whiteSpace.startsWith('pre') ||
        style.whiteSpace === 'break-spaces';

    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const probe = doc.createRange();
    const lines: Line[] = [];

    let current = '';
    let start: Position | null = null;
    let end: Position | null = null;
    let hasLine = false;
    let lineStart = 0;
    let lineEnd = 0;

    const flush = (): void => {
        const text = preservesSpaces ? current.trimEnd() : current.trim();
        const first = start;
        const last = end;
        if (text !== '' && first !== null && last !== null) {
            const range = doc.createRange();
            range.setStart(first.node, first.offset);
            range.setEnd(last.node, last.offset);
            lines.push({ text, range });
        }
        current = '';
        start = null;
        end = null;
    };

    for (
        let node = walker.nextNode();
        node !== null;
        node = walker.nextNode()
    ) {
        if (!isText(node)) continue;
        const data = node.data;

        for (const [from, to] of graphemeOffsets(data)) {
            probe.setStart(node, from);
            probe.setEnd(node, to);

            const rect = firstBox(probe.getClientRects(), vertical);
            if (rect === null) continue;

            const near = vertical ? rect.left : rect.top;
            const far = vertical ? rect.right : rect.bottom;
            const mid = (near + far) / 2;

            if (!hasLine) {
                hasLine = true;
                lineStart = near;
                lineEnd = far;
            } else if (
                mid < lineStart - EPSILON_PX ||
                mid > lineEnd + EPSILON_PX
            ) {
                flush();
                lineStart = near;
                lineEnd = far;
            } else {
                lineStart = Math.min(lineStart, near);
                lineEnd = Math.max(lineEnd, far);
            }

            const grapheme = data.slice(from, to);
            const blank = /^\s+$/.test(grapheme);
            current += grapheme;
            if (start === null && (preservesSpaces || !blank)) {
                start = { node, offset: from };
            }
            if (!blank) {
                end = { node, offset: to };
            }
        }
    }

    if (hasLine) flush();
    return lines;
}

function measureTextArea(textarea: HTMLTextAreaElement): Line[] {
    const doc = textarea.ownerDocument;
    const view = doc.defaultView;
    if (view === null || !textarea.isConnected || doc.body === null) return [];

    const computed = view.getComputedStyle(textarea);
    const mirror = doc.createElement('div');

    for (const property of MIRRORED_PROPERTIES) {
        mirror.style.setProperty(property, computed.getPropertyValue(property));
    }

    mirror.style.position = 'absolute';
    mirror.style.top = '0';
    mirror.style.left = '-99999px';
    mirror.style.visibility = 'hidden';
    mirror.style.boxSizing = 'border-box';
    mirror.style.border = '0';
    mirror.style.overflow = 'hidden';
    mirror.style.height = 'auto';
    mirror.style.width = `${textarea.clientWidth}px`;
    mirror.style.whiteSpace = textarea.wrap === 'off' ? 'pre' : 'pre-wrap';
    mirror.style.overflowWrap = 'break-word';
    mirror.textContent = textarea.value;

    doc.body.appendChild(mirror);
    try {
        return measureLines(mirror);
    } finally {
        mirror.remove();
    }
}

export function splitLines(element: HTMLElement): HTMLElement[] {
    const doc = element.ownerDocument;
    const measured = measureLines(element);
    if (measured.length === 0) return [];

    const label = (element.textContent ?? '').replace(/\s+/g, ' ').trim();

    const lines = measured.map((line) => {
        const fragment = line.range.cloneContents();
        fragment
            .querySelectorAll('[id]')
            .forEach((el) => el.removeAttribute('id'));

        const span = doc.createElement('span');
        span.className = 'line';
        span.style.display = 'block';
        span.style.whiteSpace = 'nowrap';
        span.setAttribute('aria-hidden', 'true');
        span.appendChild(fragment);
        return span;
    });

    element.setAttribute('aria-label', label);
    element.replaceChildren(...lines);
    return lines;
}
