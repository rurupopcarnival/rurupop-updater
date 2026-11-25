// RuruPop 更新ツール（update.rurupop.com）
// 更新先を選ぶ → ZIPを選ぶ → 確認 → GitHubへ反映 → Cloudflareの自動デプロイ結果を表示
// 入口は Cloudflare Access（るるのGoogleアカウントのみ）。Worker側でもAccessのトークンを検証する。
import { unzipSync } from 'fflate';
import { TARGETS } from './targets.js';
import { UI_HTML } from './ui.js';
import E from './engine.cjs';

const MAX_ZIP = 8 * 1024 * 1024, MAX_FILES = 200, MAX_FILE = 4 * 1024 * 1024;
const enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal: true });
const H = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...H, 'Content-Type': 'application/json; charset=utf-8' } });
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };

/* ---------- Cloudflare Access の検証 ---------- */
let certCache = { at: 0, keys: [] };
const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
async function verifyAccess(request, env) {
  // 手元での動作確認専用（.dev.vars にだけ書く。本番の設定には絶対に入れない）
  if (env.DEV_SKIP_ACCESS === 'true') return { email: 'dev@localhost（確認用）' };
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const [h, p, sig] = token.split('.');
  if (!h || !p || !sig) return null;
  const header = JSON.parse(new TextDecoder().decode(b64url(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64url(p)));
  if (Date.now() - certCache.at > 3600e3) {
    const r = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    certCache = { at: Date.now(), keys: (await r.json()).keys || [] };
  }
  const jwk = certCache.keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(sig), enc.encode(`${h}.${p}`));
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!ok || !aud.includes(env.ACCESS_AUD) || payload.exp * 1000 < Date.now()) return null;
  return { email: payload.email };
}

/* ---------- GitHub ---------- */
function gh(env) {
  const base = env.GITHUB_API || 'https://api.github.com';
  return async (method, path, body) => {
    const r = await fetch(base + path, {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'rurupop-updater', 'Content-Type': 'application/json' },
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`GitHubの操作に失敗しました（${method} ${path.split('?')[0]}：${r.status}）`);
    return t ? JSON.parse(t) : null;
  };
}
async function blobSha(bytes) {
  const head = enc.encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(head.length + bytes.length); all.set(head); all.set(bytes, head.length);
  return hex(await crypto.subtle.digest('SHA-1', all));
}

/* ---------- ZIPの読み取りと確認 ---------- */
const globToRe = (g) => new RegExp('^' + g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');

async function inspect(env, form) {
  const target = TARGETS.find((t) => t.id === form.get('target'));
  if (!target) return { fatal: ['更新先が選ばれていません。'] };
  const file = form.get('zip');
  if (!file || typeof file === 'string') return { fatal: ['ZIPファイルが選ばれていません。'] };
  if (file.size > MAX_ZIP) return { fatal: [`ZIPが大きすぎます（上限 ${MAX_ZIP / 1024 / 1024}MB）。`] };
  const raw = new Uint8Array(await file.arrayBuffer());
  const digest = hex(await crypto.subtle.digest('SHA-256', raw)).slice(0, 16);
  let entries;
  try { entries = unzipSync(raw); } catch { return { fatal: ['ZIPファイルを開けませんでした。壊れているか、ZIP形式ではありません。'] }; }

  // フォルダごと圧縮されたZIP（例：update/update.json）にも対応：update.json のある階層を基準にする
  const names = Object.keys(entries).filter((n) => !n.endsWith('/') && !n.startsWith('__MACOSX/') && !/(^|\/)\.DS_Store$/.test(n));
  const manifestName = names.filter((n) => /(^|\/)update\.json$/.test(n)).sort((a, b) => a.length - b.length)[0];
  if (!manifestName) return { fatal: ['ZIPの中に update.json がありません。更新用のZIPではない可能性があります。'] };
  const root = manifestName.slice(0, -'update.json'.length);
  let manifest;
  try { manifest = JSON.parse(dec.decode(entries[manifestName])); } catch { return { fatal: ['update.json を読み取れませんでした。'] }; }

  const fatal = [], files = [];
  if (manifest.target !== target.id) {
    fatal.push(`このZIPは「${TARGETS.find((t) => t.id === manifest.target)?.name || manifest.target || '（不明）'}」用です。選んだ更新先「${target.name}」とは違います。`);
  }
  const allow = target.allow.map(globToRe);
  const del = Array.isArray(manifest.delete) ? manifest.delete : [];
  for (const n of names) {
    if (n === manifestName || !n.startsWith(root)) continue;
    const path = n.slice(root.length);
    if (path.includes('..') || path.startsWith('/')) { fatal.push(`使えないファイル名です：${path}`); continue; }
    if (!allow.some((re) => re.test(path))) { fatal.push(`このZIPには、更新先で変更できないファイルが入っています：${path}`); continue; }
    if (entries[n].length > MAX_FILE) { fatal.push(`ファイルが大きすぎます：${path}`); continue; }
    files.push({ path, bytes: entries[n] });
  }
  for (const p of del) {
    if (!target.allowDelete) { fatal.push('この更新先ではファイルの削除はできません。'); break; }
    if (typeof p !== 'string' || !allow.some((re) => re.test(p))) fatal.push(`削除できないファイルです：${p}`);
  }
  if (files.length > MAX_FILES) fatal.push(`ファイルが多すぎます（上限 ${MAX_FILES}）。`);
  if (!files.length && !del.length) fatal.push('反映するファイルがありません。');

  // 現在のリポジトリと比べる
  let current = new Map(), headSha = null;
  if (!fatal.length) {
    const api = gh(env);
    const ref = await api('GET', `/repos/${target.repo}/git/ref/heads/${target.branch}`);
    headSha = ref.object.sha;
    const commit = await api('GET', `/repos/${target.repo}/git/commits/${headSha}`);
    const tree = await api('GET', `/repos/${target.repo}/git/trees/${commit.tree.sha}?recursive=1`);
    for (const t of tree.tree || []) if (t.type === 'blob') current.set(t.path, t.sha);
  }
  for (const f of files) {
    const sha = await blobSha(f.bytes);
    f.state = !current.has(f.path) ? '追加' : current.get(f.path) === sha ? '変更なし' : '変更';
  }
  const deletes = del.filter((p) => typeof p === 'string').map((p) => ({ path: p, state: current.has(p) ? '削除' : '（もともとない）' }));

  // 更新先ごとの検証
  const checks = [];
  if (!fatal.length && target.check === 'fates-scenarios') {
    for (const f of files) {
      const id = f.path.split('/').pop().replace(/\.txt$/, '');
      if (!/^_?[a-z0-9-]{1,40}$/.test(id)) { fatal.push(`台本のファイル名は半角英小文字・数字・ハイフンにしてください：${f.path}`); continue; }
      let text; try { text = dec.decode(f.bytes); } catch { fatal.push(`文字コードがUTF-8ではありません：${f.path}`); continue; }
      const sc = E.parse(text);
      const errs = sc.errors.length ? sc.errors.map((e) => `${e.line}行目：${e.msg}`) : E.validate(sc, { limit: 200000 }).errors.map((e) => e.msg);
      if (errs.length) fatal.push(`台本「${f.path}」にエラーがあります：\n・${errs.slice(0, 8).join('\n・')}`);
      else checks.push(`${f.path}：「${sc.meta.title}」SPARK ${sc.rules.S}・FATE ${sc.rules.F}、エラーなし${sc.rules.S !== 7 || sc.rules.F !== 7 ? '（基本の7：7ではありません）' : ''}`);
    }
  }
  return {
    target, digest, headSha, fatal, checks,
    title: String(manifest.title || '').slice(0, 100), from: String(manifest.from || '').slice(0, 40), note: String(manifest.note || '').slice(0, 500),
    files, deletes,
  };
}
const summary = (r) => ({
  target: r.target && { id: r.target.id, name: r.target.name, color: r.target.color, site: r.target.site },
  digest: r.digest, fatal: r.fatal, checks: r.checks || [], title: r.title, from: r.from, note: r.note,
  files: (r.files || []).map((f) => ({ path: f.path, state: f.state, size: f.bytes.length })), deletes: r.deletes || [],
  changes: (r.files || []).filter((f) => f.state !== '変更なし').length + (r.deletes || []).filter((d) => d.state === '削除').length,
});

async function apply(env, form, who) {
  const r = await inspect(env, form);
  if (r.fatal.length) return json({ ok: false, ...summary(r) }, 400);
  if (form.get('digest') !== r.digest) return json({ ok: false, fatal: ['確認したZIPと実行するZIPが違います。もう一度選び直してください。'] }, 400);
  const changed = r.files.filter((f) => f.state !== '変更なし');
  const removed = r.deletes.filter((d) => d.state === '削除');
  if (!changed.length && !removed.length) return json({ ok: false, fatal: ['変更がないため、反映しませんでした。'] }, 400);
  const api = gh(env), repo = r.target.repo;
  const base = await api('GET', `/repos/${repo}/git/commits/${r.headSha}`);
  const tree = [];
  for (const f of changed) {
    const blob = await api('POST', `/repos/${repo}/git/blobs`, { content: b64(f.bytes), encoding: 'base64' });
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  for (const d of removed) tree.push({ path: d.path, mode: '100644', type: 'blob', sha: null });
  const newTree = await api('POST', `/repos/${repo}/git/trees`, { base_tree: base.tree.sha, tree });
  const lines = [...changed.map((f) => `${f.state}：${f.path}`), ...removed.map((d) => `削除：${d.path}`)];
  const message = `${r.title || '更新'}${r.from ? `（${r.from}）` : ''}\n\n${lines.join('\n')}\n\n更新ツールから反映（${who}）`;
  const commit = await api('POST', `/repos/${repo}/git/commits`, { message, tree: newTree.sha, parents: [r.headSha] });
  // 確認中に別の更新が入っていたら失敗させる（force しない）
  await api('PATCH', `/repos/${repo}/git/refs/heads/${r.target.branch}`, { sha: commit.sha, force: false });
  return json({ ok: true, commit: commit.sha, url: `https://github.com/${repo}/commit/${commit.sha}`, at: new Date().toISOString(), ...summary(r) });
}

/* ---------- 状態（最近の更新とデプロイ） ---------- */
async function status(env, targetId) {
  const t = TARGETS.find((x) => x.id === targetId);
  if (!t) return json({ ok: false }, 404);
  const out = { ok: true, commits: [], builds: null };
  try {
    const commits = await gh(env)('GET', `/repos/${t.repo}/commits?sha=${t.branch}&per_page=5`);
    out.commits = commits.map((c) => ({ sha: c.sha.slice(0, 7), full: c.sha, title: c.commit.message.split('\n')[0], at: c.commit.author.date }));
  } catch (e) { out.commitsError = e.message; }
  if (env.CF_API_TOKEN && env.CF_ACCOUNT_ID) {
    try {
      const base = env.CF_API || 'https://api.cloudflare.com/client/v4';
      const hd = { Authorization: `Bearer ${env.CF_API_TOKEN}` };
      const scripts = await (await fetch(`${base}/accounts/${env.CF_ACCOUNT_ID}/workers/scripts`, { headers: hd })).json();
      const tag = (scripts.result || []).find((s) => s.id === t.worker)?.tag;
      if (tag) {
        const b = await (await fetch(`${base}/accounts/${env.CF_ACCOUNT_ID}/builds/workers/${tag}/builds?per_page=5`, { headers: hd })).json();
        out.builds = (b.result || []).map((x) => ({
          status: x.status, outcome: x.build_outcome, at: x.created_on,
          commit: (x.build_trigger_metadata?.commit_hash || '').slice(0, 7),
        }));
      }
    } catch (e) { out.buildsError = 'デプロイ状況を取得できませんでした'; }
  }
  return json(out);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: H });
    const user = await verifyAccess(request, env);
    if (!user) return new Response('ログインが必要です（Cloudflare Access）。', { status: 403, headers: { ...H, 'Content-Type': 'text/plain; charset=utf-8' } });
    if (!env.GITHUB_TOKEN) return json({ ok: false, fatal: ['GitHubの認証情報（GITHUB_TOKEN）が設定されていません。'] }, 500);
    try {
      if (url.pathname === '/' && request.method === 'GET') {
        return new Response(UI_HTML, { headers: { ...H, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" } });
      }
      if (url.pathname === '/api/targets') return json({ targets: TARGETS.map(({ id, name, site, color }) => ({ id, name, site, color })), user: user.email });
      if (url.pathname === '/api/status') return status(env, url.searchParams.get('target'));
      if (request.method === 'POST' && (url.pathname === '/api/preview' || url.pathname === '/api/apply')) {
        const origin = request.headers.get('Origin');
        if (origin && origin !== url.origin) return json({ ok: false, fatal: ['不正な送信元です。'] }, 403);
        const form = await request.formData();
        if (url.pathname === '/api/preview') { const r = await inspect(env, form); return json({ ok: !r.fatal.length, ...summary(r) }); }
        return apply(env, form, user.email);
      }
      return json({ ok: false }, 404);
    } catch (e) {
      return json({ ok: false, fatal: [e.message || '予期しないエラーが起きました。'] }, 502);
    }
  },
};
