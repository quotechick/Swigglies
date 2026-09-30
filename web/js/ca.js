// The token's contract address at the top of every page, with a Copy button.
for (const b of document.querySelectorAll('[data-copy]')) {
  b.addEventListener('click', async () => {
    const v = b.dataset.copy;
    try { await navigator.clipboard.writeText(v); }
    catch {
      const t = document.createElement('textarea');
      t.value = v; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.append(t); t.select(); document.execCommand('copy'); t.remove();
    }
    const was = b.textContent;
    b.textContent = 'Copied';
    setTimeout(() => { b.textContent = was; }, 1400);
  });
}
