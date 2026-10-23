/** Full-screen photo viewer: arrow keys, swipe, Escape, focus is returned on close. */
export class Lightbox {
  private items: HTMLButtonElement[] = [];
  private index = 0;
  private opener: HTMLElement | null = null;
  private img: HTMLImageElement;
  private touchX = 0;
  private touchY = 0;

  constructor(private el: HTMLElement) {
    this.img = el.querySelector('[data-lb-img]')!;
    el.querySelector('[data-lb-close]')!.addEventListener('click', () => this.close());
    el.querySelector('[data-lb-prev]')!.addEventListener('click', () => this.go(-1));
    el.querySelector('[data-lb-next]')!.addEventListener('click', () => this.go(1));
    el.querySelector('[data-lb-stage]')!.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.close();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); }
      else if (e.key === 'ArrowRight') this.go(1);
      else if (e.key === 'ArrowLeft') this.go(-1);
      else if (e.key === 'Tab') this.trap(e);
    });
    el.addEventListener('touchstart', (e) => {
      this.touchX = e.touches[0].clientX;
      this.touchY = e.touches[0].clientY;
    }, { passive: true });
    el.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - this.touchX;
      const dy = e.changedTouches[0].clientY - this.touchY;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) this.go(dx < 0 ? 1 : -1);
    });
    this.img.addEventListener('load', () => this.el.classList.remove('is-loading'));
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open(items: HTMLButtonElement[], index: number) {
    this.items = items;
    this.opener = items[index];
    this.el.hidden = false;
    document.documentElement.classList.add('lb-open');
    requestAnimationFrame(() => this.el.classList.add('is-open'));
    this.show(index);
    (this.el.querySelector('[data-lb-close]') as HTMLElement).focus({ preventScroll: true });
  }

  close() {
    if (!this.isOpen) return;
    this.el.classList.remove('is-open');
    document.documentElement.classList.remove('lb-open');
    const done = () => {
      this.el.hidden = true;
      this.img.removeAttribute('srcset');
      this.img.removeAttribute('src');
    };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) done();
    else setTimeout(done, 260);
    this.opener?.focus({ preventScroll: true });
  }

  private go(d: number) {
    if (!this.items.length) return;
    this.show((this.index + d + this.items.length) % this.items.length);
  }

  private show(i: number) {
    this.index = i;
    const b = this.items[i];
    const d = b.dataset;
    const thumb = b.querySelector('img');
    this.el.classList.add('is-loading');
    this.el.style.setProperty('--lb-ar', String(Number(d.w) / Number(d.h)));
    this.img.removeAttribute('srcset');
    if (thumb?.currentSrc) this.img.src = thumb.currentSrc;
    this.img.srcset = d.srcset ?? '';
    this.img.alt = thumb?.alt ?? '';
    this.img.width = Number(d.w);
    this.img.height = Number(d.h);
    const set = (sel: string, text: string) => {
      const n = this.el.querySelector(sel) as HTMLElement;
      n.textContent = text;
      n.hidden = !text;
    };
    set('[data-lb-title]', d.title ?? '');
    set('[data-lb-caption]', d.caption ?? '');
    set('[data-lb-exif]', [d.date, d.camera, d.lens, d.settings].filter(Boolean).join('   ·   '));
    set('[data-lb-count]', `${i + 1} / ${this.items.length}`);
    // Warm the neighbours
    for (const n of [i + 1, i - 1]) {
      const nb = this.items[(n + this.items.length) % this.items.length];
      if (nb) {
        const pre = new Image();
        pre.sizes = '100vw';
        pre.srcset = nb.dataset.srcset ?? '';
      }
    }
  }

  private trap(e: KeyboardEvent) {
    const f = [...this.el.querySelectorAll<HTMLElement>('button')].filter((b) => !b.hidden);
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
}
