// "Escolher na tela": a pessoa clica no valor dentro do jogo e o IdleHub monta o seletor CSS do alerta.
// Tudo aqui roda DENTRO da página do jogo (via executeJavaScript, como o watchdog), então as funções
// precisam ser autocontidas e não podem depender do resto do módulo. A lógica do seletor mexe só numa
// interface mínima de elemento (tagName, id, classList, attributes, parentElement, children), para
// poder ser testada sem navegador (test/selector.test.js).

// Fábrica autocontida: o main manda o texto dela para a página e lá ela devolve as funções.
function createSelectorKit() {
  const MAX_SELECTOR = 300; // mesmo limite do games.js
  const MAX_DEPTH = 12;

  // Classes de estado mudam com o jogo (aberto, ativo…): não servem para achar o elemento depois.
  const STATE_WORDS = new Set([
    'active', 'selected', 'hover', 'focus', 'focused', 'open', 'opened', 'close', 'closed', 'show', 'shown', 'hide', 'hidden',
    'disabled', 'enabled', 'loading', 'loaded', 'visible', 'current', 'checked', 'expanded', 'collapsed', 'on', 'off',
    'highlight', 'highlighted', 'animate', 'animated', 'fade', 'in', 'out', 'pulse', 'flash',
  ]);

  // Atributos que quem escreve a página costuma deixar de propósito (e que não mudam à toa), do melhor para o pior.
  const ATTR_NAMES = [
    'data-testid', 'data-test', 'data-test-id', 'data-cy', 'data-qa', 'data-stat', 'data-resource', 'data-field',
    'data-name', 'data-id', 'data-key', 'data-type', 'name', 'aria-label', 'title', 'alt', 'role',
  ];
  const DATA_SKIP = /^data-(reactid|reactroot|v-|emotion|styled|radix|state|headlessui|index|slot|rbd)/;

  // Pedaço de nome com cara de código gerado (hash do CSS-in-JS ou de módulo): "3xK9a", "bdfBwQ", "a1b2c3".
  const hashLike = (part) => {
    if (part.length >= 5 && /\d/.test(part) && /[a-z]/i.test(part)) return true;
    if (part.length >= 6 && !/[aeiouy]/i.test(part)) return true;
    if (part.length >= 6 && (part.match(/[a-z][A-Z]/g) || []).length >= 2) return true;
    return false;
  };

  // Nome de classe ou id que dá para confiar: legível e que não muda sozinho.
  const isStableToken = (t) => {
    if (typeof t !== 'string' || !/^[A-Za-z_][\w-]*$/.test(t) || t.length > 40) return false;
    if (STATE_WORDS.has(t.toLowerCase()) || /^(is|has|was)[-_]/i.test(t)) return false;
    if (/^(css|sc|jsx|svelte|emotion|styled|tw)[-_]/i.test(t)) return false;
    return !t.split(/[-_]+/).filter(Boolean).some(hashLike);
  };

  // Valor de atributo que dá para confiar (vai entre aspas no seletor).
  const isStableValue = (v) =>
    typeof v === 'string' && v.length > 0 && v.length <= 50 && !/["'\\\n]/.test(v) && !v.split(/[\s_-]+/).filter(Boolean).some(hashLike);

  const tagOf = (el) => String(el.tagName || '').toLowerCase();
  const classesOf = (el) => Array.from(el.classList || []).filter(isStableToken);
  const kids = (el) => Array.from((el.parentElement && el.parentElement.children) || []);

  const attrsOf = (el) => {
    const out = [];
    const seen = new Set();
    const add = (name) => {
      if (seen.has(name)) return;
      const v = el.getAttribute ? el.getAttribute(name) : null;
      if (v != null && isStableValue(v)) {
        seen.add(name);
        out.push({ name, value: v });
      }
    };
    ATTR_NAMES.forEach(add);
    for (const a of Array.from(el.attributes || [])) if (/^data-/.test(a.name) && !DATA_SKIP.test(a.name)) add(a.name);
    return out;
  };

  const idOf = (el) => (el.id && isStableToken(el.id) ? el.id : '');

  // Um pedaço do seletor: { tag, id, classes, attr, nth }.
  const render = (s) =>
    (s.id ? `#${s.id}` : `${s.tag || ''}${(s.classes || []).map((c) => `.${c}`).join('')}${s.attr ? `[${s.attr.name}="${s.attr.value}"]` : ''}`) +
    (s.nth ? `:nth-of-type(${s.nth})` : '');

  const matchesSeg = (el, s) =>
    (!s.tag || tagOf(el) === s.tag) &&
    (!s.id || el.id === s.id) &&
    (s.classes || []).every((c) => Array.from(el.classList || []).includes(c)) &&
    (!s.attr || (el.getAttribute && el.getAttribute(s.attr.name) === s.attr.value));

  // Só um elemento na página casa com o seletor, e é este.
  const isOnly = (sel, el, ctx) => {
    if (!sel || sel.length > MAX_SELECTOR) return false;
    try {
      const list = ctx.query(sel);
      return list.length === 1 && list[0] === el;
    } catch {
      return false;
    }
  };

  // Jeitos de achar o elemento sozinho, do mais estável para o menos.
  const standalone = (el) => {
    const tag = tagOf(el);
    const out = [];
    const id = idOf(el);
    if (id) out.push({ id });
    const attrs = attrsOf(el);
    for (const attr of attrs) out.push({ attr });
    for (const attr of attrs) out.push({ tag, attr });
    const cls = classesOf(el).slice(0, 4);
    for (const c of cls) out.push({ classes: [c] });
    for (const c of cls) out.push({ tag, classes: [c] });
    for (let i = 0; i < cls.length; i++) for (let j = i + 1; j < cls.length; j++) out.push({ tag, classes: [cls[i], cls[j]] });
    if (cls.length > 2) out.push({ tag, classes: cls.slice(0, 3) });
    return out;
  };

  // Pedaço de um elemento dentro de um caminho: tag + classes estáveis, mais a posição entre irmãos se precisar.
  const step = (el, withClasses) => {
    const seg = { tag: tagOf(el), classes: withClasses ? classesOf(el).slice(0, 2) : [] };
    const sibs = kids(el);
    if (sibs.filter((x) => matchesSeg(x, seg)).length > 1) {
      seg.nth = sibs.filter((x) => tagOf(x) === seg.tag).indexOf(el) + 1;
    }
    return seg;
  };

  // Devolve { selector, fragile } ou null. `ctx.query(sel)` é o document.querySelectorAll da página.
  // fragile = o seletor depende da posição (:nth-of-type) e pode quebrar se o jogo mudar a ordem das coisas.
  const buildSelector = (el, ctx) => {
    if (!el || !el.tagName) return null;
    for (const seg of standalone(el)) {
      const sel = render(seg);
      if (isOnly(sel, el, ctx)) return { selector: sel, fragile: false };
    }
    // Caminho a partir de um ancestral: sobe até o seletor ficar único (ou até um ancestral com id).
    const segs = [];
    let cur = el;
    for (let depth = 0; cur && depth < MAX_DEPTH; depth++) {
      const id = depth > 0 ? idOf(cur) : '';
      segs.unshift(id ? { id } : step(cur, true));
      const sel = segs.map(render).join(' > ');
      if (isOnly(sel, el, ctx)) return { selector: sel, fragile: sel.includes(':nth-of-type') };
      if (id) break;
      cur = cur.parentElement;
    }
    // Último recurso: o caminho completo só com tags e posições.
    const full = [];
    for (let n = el; n; n = n.parentElement) full.unshift(step(n, false));
    const sel = full.map(render).join(' > ');
    return isOnly(sel, el, ctx) ? { selector: sel, fragile: true } : null;
  };

  // Texto que o alerta vai ler, como o watchdog lê (innerText, senão textContent, senão value), limpo e curto.
  const readableText = (el, max = 80) =>
    String((el && (el.innerText || el.textContent || el.value)) || '').replace(/\s+/g, ' ').trim().slice(0, max);

  // Entre os elementos debaixo do cursor (do de cima para o de baixo), o que tem um texto curto: é o valor
  // que a pessoa quer ver. Se nenhum tem, fica o de cima.
  const pickTarget = (stack) => {
    for (const el of stack) {
      const t = readableText(el, 400);
      if (t && t.length <= 300) return el;
    }
    return stack[0] || null;
  };

  return { buildSelector, isStableToken, isStableValue, readableText, pickTarget };
}

// Roda na página: liga o modo de escolha e espera um clique (ou Esc). Devolve uma Promise com
// { ok: true, selector, fragile, text, tag } | { ok: false } (sem seletor) | { cancelled: true }.
// Uma camada transparente cobre a página: o clique nunca chega no jogo (não compra nada sem querer).
// Ao terminar, remove a camada e todos os ouvintes. Nada fica na página.
function runPicker(kit) {
  const KEY = Symbol.for('idlehub.pick');
  if (window[KEY]) window[KEY].cancel();
  return new Promise((resolve) => {
    const doc = document;
    const overlay = doc.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;margin:0;padding:0;border:0;background:transparent;cursor:crosshair;';
    const box = doc.createElement('div');
    box.style.cssText =
      'position:fixed;display:none;pointer-events:none;box-sizing:border-box;border:2px solid #fc5e03;background:rgba(252,94,3,.18);border-radius:3px;';
    overlay.appendChild(box);

    const listeners = [];
    const on = (target, type, fn) => {
      target.addEventListener(type, fn, true);
      listeners.push([target, type, fn]);
    };
    const targetAt = (x, y) => kit.pickTarget(doc.elementsFromPoint(x, y).filter((e) => e !== overlay && e !== box));
    let last = null;
    let done = false;

    const cleanup = () => {
      done = true;
      for (const [t, type, fn] of listeners) t.removeEventListener(type, fn, true);
      overlay.remove();
      try {
        delete window[KEY];
      } catch {}
    };
    const finish = (result) => {
      if (done) return;
      cleanup();
      resolve(result);
    };

    const draw = () => {
      const el = last && targetAt(last.x, last.y);
      if (!el) {
        box.style.display = 'none';
        return;
      }
      const r = el.getBoundingClientRect();
      Object.assign(box.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    };

    // A página não vê nenhum desses eventos, só a camada.
    const stop = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    on(overlay, 'mousemove', (e) => {
      last = { x: e.clientX, y: e.clientY };
      draw();
    });
    on(overlay, 'click', (e) => {
      stop(e);
      if (done) return;
      const el = targetAt(e.clientX, e.clientY);
      // Tira a camada antes de montar o seletor: ela não pode entrar na conta.
      cleanup();
      if (!el) return resolve({ ok: false });
      const found = kit.buildSelector(el, { query: (s) => doc.querySelectorAll(s) });
      resolve(found ? { ok: true, selector: found.selector, fragile: found.fragile, text: kit.readableText(el), tag: String(el.tagName || '').toLowerCase() } : { ok: false });
    });
    for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'auxclick', 'touchstart', 'touchend']) on(overlay, type, stop);
    on(window, 'keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      finish({ cancelled: true });
    });
    on(window, 'scroll', draw);
    on(window, 'resize', draw);

    Object.defineProperty(window, KEY, { configurable: true, enumerable: false, value: { cancel: () => finish({ cancelled: true }) } });
    doc.documentElement.appendChild(overlay);
  });
}

const PICK_CODE = `(${runPicker})((${createSelectorKit})())`;
const PICK_CANCEL_CODE = `(() => { const p = window[Symbol.for('idlehub.pick')]; if (p) p.cancel(); })()`;

module.exports = { createSelectorKit, runPicker, PICK_CODE, PICK_CANCEL_CODE, ...createSelectorKit() };
