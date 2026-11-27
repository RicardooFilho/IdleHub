// O seletor do "Escolher na tela" roda dentro da página. Aqui ele roda numa árvore de elementos falsa,
// com um querySelectorAll mínimo (só o que o seletor gera: tag, #id, .classe, [attr="v"], :nth-of-type e " > ").
const test = require('node:test');
const assert = require('node:assert');
const { buildSelector, isStableToken, isStableValue, readableText, pickTarget, createSelectorKit, PICK_CODE } = require('../src/main/selector');

// ---------- DOM falso ----------
function el(tag, { id = '', classes = [], attrs = {}, text = '' } = {}, children = []) {
  const node = {
    tagName: tag.toUpperCase(),
    id,
    classList: classes,
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    innerText: text,
    parentElement: null,
    children,
  };
  for (const c of children) c.parentElement = node;
  return node;
}

const all = (root) => [root, ...root.children.flatMap(all)];

function parseSeg(seg) {
  const m = seg.match(/^([a-z0-9]*)((?:[#.][\w-]+|\[[\w-]+="[^"]*"\])*)(?::nth-of-type\((\d+)\))?$/);
  if (!m) throw new Error(`seletor fora do que o teste entende: ${seg}`);
  const out = { tag: m[1], id: '', classes: [], attrs: [], nth: m[3] ? Number(m[3]) : 0 };
  for (const part of m[2].match(/[#.][\w-]+|\[[\w-]+="[^"]*"\]/g) || []) {
    if (part[0] === '#') out.id = part.slice(1);
    else if (part[0] === '.') out.classes.push(part.slice(1));
    else {
      const [, n, v] = part.match(/\[([\w-]+)="([^"]*)"\]/);
      out.attrs.push([n, v]);
    }
  }
  return out;
}

function segMatches(node, s) {
  if (s.tag && node.tagName.toLowerCase() !== s.tag) return false;
  if (s.id && node.id !== s.id) return false;
  if (!s.classes.every((c) => node.classList.includes(c))) return false;
  if (!s.attrs.every(([n, v]) => node.getAttribute(n) === v)) return false;
  if (s.nth) {
    const same = node.parentElement ? node.parentElement.children.filter((x) => x.tagName === node.tagName) : [node];
    if (same.indexOf(node) + 1 !== s.nth) return false;
  }
  return true;
}

// Como o document.querySelectorAll: o último pedaço casa com o elemento e os de antes com os pais, em cadeia.
function makeCtx(root) {
  const nodes = all(root);
  return {
    query(sel) {
      const segs = sel.split(' > ').map(parseSeg);
      return nodes.filter((n) => {
        let cur = n;
        for (let i = segs.length - 1; i >= 0; i--) {
          if (!cur || !segMatches(cur, segs[i])) return false;
          cur = cur.parentElement;
        }
        return true;
      });
    },
  };
}

const build = (root, target) => buildSelector(target, makeCtx(root));

// Confere o que importa de verdade: o seletor achado encontra exatamente o elemento.
function assertFinds(root, target, result) {
  assert.ok(result, 'devia achar um seletor');
  const found = makeCtx(root).query(result.selector);
  assert.equal(found.length, 1, `o seletor ${result.selector} achou ${found.length} elementos`);
  assert.equal(found[0], target);
}

// ---------- nomes estáveis ----------
test('aceita nomes legíveis e recusa os que parecem gerados', () => {
  for (const ok of ['gold', 'gold-value', 'resource_count', 'topbar', 'stat-gold', 'col-12']) assert.equal(isStableToken(ok), true, ok);
  for (const bad of ['css-1x2y3z', 'sc-bdfBwQ', 'Button_btn__3xK9a', 'jsx-123456', 'a1b2c3d', 'xkcdqzw', 'svelte-abc12', '1abc', 'a:b', '']) {
    assert.equal(isStableToken(bad), false, bad);
  }
});

test('recusa classes de estado, que mudam com o jogo', () => {
  for (const bad of ['active', 'selected', 'hidden', 'is-open', 'has-error', 'loading', 'Disabled']) assert.equal(isStableToken(bad), false, bad);
});

test('valor de atributo: curto, sem aspas e sem cara de hash', () => {
  assert.equal(isStableValue('Ouro'), true);
  assert.equal(isStableValue('gold-amount'), true);
  assert.equal(isStableValue('a"b'), false);
  assert.equal(isStableValue('x'.repeat(60)), false);
  assert.equal(isStableValue(''), false);
  assert.equal(isStableValue('k3j9x2m1q'), false);
});

// ---------- montar o seletor ----------
test('prefere o id', () => {
  const gold = el('span', { id: 'gold', classes: ['value'] }, []);
  const root = el('div', {}, [el('p', {}, []), gold]);
  const r = build(root, gold);
  assert.deepEqual(r, { selector: '#gold', fragile: false });
});

test('id com cara de gerado (ex.: do React) fica de fora', () => {
  const gold = el('span', { id: 'r3x9k2m', classes: ['gold-value'] }, []);
  const root = el('div', {}, [gold, el('span', { classes: ['other'] }, [])]);
  assert.equal(build(root, gold).selector, '.gold-value');
});

test('sem id, usa atributo de teste antes das classes', () => {
  const gold = el('span', { classes: ['value'], attrs: { 'data-testid': 'gold-amount' } }, []);
  const root = el('div', {}, [gold, el('span', { classes: ['value'] }, [])]);
  const r = build(root, gold);
  assert.equal(r.selector, '[data-testid="gold-amount"]');
  assertFinds(root, gold, r);
});

test('usa classe estável e ignora as de estado e as geradas', () => {
  const gold = el('span', { classes: ['css-1a2b3c', 'active', 'gold-value'] }, []);
  const root = el('div', {}, [gold, el('span', { classes: ['css-1a2b3c', 'silver-value'] }, [])]);
  const r = build(root, gold);
  assert.equal(r.selector, '.gold-value');
  assert.equal(r.fragile, false);
});

test('classe repetida: sobe até um ancestral com id', () => {
  const a = el('span', { classes: ['value'] }, []);
  const b = el('span', { classes: ['value'] }, []);
  const panel = el('div', { id: 'resources' }, [el('div', {}, [a]), el('div', {}, [b])]);
  const root = el('body', {}, [panel, el('div', { classes: ['other'] }, [el('span', { classes: ['value'] }, [])])]);
  const r = build(root, b);
  assertFinds(root, b, r);
  assert.match(r.selector, /^#resources > /);
});

test('sem nada estável: caminho com :nth-of-type e marcado como frágil', () => {
  const target = el('span', {}, []);
  const root = el('div', {}, [el('div', {}, [el('span', {}, []), el('span', {}, [])]), el('div', {}, [el('span', {}, []), target])]);
  const r = build(root, target);
  assertFinds(root, target, r);
  assert.equal(r.fragile, true);
  assert.match(r.selector, /nth-of-type/);
});

test('o seletor sempre acha exatamente o elemento clicado, em qualquer folha', () => {
  const mk = (cls) => el('li', { classes: cls }, [el('span', { classes: ['num'] }, [])]);
  const list1 = el('ul', { classes: ['list'] }, [mk(['row']), mk(['row']), mk(['row', 'last'])]);
  const list2 = el('ul', { classes: ['list'] }, [mk(['row']), mk(['row'])]);
  const root = el('body', {}, [el('div', { classes: ['a'] }, [list1]), el('div', { classes: ['b'] }, [list2, el('p', {}, [])])]);
  for (const n of all(root)) {
    if (n === root) continue;
    assertFinds(root, n, build(root, n));
  }
});

test('o seletor não passa de 300 caracteres e devolve null se não der', () => {
  let node = el('span', {}, []);
  const target = node;
  for (let i = 0; i < 60; i++) node = el('div', {}, [node, el('div', {}, [])]);
  const root = node;
  const r = build(root, target);
  // Muito fundo: ou acha um caminho curto o bastante, ou desiste. Nunca um seletor grande demais ou errado.
  if (r) {
    assert.ok(r.selector.length <= 300);
    assertFinds(root, target, r);
  }
});

test('sem elemento, não monta seletor', () => {
  assert.equal(buildSelector(null, { query: () => [] }), null);
});

// ---------- texto e alvo ----------
test('lê o texto como o alerta lê: limpo e curto', () => {
  assert.equal(readableText(el('span', { text: '  1.234 \n ouro ' })), '1.234 ouro');
  assert.equal(readableText({ textContent: 'só textContent' }), 'só textContent');
  assert.equal(readableText({ value: '42' }), '42');
  assert.equal(readableText(el('span', { text: 'x'.repeat(200) })).length, 80);
  assert.equal(readableText(null), '');
});

test('escolhe o elemento com texto curto debaixo do cursor, não a camada vazia nem a página inteira', () => {
  const empty = el('div', {}, []);
  const value = el('span', { text: '1.234' }, []);
  const page = el('body', { text: 'x'.repeat(500) }, []);
  assert.equal(pickTarget([empty, value, page]), value);
  assert.equal(pickTarget([empty, page]), empty);
  assert.equal(pickTarget([]), null);
});

// ---------- código que vai para a página ----------
test('o código que vai para a página é autocontido e liga e desliga sem deixar nada', () => {
  // Roda o picker de verdade num document/window falsos, só para ver que cria a camada e a remove.
  const added = [];
  const listeners = [];
  const mkNode = () => ({
    style: {},
    children: [],
    appendChild(c) {
      this.children.push(c);
    },
    remove() {
      added.splice(added.indexOf(this), 1);
    },
    addEventListener(type, fn) {
      listeners.push([type, fn]);
    },
    removeEventListener(type, fn) {
      const i = listeners.findIndex(([t, f]) => t === type && f === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  });
  const win = { ...mkNode(), addEventListener: mkNode().addEventListener, removeEventListener: mkNode().removeEventListener };
  const doc = {
    createElement: mkNode,
    documentElement: { appendChild: (n) => added.push(n) },
    elementsFromPoint: () => [],
  };
  const run = new Function('window', 'document', `return ${PICK_CODE}`);
  const promise = run(win, doc);
  assert.equal(added.length, 1, 'a camada entrou na página');
  assert.ok(listeners.length > 0);
  const cancel = Object.getOwnPropertySymbols(win)
    .map((s) => win[s])
    .find((v) => v && v.cancel);
  assert.ok(cancel, 'o cancelamento fica numa chave Symbol.for, fora da vista de quem lista as propriedades');
  cancel.cancel();
  return promise.then((res) => {
    assert.deepEqual(res, { cancelled: true });
    assert.equal(added.length, 0, 'a camada saiu da página');
    assert.equal(listeners.length, 0, 'todos os ouvintes saíram');
    assert.equal(Object.getOwnPropertySymbols(win).length, 0, 'a chave foi apagada');
  });
});

test('a fábrica não depende de nada fora dela (roda sozinha como texto)', () => {
  const kit = new Function(`return (${createSelectorKit})()`)();
  assert.equal(typeof kit.buildSelector, 'function');
  assert.equal(kit.isStableToken('gold'), true);
});
