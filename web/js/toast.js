const el = () => document.getElementById("toast");
let hideTimer = 0;

export function toast(html) {
  const t = el();
  t.innerHTML = html;
  t.classList.add("show");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => t.classList.remove("show"), 1600);
}

/* click → ip, shift+click → hostname (falls back to ip) */
export function copyHost(ip, name, preferName) {
  const text = preferName ? (name || ip) : ip;
  navigator.clipboard.writeText(text)
    .then(() => toast(`copied <b>${text}</b>`))
    .catch(() => toast("clipboard access failed"));
}
