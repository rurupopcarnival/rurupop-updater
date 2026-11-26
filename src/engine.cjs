// 5F5S 試作エンジン v0.1（台本記法の解析・検証・進行）
// ブラウザとNode両方で動く。UIには依存しない。
(function (root) {
  'use strict';

  const ARROW = /\s*(?:→|->)\s*/;
  const Z2H = (s) => s.replace(/[０-９＝＜＞！＋－]/g, (c) => ({ '＝': '=', '＜': '<', '＞': '>', '！': '!', '＋': '+', '－': '-' }[c] || String.fromCharCode(c.charCodeAt(0) - 0xFEE0)));

  // ---------- 解析 ----------
  function parse(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const sc = { meta: { title: '無題', genre: '' }, rules: { S: 5, F: 5 }, statuses: {}, statusOrder: [], scenes: {}, order: [], errors: [], warnings: [] };
    let cur = null, pageBuf = [], mode = null; // mode: spark|fate|branch
    const err = (ln, m) => sc.errors.push({ line: ln, msg: m });

    function flush() {
      if (cur && pageBuf.length) { cur.items.push({ type: 'page', text: pageBuf.join('\n'), line: pageBuf.line }); }
      pageBuf = [];
    }
    function parseEffects(str, ln) {
      const out = [];
      const m = str.match(/\[([^\]]*)\]\s*$/);
      if (!m) return { rest: str.trim(), effects: out };
      for (const part of m[1].split(/[,、\s]+/).filter(Boolean)) {
        const e = Z2H(part).match(/^(.+?)([+\-=])(出目|-?\d+)$/);
        if (!e) { err(ln, `効果「${part}」が読めません（例：[証拠+1] [HP-出目] [鍵=1]）`); continue; }
        out.push({ name: e[1], op: e[2], value: e[3] === '出目' ? 'DICE' : parseInt(e[3], 10), line: ln });
      }
      return { rest: str.slice(0, m.index).trim(), effects: out };
    }
    function splitArrow(str, ln) {
      const parts = str.split(ARROW);
      if (parts.length !== 2 || !parts[1].trim()) { err(ln, '「→ 行き先」が見つかりません'); return null; }
      const { rest, effects } = parseEffects(parts[1], ln);
      return { left: parts[0].trim(), target: rest, effects };
    }

    lines.forEach((raw, i) => {
      const ln = i + 1;
      const line = raw.trim();
      if (line.startsWith('//')) return;
      if (!cur) {
        if (!line) return;
        if (line.startsWith('@')) {
          const [cmd, ...restArr] = line.slice(1).split(/\s+/);
          const rest = restArr.join(' ');
          if (cmd === 'タイトル') sc.meta.title = rest;
          else if (cmd === 'ジャンル') sc.meta.genre = rest;
          else if (cmd === 'クレジット') sc.meta.credit = rest;
          else if (cmd === '回数') {
            const m = Z2H(rest).match(/SPARK\s*(\d+).*FATE\s*(\d+)/i);
            if (m) { sc.rules.S = +m[1]; sc.rules.F = +m[2]; } else err(ln, '@回数 は「SPARK 3 FATE 3」の形で書いてください');
          } else if (cmd === 'ステータス') {
            const name = restArr[0];
            if (!name) { err(ln, 'ステータス名がありません'); return; }
            const st = { name, init: 0, min: null, max: null, visible: true, line: ln };
            for (const opt of restArr.slice(1)) {
              const o = Z2H(opt);
              let m;
              if ((m = o.match(/^初期=(-?\d+)$/))) st.init = +m[1];
              else if ((m = o.match(/^下限=(-?\d+)$/))) st.min = +m[1];
              else if ((m = o.match(/^上限=(-?\d+)$/))) st.max = +m[1];
              else if (o === '非表示') st.visible = false;
              else if (o === '表示') st.visible = true;
              else err(ln, `ステータスの設定「${opt}」が読めません`);
            }
            if (sc.statuses[name]) err(ln, `ステータス「${name}」が二重に定義されています`);
            sc.statuses[name] = st; sc.statusOrder.push(name);
          } else err(ln, `「@${cmd}」は知らない設定です`);
          return;
        }
        if (!line.startsWith('#')) { err(ln, '最初の場面（# 場面名）より前に本文があります'); return; }
      }
      if (line.startsWith('#')) {
        flush();
        if (cur && !cur.next) err(cur.line, `場面「${cur.name}」の最後に行き先（→ / ? / !）がありません`);
        const name = line.replace(/^#+/, '').trim();
        if (!name) { err(ln, '場面名がありません'); return; }
        if (sc.scenes[name]) err(ln, `場面名「${name}」が二重に使われています`);
        cur = { name, line: ln, items: [], next: null };
        sc.scenes[name] = cur; sc.order.push(name); mode = null;
        return;
      }
      if (!line) { flush(); return; }
      if (cur.next && cur.next.type === 'end') { err(ln, '! END の後に行があります'); return; }

      // 判定画面に表示する説明（v0.2）：? SPARK / ? FATE の直後の「> 文」
      if ((mode === 'spark' || mode === 'fate') && (line.startsWith('>') || line.startsWith('＞'))) {
        cur.next.desc.push(line.slice(1).trim());
        return;
      }
      // 選択肢・出目・分岐の行
      if (mode && (line.startsWith('-') || /^[0-9０-９]/.test(line))) {
        const nx = cur.next;
        if (mode === 'spark' && line.startsWith('-')) {
          const a = splitArrow(line.slice(1), ln); if (!a) return;
          const [label, ...hint] = a.left.split(/[｜|]/);
          nx.choices.push({ label: label.trim(), hint: hint.join('｜').trim(), target: a.target, effects: a.effects, line: ln });
          return;
        }
        if (mode === 'fate' && /^[0-9０-９]/.test(line)) {
          const a = splitArrow(line, ln); if (!a) return;
          const [rng, ...lab] = a.left.split(/[｜|]/);
          const m = Z2H(rng.trim()).match(/^(\d)(?:\s*[-~〜～]\s*(\d))?$/);
          if (!m) { err(ln, `出目「${a.left}」が読めません（例：1-3、9）`); return; }
          const lo = +m[1], hi = m[2] ? +m[2] : lo;
          if (lo < 1 || hi > 9 || lo > hi) { err(ln, '出目は1〜9の範囲で書いてください'); return; }
          nx.bands.push({ lo, hi, label: lab.join('｜').trim(), target: a.target, effects: a.effects, line: ln });
          return;
        }
        if (mode === 'branch' && line.startsWith('-')) {
          const a = splitArrow(line.slice(1), ln); if (!a) return;
          const l = a.left.trim();
          if (l === 'それ以外') nx.rules.push({ cond: null, target: a.target, effects: a.effects, line: ln });
          else if (l.startsWith('もし')) {
            const cond = parseCond(l.slice(2).trim(), ln, err);
            if (cond) nx.rules.push({ cond, target: a.target, effects: a.effects, line: ln });
          } else err(ln, '分岐の行は「- もし 条件 → 行き先」か「- それ以外 → 行き先」で書いてください');
          return;
        }
      }
      if (cur.next) { err(ln, `場面「${cur.name}」は行き先の指定のあとに本文が続いています。新しい場面（# 名前）を作ってください`); return; }

      if (line.startsWith('→') || line.startsWith('->')) {
        flush();
        const { rest, effects } = parseEffects(line.replace(/^(→|->)/, ''), ln);
        cur.next = { type: 'goto', target: rest, effects, line: ln }; mode = null; return;
      }
      if (line.startsWith('?') || line.startsWith('？')) {
        flush();
        const body = line.slice(1).trim();
        const m = body.match(/^(SPARK|FATE|分岐)\s*(.*)$/i);
        if (!m) { err(ln, '「? SPARK 見出し」「? FATE 見出し」「? 分岐」のどれかで書いてください'); return; }
        const kind = m[1].toUpperCase();
        const [ttl, ...d0] = (m[2] || '').split(/[｜|]/);
        const desc = d0.length ? [d0.join('｜').trim()] : [];
        if (kind === 'SPARK') { cur.next = { type: 'spark', title: ttl.trim() || cur.name, desc, choices: [], line: ln }; mode = 'spark'; }
        else if (kind === 'FATE') { cur.next = { type: 'fate', title: ttl.trim() || cur.name, desc, bands: [], line: ln }; mode = 'fate'; }
        else { cur.next = { type: 'branch', rules: [], line: ln }; mode = 'branch'; }
        return;
      }
      if (line.startsWith('!') || line.startsWith('！')) {
        flush();
        const m = line.slice(1).trim().match(/^END\s*(.*)$/i);
        if (!m) { err(ln, '「! END 結末名」で書いてください'); return; }
        cur.next = { type: 'end', title: m[1] || cur.name, line: ln }; mode = null; return;
      }
      if (line.startsWith('@')) {
        flush();
        const [cmd, name] = line.slice(1).split(/\s+/);
        if (cmd === '表示' || cmd === '非表示') cur.items.push({ type: cmd === '表示' ? 'show' : 'hide', name, line: ln });
        else err(ln, `場面の中の「@${cmd}」は使えません（@表示 / @非表示 のみ）`);
        return;
      }
      if (/^\[[^\]]*\]$/.test(line)) {
        flush();
        const { effects } = parseEffects(line, ln);
        cur.items.push({ type: 'effect', effects, line: ln }); return;
      }
      if (!pageBuf.length) pageBuf.line = ln;
      pageBuf.push(raw.trim());
    });
    flush();
    if (cur && !cur.next) err(cur.line, `場面「${cur.name}」の最後に行き先（→ / ? / !）がありません`);
    if (!sc.order.length) err(1, '場面が1つもありません（# 場面名 で始めてください）');
    sc.start = sc.order[0];
    // 結末番号：台本に書かれた順に、結末名ごとに 1, 2, 3… と固定で割り振る（同じ結末名は同じ番号）
    sc.endings = [];
    for (const n of sc.order) { const nx = sc.scenes[n].next; if (nx && nx.type === 'end' && !sc.endings.includes(nx.title)) sc.endings.push(nx.title); }
    checkStatic(sc);
    return sc;
  }

  // 条件式：A かつ B / A または B（かつ が優先）。項は 左 比較 右
  function parseCond(str, ln, err) {
    const ors = Z2H(str).split(/\s*または\s*/);
    const tree = { or: [] };
    for (const o of ors) {
      const ands = [];
      for (const a of o.split(/\s*かつ\s*/)) {
        const m = a.trim().match(/^(.+?)\s*(>=|<=|==|!=|=|>|<)\s*(.+)$/);
        if (!m) { err(ln, `条件「${a}」が読めません（例：証拠>=3、選択(判決)==1）`); return null; }
        ands.push({ l: parseTerm(m[1]), op: m[2] === '=' ? '==' : m[2], r: parseTerm(m[3]) });
      }
      tree.or.push(ands);
    }
    return tree;
  }
  function parseTerm(t) {
    t = t.trim();
    let m;
    if (/^-?\d+$/.test(t)) return { k: 'num', v: +t };
    if ((m = t.match(/^選択\((.+)\)$/))) return { k: 'choice', v: m[1].trim() };
    if ((m = t.match(/^出目\((.+)\)$/))) return { k: 'dice', v: m[1].trim() };
    return { k: 'status', v: t };
  }

  function forEachRef(sc, fn) {
    // 条件・効果・差分テキストの参照を列挙
    for (const name of sc.order) {
      const s = sc.scenes[name];
      const effs = [];
      for (const it of s.items) {
        if (it.type === 'effect') effs.push(...it.effects);
        if (it.type === 'show' || it.type === 'hide') fn({ k: 'status', v: it.name }, it.line, s);
        if (it.type === 'page') for (const r of textRefs(it.text)) fn(r, it.line, s);
      }
      const nx = s.next; if (!nx) continue;
      for (const t of [...(nx.desc || []), ...(nx.choices || []).map((c) => c.hint || ''), ...(nx.bands || []).map((b) => b.label || '')])
        for (const r of textRefs(t)) fn(r, nx.line, s);
      if (nx.effects) effs.push(...nx.effects);
      (nx.choices || []).forEach((c) => effs.push(...c.effects));
      (nx.bands || []).forEach((b) => effs.push(...b.effects));
      (nx.rules || []).forEach((r) => { effs.push(...r.effects); if (r.cond) r.cond.or.flat().forEach((a) => { fn(a.l, r.line, s); fn(a.r, r.line, s); }); });
      effs.forEach((e) => fn({ k: 'status', v: e.name, effect: e }, e.line, s));
    }
  }
  function textRefs(text) {
    const out = [];
    const re = /\{もし\s+([^}]+)\}/g; let m;
    while ((m = re.exec(text))) { const c = parseCond(m[1], 0, () => {}); if (c) c.or.flat().forEach((a) => out.push(a.l, a.r)); }
    const re2 = /\{(?!もし|でなければ|\/もし)([^}]+)\}/g;
    while ((m = re2.exec(text))) out.push(parseTerm(m[1]));
    return out;
  }

  function checkStatic(sc) {
    const err = (ln, m) => sc.errors.push({ line: ln, msg: m });
    sc.refChoice = new Set(); sc.refDice = new Set();
    // 選択()・出目() は場面名でも SPARK/FATE の見出しでも参照できる
    sc.alias = {};
    const titleCount = {};
    for (const n of sc.order) { const nx = sc.scenes[n].next; if (nx && nx.title && (nx.type === 'spark' || nx.type === 'fate')) titleCount[nx.title] = (titleCount[nx.title] || 0) + 1; }
    for (const n of sc.order) { const nx = sc.scenes[n].next; if (nx && nx.title && titleCount[nx.title] === 1 && !sc.scenes[nx.title]) sc.alias[nx.title] = n; }
    for (const name of sc.order) {
      const s = sc.scenes[name], nx = s.next; if (!nx) continue;
      const tgt = (t, ln) => { if (!sc.scenes[t]) err(ln, `行き先「${t}」という場面がありません`); };
      if (nx.type === 'goto') tgt(nx.target, nx.line);
      if (nx.type === 'spark') {
        if (!nx.choices.length) err(nx.line, `SPARK「${nx.title}」に選択肢がありません（- 選択肢 → 行き先）`);
        nx.choices.forEach((c) => tgt(c.target, c.line));
      }
      if (nx.type === 'fate') {
        const cover = Array(10).fill(0);
        nx.bands.forEach((b) => { tgt(b.target, b.line); for (let v = b.lo; v <= b.hi; v++) cover[v]++; });
        const miss = [], dup = [];
        for (let v = 1; v <= 9; v++) { if (!cover[v]) miss.push(v); if (cover[v] > 1) dup.push(v); }
        if (miss.length) err(nx.line, `FATE「${nx.title}」で出目 ${miss.join('・')} の行き先がありません`);
        if (dup.length) err(nx.line, `FATE「${nx.title}」で出目 ${dup.join('・')} が重複しています`);
      }
      if (nx.type === 'branch') {
        nx.rules.forEach((r) => tgt(r.target, r.line));
        const last = nx.rules[nx.rules.length - 1];
        if (!last || last.cond) err(nx.line, '分岐の最後には「- それ以外 → 行き先」が必要です');
      }
    }
    forEachRef(sc, (t, ln) => {
      if (t.k === 'status' && !sc.statuses[t.v]) err(ln, `ステータス「${t.v}」が定義されていません（@ステータス ${t.v} 初期=0）`);
      if (t.k === 'choice' || t.k === 'dice') t.v = sc.alias[t.v] || t.v;
      if (t.k === 'choice') {
        const s = sc.scenes[t.v];
        if (!s || !s.next || s.next.type !== 'spark') err(ln, `選択(${t.v})：SPARKのある場面「${t.v}」が見つかりません`);
        sc.refChoice.add(t.v);
      }
      if (t.k === 'dice') {
        const s = sc.scenes[t.v];
        if (!s || !s.next || s.next.type !== 'fate') err(ln, `出目(${t.v})：FATEのある場面「${t.v}」が見つかりません`);
        sc.refDice.add(t.v);
      }
    });
  }

  // ---------- 状態と進行 ----------
  function newState(sc) {
    const st = {}, vis = {};
    for (const n of sc.statusOrder) { st[n] = sc.statuses[n].init; vis[n] = sc.statuses[n].visible; }
    return { scene: sc.start, idx: 0, s: 0, f: 0, st, vis, choice: {}, dice: {}, log: [], ended: null, sparkOrder: [], fateOrder: [] };
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  // 検証用の軽量コピー（ログ類は持ち回らない）
  function fastClone(o) {
    return { scene: o.scene, idx: o.idx, s: o.s, f: o.f, st: { ...o.st }, vis: { ...o.vis }, choice: { ...o.choice }, dice: { ...o.dice }, log: [], ended: o.ended, sparkOrder: [], fateOrder: [] };
  }

  function termVal(sc, state, t) {
    if (t.k === 'num') return t.v;
    if (t.k === 'status') return state.st[t.v] ?? 0;
    if (t.k === 'choice') return state.choice[sc.alias[t.v] || t.v] ?? 0;
    if (t.k === 'dice') return state.dice[sc.alias[t.v] || t.v] ?? 0;
    return 0;
  }
  function evalCond(sc, state, cond) {
    return cond.or.some((ands) => ands.every((a) => {
      const l = termVal(sc, state, a.l), r = termVal(sc, state, a.r);
      switch (a.op) { case '>=': return l >= r; case '<=': return l <= r; case '>': return l > r; case '<': return l < r; case '!=': return l !== r; default: return l === r; }
    }));
  }
  function applyEffects(sc, state, effects, dice, warn) {
    for (const e of effects) {
      const def = sc.statuses[e.name]; if (!def) continue;
      const v = e.value === 'DICE' ? (dice ?? 0) : e.value;
      let x = e.op === '+' ? state.st[e.name] + v : e.op === '-' ? state.st[e.name] - v : v;
      if (def.min != null && x < def.min) { if (warn) warn(e, 'min'); x = def.min; }
      if (def.max != null && x > def.max) { if (warn) warn(e, 'max'); x = def.max; }
      state.st[e.name] = x;
    }
  }
  function renderText(sc, state, text) {
    let out = text.replace(/\{もし\s+([^}]+)\}([\s\S]*?)(?:\{でなければ\}([\s\S]*?))?\{\/もし\}/g, (_, c, a, b) => {
      const cond = parseCond(c, 0, () => {});
      return cond && evalCond(sc, state, cond) ? a : (b || '');
    });
    out = out.replace(/\{([^}]+)\}/g, (_, t) => String(termVal(sc, state, parseTerm(t))));
    return out.replace(/^\n+|\n+$/g, '');
  }

  // 次の「決定」（SPARK・FATE・END）まで進める。pages を集めて返す
  function advance(sc, state, warn, quiet) {
    const pages = [], snaps = [];
    let guard = 0;
    while (true) {
      if (++guard > 2000) return { type: 'loop', pages, snaps };
      const s = sc.scenes[state.scene];
      while (state.idx < s.items.length) {
        const it = s.items[state.idx++];
        if (it.type === 'page') { if (quiet) continue; const t = renderText(sc, state, it.text); if (t.trim()) { pages.push(t); snaps.push({ st: { ...state.st }, vis: { ...state.vis } }); } }
        else if (it.type === 'show') state.vis[it.name] = true;
        else if (it.type === 'hide') state.vis[it.name] = false;
        else if (it.type === 'effect') applyEffects(sc, state, it.effects, null, warn);
      }
      const nx = s.next;
      if (nx.type === 'goto') { applyEffects(sc, state, nx.effects, null, warn); go(state, nx.target); continue; }
      if (nx.type === 'branch') {
        const r = nx.rules.find((r) => !r.cond || evalCond(sc, state, r.cond));
        applyEffects(sc, state, r.effects, null, warn); go(state, r.target); continue;
      }
      if (nx.type === 'end') { state.ended = nx.title; return { type: 'end', title: nx.title, no: sc.endings.indexOf(nx.title) + 1, total: sc.endings.length, pages, snaps }; }
      return { type: nx.type, node: nx, scene: s.name, pages, snaps };
    }
  }
  function go(state, target) { state.scene = target; state.idx = 0; if (state.trail) state.trail.push(target); }

  function chooseSpark(sc, state, i, warn) {
    const nx = sc.scenes[state.scene].next, c = nx.choices[i];
    state.choice[state.scene] = i + 1; state.s++; state.sparkOrder.push(state.scene);
    applyEffects(sc, state, c.effects, null, warn); go(state, c.target);
    return c;
  }
  function confirmFate(sc, state, v, warn) {
    const nx = sc.scenes[state.scene].next, b = nx.bands.find((b) => v >= b.lo && v <= b.hi);
    state.dice[state.scene] = v; state.f++; state.fateOrder.push(state.scene);
    applyEffects(sc, state, b.effects, v, warn); go(state, b.target);
    return b;
  }

  // ---------- 全ルート検証 ----------
  // 進行に影響する履歴だけを状態に含める（差分テキストだけで参照される履歴は進行に影響しない）。
  // さらに、選択番号・出目は「分岐条件の結果が同じになる値」どうしを同じものとして扱う（例：<=3 なら 1〜3 と 4〜9）。
  function flowClasses(sc) {
    const atoms = {}; // 'c:場面' / 'd:場面' → [{op, n}] or 'exact'
    const termKey = (t) => (t.k === 'choice' || t.k === 'dice') ? `${t.k === 'choice' ? 'c' : 'd'}:${sc.alias[t.v] || t.v}` : null;
    for (const name of sc.order) {
      const nx = sc.scenes[name].next;
      if (!nx || nx.type !== 'branch') continue;
      for (const r of nx.rules) if (r.cond) for (const a of r.cond.or.flat()) {
        const kl = termKey(a.l), kr = termKey(a.r);
        if (kl && a.r.k === 'num') (atoms[kl] = atoms[kl] === 'exact' ? 'exact' : (atoms[kl] || [])).push?.({ op: a.op, n: a.r.v });
        else if (kr && a.l.k === 'num') (atoms[kr] = atoms[kr] === 'exact' ? 'exact' : (atoms[kr] || [])).push?.({ op: flip(a.op), n: a.l.v });
        else { if (kl) atoms[kl] = 'exact'; if (kr) atoms[kr] = 'exact'; }
      }
    }
    return atoms;
  }
  // 分岐条件で参照されるステータス（それ以外は進行に影響しない）
  function flowStats(sc) {
    const set = new Set();
    for (const name of sc.order) {
      const nx = sc.scenes[name].next;
      if (!nx || nx.type !== 'branch') continue;
      for (const r of nx.rules) if (r.cond) for (const a of r.cond.or.flat()) for (const t of [a.l, a.r]) if (t.k === 'status') set.add(t.v);
    }
    return set;
  }
  // 場面ごとに「この先の分岐条件で読まれうる」ステータス・履歴（生存解析）
  function liveSets(sc) {
    const own = {}, succ = {}, live = {};
    const hk = (t) => (t.k === 'choice' || t.k === 'dice') ? `${t.k === 'choice' ? 'c' : 'd'}:${sc.alias[t.v] || t.v}` : null;
    for (const name of sc.order) {
      const nx = sc.scenes[name].next, o = new Set(), su = new Set();
      if (nx) {
        if (nx.target) su.add(nx.target);
        for (const r of nx.rules || []) { su.add(r.target); if (r.cond) for (const a of r.cond.or.flat()) for (const t of [a.l, a.r]) { if (t.k === 'status') o.add('s:' + t.v); const h = hk(t); if (h) o.add(h); } }
        for (const c of nx.choices || []) su.add(c.target);
        for (const b of nx.bands || []) su.add(b.target);
      }
      own[name] = o; succ[name] = [...su].filter((x) => sc.scenes[x]); live[name] = new Set(o);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const name of sc.order) for (const x of succ[name]) for (const v of live[x]) if (!live[name].has(v)) { live[name].add(v); changed = true; }
    }
    return live;
  }
  function stKey(st, rel) { const o = {}; for (const k in st) if (rel.has(k)) o[k] = st[k]; return JSON.stringify(o); }
  function flip(op) { return { '>=': '<=', '<=': '>=', '>': '<', '<': '>' }[op] || op; }
  function cmp(l, op, r) { switch (op) { case '>=': return l >= r; case '<=': return l <= r; case '>': return l > r; case '<': return l < r; case '!=': return l !== r; default: return l === r; } }
  function historyKey(sc, atoms, state, lv) {
    const parts = [];
    for (const k in atoms) {
      if (lv && !lv.has(k)) { parts.push('-'); continue; }
      const [t, scene] = [k[0], k.slice(2)];
      const v = (t === 'c' ? state.choice[scene] : state.dice[scene]) || 0;
      parts.push(atoms[k] === 'exact' ? v : atoms[k].map((a) => (cmp(v, a.op, a.n) ? 1 : 0)).join(''));
    }
    return parts.join(',');
  }
  function validate(sc, opts = {}) {
    const R = { errors: [], warnings: [], info: [], arrivals: {}, endings: {}, routes: 0, reachable: new Set(), normalReachable: new Set(), statesVisited: 0, aborted: false };
    if (sc.errors.length) return R;
    const limit = opts.limit || 300000;
    const sample = new Map(); // メッセージ → 例のルート
    const addErr = (key, msg, path) => { if (!sample.has(key)) { sample.set(key, 1); R.errors.push({ msg, path: path.slice() }); } };
    const addWarn = (key, msg) => { if (!sample.has('w' + key)) { sample.set('w' + key, 1); R.warnings.push({ msg }); } };
    const boundWarn = (e, kind) => addWarn(`b${e.line}${kind}`, `${e.line}行目：ステータス「${e.name}」が${kind === 'min' ? '下限' : '上限'}を超える可能性があります（自動で範囲内に調整されます）`);
    const memo = new Map();

    const atoms = flowClasses(sc), live = liveSets(sc), relOf = {};
    for (const n of sc.order) relOf[n] = new Set([...live[n]].filter((x) => x.startsWith('s:')).map((x) => x.slice(2)));
    function key(state, normalOK) {
      return `${state.scene}|${state.idx}|${state.s}|${state.f}|${stKey(state.st, relOf[state.scene])}|${historyKey(sc, atoms, state, live[state.scene])}|${normalOK ? 1 : 0}`;
    }
    // 進行に影響しないステータスは状態キーから外す。範囲超過の警告を取りこぼさないよう、
    // 同じ状態でも「これまでより小さい／大きい値」で来た場合だけ再探索する（効果は単調なので最小・最大で十分）。
    function within(m, st, scene) {
      const rel = relOf[scene];
      let ok = true;
      for (const k in st) if (!rel.has(k)) {
        if (!(k in m.lo) || st[k] < m.lo[k]) { m.lo[k] = st[k]; ok = false; }
        if (!(k in m.hi) || st[k] > m.hi[k]) { m.hi[k] = st[k]; ok = false; }
      }
      return ok;
    }
    // 戻り値：{ ending名: ルート数 }
    function explore(state, path, normalOK) {
      if (R.aborted) return {};
      state.trail = [state.scene];
      const r = advance(sc, state, boundWarn, true);
      for (const t of state.trail) {
        R.reachable.add(t); if (normalOK) R.normalReachable.add(t);
        (R.arrivals[t] ||= new Set()).add(`S${state.s}/F${state.f}`);
      }
      delete state.trail;
      const k = key(state, normalOK);
      let m = memo.get(k);
      if (m) { if (within(m, state.st, state.scene)) return m.res; }
      else { m = { res: null, lo: {}, hi: {} }; within(m, state.st, state.scene); memo.set(k, m); }
      if (++R.statesVisited > limit) { R.aborted = true; return {}; }
      const here = state.scene;
      let res = {};
      if (r.type === 'loop') { addErr('loop' + here, `場面「${here}」付近で、SPARK・FATEを消費しない無限ループがあります`, path); }
      else if (r.type === 'end') {
        if (state.s !== sc.rules.S || state.f !== sc.rules.F) {
          addErr(`cnt${here}${state.s}${state.f}`, `結末「${r.title}」に、SPARK ${state.s}/${sc.rules.S}・FATE ${state.f}/${sc.rules.F} で到達するルートがあります（規定回数をちょうど使い切る必要があります）`, path);
        }
        res = { [r.title]: 1 };
      } else if (r.type === 'spark') {
        if (state.s >= sc.rules.S) { addErr(`ovS${here}`, `場面「${here}」で ${state.s + 1} 回目のSPARKが発生するルートがあります（規定 ${sc.rules.S} 回）`, path); }
        else r.node.choices.forEach((c, i) => {
          const ns = fastClone(state); chooseSpark(sc, ns, i, boundWarn);
          path.push(`${here}:${i + 1}`); merge(res, explore(ns, path, normalOK)); path.pop();
        });
      } else if (r.type === 'fate') {
        if (state.f >= sc.rules.F) { addErr(`ovF${here}`, `場面「${here}」で ${state.f + 1} 回目のFATEが発生するルートがあります（規定 ${sc.rules.F} 回）`, path); }
        else for (let v = 1; v <= 9; v++) {
          const ns = fastClone(state); confirmFate(sc, ns, v, boundWarn);
          path.push(`${here}:${v}`); merge(res, explore(ns, path, normalOK && v <= 6)); path.pop();
        }
      }
      m.res = res;
      return res;
    }
    function merge(a, b) { for (const k in b) a[k] = (a[k] || 0) + b[k]; }

    R.endings = explore(newState(sc), [], true);
    R.routes = Object.values(R.endings).reduce((a, b) => a + b, 0);
    if (R.aborted) R.warnings.push({ msg: `状態が多すぎるため検証を途中で打ち切りました（${limit}状態）。結果は不完全です` });
    for (const name of sc.order) {
      if (!R.reachable.has(name)) R.warnings.push({ msg: `場面「${name}」にはどのルートからも到達できません` });
      else if (!R.normalReachable.has(name)) R.info.push({ msg: `場面「${name}」は通常ダイス（1〜6）だけでは到達できません` });
      const a = R.arrivals[name];
      if (a && a.size > 1) R.warnings.push({ msg: `場面「${name}」に異なる消費数で合流しています（${[...a].join('、')}）` });
    }
    return R;
  }

  // 結末ごとの出やすさ（選択肢は均等に選ぶと仮定、ダイスは lo〜hi が均等）
  function endingOdds(sc, lo = 1, hi = 6) {
    const atoms = flowClasses(sc), live = liveSets(sc), relOf = {}, memo = new Map();
    for (const n of sc.order) relOf[n] = new Set([...live[n]].filter((x) => x.startsWith('s:')).map((x) => x.slice(2)));
    function rec(state) {
      const r = advance(sc, state, null, true);
      const k = `${state.scene}|${state.idx}|${state.s}|${state.f}|${stKey(state.st, relOf[state.scene])}|${historyKey(sc, atoms, state, live[state.scene])}`;
      if (memo.has(k)) return memo.get(k);
      let res = {};
      const add = (b, w) => { for (const x in b) res[x] = (res[x] || 0) + b[x] * w; };
      if (r.type === 'end') res = { [r.title]: 1 };
      else if (r.type === 'spark') r.node.choices.forEach((c, i) => { const ns = fastClone(state); chooseSpark(sc, ns, i); add(rec(ns), 1 / r.node.choices.length); });
      else if (r.type === 'fate') for (let v = lo; v <= hi; v++) { const ns = fastClone(state); confirmFate(sc, ns, v); add(rec(ns), 1 / (hi - lo + 1)); }
      memo.set(k, res);
      return res;
    }
    return rec(newState(sc));
  }

  const API = { parse, validate, endingOdds, newState, advance, chooseSpark, confirmFate, renderText, clone };
  if (typeof module !== 'undefined') module.exports = API; else root.F5Engine = API;
})(this);
