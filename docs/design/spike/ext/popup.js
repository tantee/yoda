const out = (s) => (document.getElementById('out').textContent += s + '\n')
document.getElementById('now').onclick = () => { chrome.permissions.request({ origins: ['https://example.org/*'] }).then((g) => out('now:' + g), (e) => out('now-err:' + e.message)) }
document.getElementById('after').onclick = async () => { await new Promise((r) => setTimeout(r, 50)); chrome.permissions.request({ origins: ['https://example.net/*'] }).then((g) => out('after:' + g), (e) => out('after-err:' + e.message)) }
window.upload = async (url, mb) => { const t0 = Date.now(); const fd = new FormData(); fd.append('f', new Blob([new Uint8Array(mb * 1024 * 1024)]), 'x.bin'); const r = await fetch(url, { method: 'POST', body: fd }); return { status: r.status, ms: Date.now() - t0 } }
