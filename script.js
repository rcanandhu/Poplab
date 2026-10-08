/* POPLAB MoodBands — static runtime.
   Renders the desktop or mobile view from its template + state, and patches the DOM in place
   so CSS transitions (stack preview, list reorder) keep running between updates. */
(function () {
  'use strict';

  function DCLogic(props) { this.props = props || {}; }
  DCLogic.prototype.setState = function (patch) {
    Object.assign(this.state, patch);
    if (this.__schedule) this.__schedule();
  };
  window.DCLogic = DCLogic;

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  function esc(v) { return String(v).replace(/[&<>"]/g, function (c) { return ESC[c]; }); }
  function get(path, scope) {
    var parts = path.split('.'), o = scope[parts[0]];
    for (var i = 1; i < parts.length; i++) o = o == null ? undefined : o[parts[i]];
    return o;
  }

  function Renderer(template, Component, root) {
    this.template = template;
    this.root = root;
    this.handlers = {};
    this.seq = 0;
    this.comp = new Component({});
    var self = this, queued = false;
    this.comp.__schedule = function () {
      if (queued) return;
      queued = true;
      Promise.resolve().then(function () { queued = false; self.render(); });
    };
  }
  Renderer.prototype.interp = function (t, scope) {
    var self = this;
    t = t.replace(/\son([A-Z]\w*)="\{\{\s*([\w.]+)\s*\}\}"/g, function (_, ev, p) {
      var fn = get(p, scope);
      if (typeof fn !== 'function') return '';
      var id = 'h' + (self.seq++);
      self.handlers[id] = fn;
      return ' data-on-' + ev.toLowerCase() + '="' + id + '"';
    });
    return t.replace(/\{\{\s*([\w.]+)\s*\}\}/g, function (_, p) {
      var v = get(p, scope);
      return (v === undefined || v === null || typeof v === 'function') ? '' : esc(v);
    });
  };
  Renderer.prototype.expand = function (t, scope) {
    var out = '', i = 0, re = /<(sc-for|sc-if)\b([^>]*)>/g, m;
    while (true) {
      re.lastIndex = i;
      m = re.exec(t);
      if (!m) { out += this.interp(t.slice(i), scope); break; }
      out += this.interp(t.slice(i, m.index), scope);
      var tag = m[1], attrs = m[2], depth = 1, rx = new RegExp('<(/?)' + tag + '\\b[^>]*>', 'g'), e;
      rx.lastIndex = re.lastIndex;
      while (depth > 0) { e = rx.exec(t); if (!e) throw new Error('Unbalanced <' + tag + '>'); depth += e[1] ? -1 : 1; }
      var inner = t.slice(re.lastIndex, e.index);
      if (tag === 'sc-for') {
        var list = get(attrs.match(/list="\{\{\s*([\w.]+)\s*\}\}"/)[1], scope) || [];
        var as = attrs.match(/as="(\w+)"/)[1];
        for (var k = 0; k < list.length; k++) { var sc = Object.create(scope); sc[as] = list[k]; out += this.expand(inner, sc); }
      } else if (get(attrs.match(/value="\{\{\s*([\w.]+)\s*\}\}"/)[1], scope)) {
        out += this.expand(inner, scope);
      }
      i = rx.lastIndex;
    }
    return out;
  };
  Renderer.prototype.render = function () {
    this.handlers = {};
    this.seq = 0;
    var vals = this.comp.renderVals();
    var html = this.expand(this.template, vals);
    var tpl = document.createElement('template');
    tpl.innerHTML = html;
    morphChildren(this.root, tpl.content);
  };

  function morphChildren(cur, next) {
    var a = cur.childNodes, b = next.childNodes, i;
    var nb = Array.prototype.slice.call(b);
    for (i = 0; i < nb.length; i++) {
      var n = nb[i], o = a[i];
      if (!o) { cur.appendChild(n); continue; }
      if (o.nodeType !== n.nodeType || o.nodeName !== n.nodeName) { cur.replaceChild(n, o); continue; }
      if (o.nodeType === 3 || o.nodeType === 8) { if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue; continue; }
      morphAttrs(o, n);
      morphChildren(o, n);
    }
    while (a.length > nb.length) cur.removeChild(a[a.length - 1]);
  }
  function morphAttrs(o, n) {
    var i, at;
    for (i = o.attributes.length - 1; i >= 0; i--) { at = o.attributes[i].name; if (!n.hasAttribute(at)) o.removeAttribute(at); }
    for (i = 0; i < n.attributes.length; i++) { at = n.attributes[i]; if (o.getAttribute(at.name) !== at.value) o.setAttribute(at.name, at.value); }
  }

  /* Prototype responses for commerce actions that have no backend. */
  var toastEl, toastTimer;
  function toast(msg) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'proto-toast'; toastEl.setAttribute('role', 'status'); document.body.appendChild(toastEl); }
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, 2400);
  }
  function protoMessage(el) {
    var btn = el.closest('button');
    if (!btn) return null;
    var label = (btn.getAttribute('aria-label') || btn.textContent || '').trim();
    if (/^Buy your stack/i.test(label)) return 'Prototype — your stack would be added to the bag here.';
    if (/^Add .* to bag$|^Add to bag$/i.test(label)) return 'Prototype — added to bag.';
    if (/^Bag/i.test(label)) return 'Prototype — the bag isn’t connected.';
    if (/^Search$/i.test(label)) return 'Prototype — search isn’t connected.';
    if (/^Account$/i.test(label)) return 'Prototype — accounts aren’t connected.';
    return null;
  }

  function bindEvents(root, getRenderer) {
    ['click', 'keydown', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel'].forEach(function (type) {
      root.addEventListener(type, function (e) {
        var r = getRenderer(), el = e.target, attr = 'data-on-' + type, handled = false;
        while (el && el !== root.parentNode) {
          if (el.nodeType === 1 && el.hasAttribute(attr)) {
            var fn = r.handlers[el.getAttribute(attr)];
            if (fn) {
              var target = el;
              fn(new Proxy(e, { get: function (t, p) { if (p === 'currentTarget') return target; var v = t[p]; return typeof v === 'function' ? v.bind(t) : v; } }));
              handled = true;
            }
            break;
          }
          el = el.parentNode;
        }
        if (type === 'click' && !handled) { var msg = protoMessage(e.target); if (msg) toast(msg); }
      });
    });
  }

  window.MoodBandsApp = {
    start: function (views) {
      var root = document.getElementById('app'), mq = window.matchMedia('(max-width: 767px)'), current = null, renderers = {};
      function pick() {
        var key = mq.matches ? 'mobile' : 'desktop';
        if (current === key) return;
        current = key;
        root.innerHTML = '';
        root.setAttribute('data-view', key);
        if (!renderers[key]) renderers[key] = new Renderer(views[key].template, views[key].Component, root);
        renderers[key].render();
      }
      bindEvents(root, function () { return renderers[current]; });
      if (mq.addEventListener) mq.addEventListener('change', pick); else mq.addListener(pick);
      pick();
      if (location.hash) { var t = document.getElementById(location.hash.slice(1)); if (t) t.scrollIntoView(); }
    }
  };
})();

/* ===== Desktop view ===== */
var DesktopView = (function () {
var COLORS = [
  ['hotpink', 'Hot Pink', '#FF3E8A'], ['red', 'Red', '#E8243D'], ['orange', 'Orange', '#FF6A1A'], ['yellow', 'Yellow', '#FFD21A'], ['lime', 'Lime', '#9EE02F'],
  ['blue', 'Blue', '#2F6BFF'], ['lavender', 'Lavender', '#B7A2FF'], ['purple', 'Purple', '#7B3FE4'], ['pink', 'Pink', '#FFA3C9'], ['white', 'White', '#F7F5EF']
].map(function (r) { return { id: r[0], name: r[1], c: r[2] }; });
var BY = {};
COLORS.forEach(function (m) { BY[m.id] = m; });
function hx(h) { var x = parseInt(h.slice(1), 16); return [(x >> 16) & 255, (x >> 8) & 255, x & 255]; }
function toHex(a) { return '#' + a.map(function (v) { var s = Math.round(v).toString(16); return s.length < 2 ? '0' + s : s; }).join('').toUpperCase(); }
function mix(a, b, t) { var x = hx(a), y = hx(b); return toHex(x.map(function (v, i) { return v * (1 - t) + y[i] * t; })); }
/* Photo-slot tone: the average of the colors in the shot, pushed toward the neutral slot color. */
function tone(ids, k) { var s = [0, 0, 0]; ids.forEach(function (id) { var c = hx(BY[id].c); s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; }); return mix(toHex(s.map(function (v) { return v / ids.length; })), '#E9E5DD', k || 0.88); }

/* Product images: one studio packshot, recolored per colorway; Slim is cut from the same shot so proportions never drift.
   [0] = band on top of a stack (open), [1] = band lower in a stack (opening in shadow). */
var IMG = {
  W: { blue: ['', ''], hotpink: ['', ''], lavender: ['', ''], lime: ['', ''], orange: ['', ''], pink: ['', ''], purple: ['', ''], red: ['', ''], white: ['', ''], yellow: ['', ''] },
  S: { blue: ['', ''], hotpink: ['', ''], lavender: ['', ''], lime: ['', ''], orange: ['', ''], pink: ['', ''], purple: ['', ''], red: ['', ''], white: ['', ''], yellow: ['', ''] }
};
var SHADOW = 'assets/images/photos/4c7eb7491e8e4dde19e34ad7ac97fbc2.webp';
/* Supplied MoodBands band images (Figma Assets page). Wide 720x463, Slim 714x398 at source; both share the rim line,
   so a band sits on the one below with its bottom edge on that band's front rim. */
var BAND = {
  W: { hotpink: 'assets/images/bands/W-hotpink.webp', red: 'assets/images/bands/W-red.webp', orange: 'assets/images/bands/W-orange.webp', yellow: 'assets/images/bands/W-yellow.webp', lime: 'assets/images/bands/W-lime.webp', blue: 'assets/images/bands/W-blue.webp', lavender: 'assets/images/bands/W-lavender.webp', purple: 'assets/images/bands/W-purple.webp', pink: 'assets/images/bands/W-pink.webp' },
  S: { hotpink: 'assets/images/bands/S-hotpink.webp', red: 'assets/images/bands/S-red.webp', orange: 'assets/images/bands/S-orange.webp', yellow: 'assets/images/bands/S-yellow.webp', lime: 'assets/images/bands/S-lime.webp', blue: 'assets/images/bands/S-blue.webp', lavender: 'assets/images/bands/S-orchid.webp', purple: 'assets/images/bands/S-purple.webp', pink: 'assets/images/bands/S-orchid.webp' }
};
var BAND_SHADOW = 'assets/images/bands/shadow.webp';
var BG = { W: { w: 720, h: 463, rim: 329.5, dx: 0 }, S: { w: 714, h: 398, rim: 329.5, dx: 3.2 } };
var CFG = ['hotpink', 'red', 'orange', 'yellow', 'lime', 'blue', 'lavender', 'purple', 'pink'];
/* Live preview geometry: each band layer is anchored at its seat line (its bottom edge). */
function bandLayout(bands, dispW, boxH, minFloor) {
  var k = dispW / 720, hs = bands.map(function (b) { return BG[b.w].h * k; }), H = hs[0], i;
  for (i = 1; i < bands.length; i++) H += (BG[bands[i].w].h - BG[bands[i].w].rim) * k;
  var floor = Math.max(minFloor, Math.round((boxH + H) / 2)), seats = [], seat = floor;
  for (i = 0; i < bands.length; i++) { seats.push(seat); seat = seat - hs[i] + BG[bands[i].w].rim * k; }
  return { floor: floor, seats: seats, top: seat - (BG.W.h - BG.W.rim) * k, k: k };
}
/* Studio product photographs, one per curated stack (theme + band count). */
var PHOTO = {
  'everyday-2': 'assets/images/photos/83cfd4d54b56cba959c38cb8e8d2f872.webp', 'everyday-3': 'assets/images/photos/6b3787220fae01fcb7fa44bee208c2e0.webp', 'everyday-4': 'assets/images/photos/eaee7358449ee337e5a8bc472d57e3f1.webp', 'everyday-5': 'assets/images/photos/eb3c2f9c00f6a734f0feb759d163e246.webp',
  'festive-2': 'assets/images/photos/ddf31252ad8a982e673a5b3c0d502394.webp', 'festive-3': 'assets/images/photos/77fa6a013f9584f37559c5349126f221.webp', 'festive-4': 'assets/images/photos/737a7ef263d6533b3cd92f4332b7473e.webp', 'festive-5': 'assets/images/photos/b3d8912248f92ec6965b5e5c7e504e50.webp',
  'gym-2': 'assets/images/photos/8a344c849d66fe6598c9a13aa3ed016e.webp', 'gym-3': 'assets/images/photos/1a3639f7a2062e75ba0d7daa3fc46e6e.webp', 'gym-4': 'assets/images/photos/1994756b6d7c80bda2dedc5678917171.webp', 'gym-5': 'assets/images/photos/ca7d7f51bd854a49e1cf71cab523baad.webp',
  'summer-2': 'assets/images/photos/f4ca9cbcda9643df09b91cad28cb24d4.webp', 'summer-3': 'assets/images/photos/e016f09b428990f54aa125eac592866c.webp', 'summer-4': 'assets/images/photos/7d33e8837d98170f4ed730482dd07fbc.webp', 'summer-5': 'assets/images/photos/c5d6ee713fe7a9d69ad3a2f25a90a717.webp',
  'beach-2': 'assets/images/photos/54dcb565c5dffbe0b6e69b24686e7045.webp', 'beach-3': 'assets/images/photos/b6bc09f23e686670876afd4ece41d448.webp', 'beach-4': 'assets/images/photos/9c4c170490fe3770fa0a06c9f04a3df5.webp', 'beach-5': 'assets/images/photos/12f76f21f6854ec06e4dc03e1ffe0059.webp'
};
/* Illustrative prices. */
var BASE = { 2: 16, 3: 22, 4: 28, 5: 34 }, TADJ = { everyday: 0, festive: 2, gym: -1, summer: 1, beach: 0 };
function stackPrice(theme, n) { return '$' + (BASE[n] + TADJ[theme]); }
var SINGLE = { hotpink: 9, red: 9, orange: 8, yellow: 8, lime: 8, blue: 9, lavender: 10, purple: 9, pink: 10, white: 8 };
var SLIMP = 7, WIDEP = 9;
/* Real photography (licensed stock, bands retouched to MoodBands colors) and studio singles. */
var REAL = { heroD: 'assets/images/photos/heroD.jpg', heroM: 'assets/images/photos/heroM.jpg', bannerArms: 'assets/images/photos/bannerD.jpg', bannerM: 'assets/images/photos/bannerM.jpg',
  wOne: 'assets/images/photos/wOne.jpg', wReady: 'assets/images/photos/wReady.jpg', wOwn: 'assets/images/photos/wOwn.jpg',
  sHold: 'assets/images/photos/sHold.jpg', sFace: 'assets/images/photos/sFace.jpg', sCross: 'assets/images/photos/sCross.jpg', sFists: 'assets/images/photos/sFists.jpg' };
var SINGLEIMG = { hotpink: 'assets/images/photos/4cbc64f2712af7b4295fa2a81d06b082.webp', red: 'assets/images/photos/2b0656f2c71a7aa7feb5e262cffcbe07.webp', orange: 'assets/images/photos/6ca342318e9af4d2c56cf450822f5fbf.webp', yellow: 'assets/images/photos/681516cb1b992bb532ffea685a5d17d4.webp', lime: 'assets/images/photos/915fc8728998c3cddefb2cfa1c0b05db.webp',
  blue: 'assets/images/photos/5f89a4125e60aba4dbf2747d5f390b76.webp', lavender: 'assets/images/photos/1ef0df58f572684af728f6ee4df7a452.webp', purple: 'assets/images/photos/7b788d1952bb17680a8e9e41e3998add.webp', pink: 'assets/images/photos/1f8ee4ad4c2c6cabed02924ba65c8c76.webp', white: 'assets/images/photos/ec5da4be48acee599ce80d137e41e6ed.webp' };
var PH = {
  hero: '', curated: '', build: '',
  single: '', pair: '', stack: '', banner: '',
  hero1: '', hero2: '', hero3: '', hero4: '', banner2: '',
  street: '', phone: '', bike: '', cafe: '',
  pSingle: 'assets/images/photos/7cc975fbf7ba178b4e954bcb5d9ae249.webp', pCurated: 'assets/images/photos/d46cbfe298b48ca3a1f9a4608cc44d3d.webp', pBuild: 'assets/images/photos/0e5548d05f7689e16b5d5dfd5fc99cc3.webp',
  heroD: REAL.heroD, heroM: REAL.heroM, bannerArms: REAL.bannerArms, bannerM: REAL.bannerM, sHold: REAL.sHold, sFace: REAL.sFace, sCross: REAL.sCross, sFists: REAL.sFists,
  everyday: '', festive: '', gym: '', summer: '', beach: ''
};
/* Source frame 600 x 364; a band above sits higher by its own wall height: Wide 100, Slim 39 (about 10 mm vs 3.5 mm). */
var RW = 600, RH = 364, SHH = 386, OFF = { W: 100, S: 39 };
function stack(bands, dispW, boxH) {
  var s = dispW / RW, ih = Math.round(RH * s), above = 0, i;
  for (i = 0; i < bands.length - 1; i++) above += OFF[bands[i][1]] * s;
  var y = Math.round((boxH - ih - above) / 2 - boxH * 0.02);
  var layers = bands.map(function (b, j) { var L = { src: IMG[b[1]][b[0]][j === 0 ? 0 : 1], y: Math.round(y), z: 20 - j, w: dispW }; y += OFF[b[1]] * s; return L; });
  return { w: dispW, ml: -Math.round(dispW / 2), shY: layers[layers.length - 1].y, layers: layers };
}
function widthLabel(bands) { var s = bands.filter(function (b) { return b[1] === 'S'; }).length; return s === bands.length ? 'Slim' : (s === 0 ? 'Wide' : 'Mixed'); }

var THEMES = [
  { id: 'everyday', alt: 'a hand on a tote strap, three bands under a denim cuff', name: 'Everyday', desc: 'Versatile colors that go with what you already wear.', stacks: [
    [['lavender', 'W'], ['white', 'S']], [['blue', 'S'], ['white', 'W'], ['lavender', 'S']], [['lavender', 'W'], ['pink', 'S'], ['white', 'S'], ['blue', 'W']], [['white', 'S'], ['blue', 'S'], ['lavender', 'W'], ['pink', 'S'], ['white', 'S']]] },
  { id: 'festive', alt: 'a raised glass at a party, four bands under string lights', name: 'Festive', desc: 'Bold, celebratory color for big nights and big days.', stacks: [
    [['hotpink', 'W'], ['yellow', 'S']], [['red', 'W'], ['yellow', 'S'], ['purple', 'W']], [['red', 'W'], ['yellow', 'S'], ['purple', 'S'], ['hotpink', 'W']], [['hotpink', 'S'], ['red', 'W'], ['orange', 'S'], ['yellow', 'W'], ['purple', 'S']]] },
  { id: 'gym', alt: 'a hand on a water bottle after training, two Wide bands', name: 'Gym', desc: 'Energetic, sporty color that keeps up with you.', stacks: [
    [['lime', 'W'], ['blue', 'W']], [['lime', 'S'], ['orange', 'W'], ['white', 'S']], [['blue', 'W'], ['lime', 'W'], ['white', 'W'], ['orange', 'W']], [['lime', 'S'], ['blue', 'S'], ['orange', 'S'], ['white', 'S'], ['lime', 'S']]] },
  { id: 'summer', alt: 'an arm on a sunny cafe table, a bright three-band stack', name: 'Summer', desc: 'Bright, playful colors for long days outside.', stacks: [
    [['yellow', 'S'], ['orange', 'S']], [['yellow', 'S'], ['hotpink', 'W'], ['orange', 'S']], [['hotpink', 'W'], ['yellow', 'S'], ['lime', 'S'], ['orange', 'W']], [['yellow', 'W'], ['orange', 'S'], ['hotpink', 'W'], ['pink', 'S'], ['lime', 'W']]] },
  { id: 'beach', alt: 'a wrist on a striped beach towel, three bands with sand on skin', name: 'Beach', desc: 'Relaxed, colorful and easy to swap around.', stacks: [
    [['blue', 'W'], ['white', 'S']], [['blue', 'W'], ['yellow', 'S'], ['white', 'W']], [['blue', 'S'], ['lime', 'S'], ['yellow', 'S'], ['white', 'S']], [['white', 'S'], ['blue', 'W'], ['yellow', 'S'], ['lime', 'S'], ['blue', 'S']]] }
];
var TBY = {};
THEMES.forEach(function (t) { TBY[t.id] = t; });
var TAGS = { hotpink: ['summer', 'festive'], red: ['festive'], orange: ['summer', 'gym', 'festive'], yellow: ['summer', 'beach', 'festive'], lime: ['gym', 'summer', 'beach'], blue: ['everyday', 'beach', 'gym'], lavender: ['everyday'], purple: ['festive'], pink: ['everyday', 'summer'], white: ['everyday', 'beach', 'gym'] };
var SIZES = [['S', 'Small'], ['M', 'Medium'], ['L', 'Large']];
var COUNTS = [2, 3, 4, 5, 6];
var KEYS = ['k0', 'k1', 'k2', 'k3', 'k4', 'k5'];
var ROWH = 56;
var PVW = 360, PVBASE = 0, PVFLOOR = 470, SX = { S: 0.94, M: 1, L: 1.06 };
var PVH = 640;
var HERO = [['hotpink', 'W'], ['yellow', 'S'], ['blue', 'W'], ['lime', 'S']];
var FEATURE = { src: 'sFists', pos: '50% 45%', alt: 'Friends bumping fists in a circle, wrists wearing yellow, pink, purple, lime and red MoodBands' };
var LOOKS = [
  { src: 'sHold', pos: '50% 50%', alt: 'Point-of-view photo: holding a friend\'s hand across a park lawn, a blue MoodBand on the wrist' },
  { src: 'sFace', pos: '40% 50%', alt: 'Close portrait: a hand raised across the face, one orange MoodBand on the wrist' },
  { src: 'sCross', pos: '50% 40%', alt: 'Hands resting on a chair back, a lime MoodBand on one wrist' }
];
var FOOT = [
  { title: 'Shop', col: '6 / span 2', links: [['New & Featured', '#top'], ['MoodBands', '#top'], ['All Products', '#drop']] },
  { title: 'Help', col: '8 / span 2', links: [['Shipping', '#footer'], ['Returns', '#footer'], ['Contact', '#footer']] },
  { title: 'About', col: '10 / span 2', links: [['About POPLAB', '#footer'], ['Our Story', '#footer']] },
  { title: 'Social', col: '12 / span 1', links: [['Instagram', '#footer'], ['TikTok', '#footer']] }
];
var PAGE = 9;

class Component extends window.DCLogic {
  constructor(props) {
    super(props);
    this.state = {
      theme: 'everyday', count: 4, size: 'M', order: KEYS.slice(),
      col: { k0: 'hotpink', k1: 'yellow', k2: 'blue', k3: 'lime', k4: 'orange', k5: 'lavender' },
      wid: { k0: 'wide', k1: 'slim', k2: 'wide', k3: 'slim', k4: 'wide', k5: 'slim' },
      open: null, measure: false, dragKey: null, dragDy: 0, sel: 'k0',
      fSize: 'all', fCount: 'all', fTheme: 'all', fWidth: 'all', showAll: false
    };
    this.drag = null;
  }
  set(field, key, val) { var o = Object.assign({}, this.state[field]); o[key] = val; var u = {}; u[field] = o; this.setState(u); }
  moveBy(key, dir) {
    var o = this.state.order.slice(), i = o.indexOf(key), j = i + dir;
    if (j < 0 || j >= this.state.count) return;
    o[i] = o[j]; o[j] = key;
    this.setState({ order: o });
  }
  dragStart(key, e) {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
    this.drag = { key: key, y0: e.clientY };
    this.setState({ dragKey: key, dragDy: 0 });
  }
  dragMove(e) {
    var d = this.drag;
    if (!d) return;
    var dy = e.clientY - d.y0, o = this.state.order.slice(), i = o.indexOf(d.key);
    while (dy > ROWH / 2 && i < this.state.count - 1) { o[i] = o[i + 1]; o[i + 1] = d.key; i++; d.y0 += ROWH; dy -= ROWH; }
    while (dy < -ROWH / 2 && i > 0) { o[i] = o[i - 1]; o[i - 1] = d.key; i--; d.y0 -= ROWH; dy += ROWH; }
    this.setState({ order: o, dragDy: dy });
  }
  dragEnd() { this.drag = null; this.setState({ dragKey: null, dragDy: 0 }); }
  customize(bands) {
    var c = Object.assign({}, this.state.col), w = Object.assign({}, this.state.wid), o = this.state.order;
    bands.forEach(function (b, i) { c[o[i]] = b[0]; w[o[i]] = b[1] === 'S' ? 'slim' : 'wide'; });
    this.setState({ col: c, wid: w, count: bands.length, open: null });
  }
  dropdown(id, label, opts, cur, pick) {
    var self = this, isOpen = this.state.open === id;
    return {
      label: label, isOpen: isOpen, open: isOpen ? 'true' : 'false', rot: isOpen ? 180 : 0,
      toggle: function () { self.setState({ open: self.state.open === id ? null : id }); },
      opts: opts.map(function (o) {
        var on = o[0] === cur;
        return { label: o[1], sel: on ? 'true' : 'false', chk: on ? 1 : 0, wt: on ? 600 : 400,
          pick: function () { pick(o[0]); self.setState({ open: null }); },
          key: function (e) { if (e.key === 'Escape') { e.preventDefault(); self.setState({ open: null }); } } };
      })
    };
  }
  renderVals() {
    var self = this, st = this.state;

    var ways = [
      { col: '', mt: 0, title: 'One band', copy: 'Keep it simple. One band, one statement.', life: REAL.wOne, pos: '50% 30%', prod: PH.pSingle, lifeAlt: 'A hand gathering dark hair, one red MoodBand on the wrist', prodAlt: 'Product photo: a single MoodBand', aria: 'Shop singles', cta: 'Shop Singles', href: '#drop', go: function () { self.setState({ fCount: 1, fTheme: 'all', fWidth: 'all', showAll: false }); } },
      { col: '', mt: 0, title: 'Ready-made stack', copy: 'Good combinations, already figured out.', life: REAL.wReady, pos: '55% 55%', prod: PH.pCurated, lifeAlt: 'A wet hand on a pool edge wearing a magenta and a lime MoodBand together', prodAlt: 'Product photo: a ready-made four-band stack', aria: 'Shop ready-made stacks', cta: 'Shop Stacks', href: '#moods', go: function () {} },
      { col: '', mt: 0, title: 'Make your own', copy: 'Choose your colours and build your stack', life: REAL.wOwn, pos: '40% 40%', prod: PH.pBuild, lifeAlt: 'A wrist on a wooden table wearing a big mixed stack of colorful bands', prodAlt: 'Product photo: a mixed Slim and Wide stack', aria: 'Build your own stack', cta: 'Build Yours', href: '#create', go: function () {} }
    ];

    var themes = THEMES.map(function (t) {
      var on = st.theme === t.id;
      return { name: t.name, tabId: 'tab-' + t.id, sel: on ? 'true' : 'false', fg: on ? '#161616' : '#8A857B', pick: function () { self.setState({ theme: t.id }); } };
    });
    var T = TBY[st.theme];
    var cur = {
      name: T.name, tabId: 'tab-' + T.id, desc: T.desc,
      viewAll: function () { self.setState({ fTheme: T.id, fCount: 'all', fWidth: 'all', showAll: false }); },
      products: T.stacks.map(function (bands, pi) {
        var wl = widthLabel(bands), nm = T.name + ' ' + bands.length + '-band stack';
        return {
          name: nm, meta: bands.length + ' bands · ' + wl, img: PHOTO[T.id + '-' + bands.length], price: stackPrice(T.id, bands.length), delay: 80 + pi * 60,
          alt: 'Product image: ' + nm + ', ' + bands.map(function (b) { return BY[b[0]].name + ' ' + (b[1] === 'S' ? 'Slim' : 'Wide'); }).join(', '),
          aria: 'Add ' + nm + ' to bag'
        };
      })
    };

    var panes = THEMES.map(function (t) {
      return { on: t.id === st.theme, viewAll: cur.viewAll, name: t.name, desc: t.desc, products: t.id === st.theme ? cur.products : [] };
    });
    var sizeName = SIZES.filter(function (z) { return z[0] === st.size; })[0][1];
    var ddCount = this.dropdown('count', st.count + ' bands', COUNTS.map(function (n) { return [n, n + ' bands']; }), st.count, function (v) { self.setState({ count: v }); });
    var sizeNote = st.size === 'M' ? ' (7.5 inch)' : '';
    var ddSize = this.dropdown('size', sizeName, SIZES, st.size, function (v) { self.setState({ size: v }); });

    var selKey = st.order.indexOf(st.sel) < st.count ? st.sel : st.order[0], selI = st.order.indexOf(selKey);
    var edit = {
      c: BY[st.col[selKey]].c, slimOn: st.wid[selKey] === 'slim' ? 'true' : 'false', wideOn: st.wid[selKey] === 'slim' ? 'false' : 'true',
      widthAria: 'Width for band ' + (selI + 1), colorAria: 'Color for band ' + (selI + 1),
      slim: function () { self.set('wid', selKey, 'slim'); }, wide: function () { self.set('wid', selKey, 'wide'); },
      swatches: CFG.map(function (id) { return BY[id]; }).map(function (c) { var on = c.id === st.col[selKey]; return { name: c.name, c: c.c, checked: on ? 'true' : 'false', r1: on ? 3 : 0, r2: on ? 5 : 0, pick: function () { self.set('col', selKey, c.id); } }; })
    };
    var rows = KEYS.map(function (k) {
      var i = st.order.indexOf(k), on = i < st.count, m = BY[st.col[k]], w = st.wid[k], dragging = st.dragKey === k, sl = w === 'slim';
      return {
        pos: i + 1, size: st.count, hidden: on ? 'false' : 'true', vis: on ? 'visible' : 'hidden', o: on ? 1 : 0,
        label: 'Band 0' + (i + 1), name: m.name + ' · ' + (sl ? 'Slim' : 'Wide'), cname: m.name, c: m.c, gh: sl ? 5 : 14,
        selStr: k === selKey ? 'true' : 'false', selAria: 'Band ' + (i + 1) + ': ' + m.name + ', ' + (sl ? 'Slim' : 'Wide') + (k === selKey ? ', selected' : '. Select to edit'),
        select: function () { self.setState({ sel: k }); },
        y: i * ROWH + (dragging ? st.dragDy : 0), s: dragging ? 1.015 : 1, z: dragging ? 10 : 1, dragStr: dragging ? 'true' : 'false',
        shadow: dragging ? '0 14px 30px -14px rgba(22,22,22,0.4), 0 0 0 1px #E2DED5' : '',
        tr: dragging ? 'box-shadow 150ms ease' : 'transform 320ms cubic-bezier(.2,.9,.3,1.15), opacity 220ms ease, box-shadow 200ms ease',
        handleAria: 'Reorder band ' + (i + 1) + ', ' + m.name + ' ' + w + '. Drag, or use the arrow keys',
        widthAria: 'Width for band ' + (i + 1), colorAria: 'Color for band ' + (i + 1),
        slimOn: sl ? 'true' : 'false', wideOn: sl ? 'false' : 'true',
        slimBg: sl ? '#FFFFFF' : 'transparent', slimFg: sl ? '#161616' : '#6B675F', slimSh: sl ? '0 1px 2px rgba(22,22,22,.18), 0 0 0 1px rgba(22,22,22,.06)' : 'none',
        wideBg: sl ? 'transparent' : '#FFFFFF', wideFg: sl ? '#6B675F' : '#161616', wideSh: sl ? 'none' : '0 1px 2px rgba(22,22,22,.18), 0 0 0 1px rgba(22,22,22,.06)',
        slim: function () { self.set('wid', k, 'slim'); }, wide: function () { self.set('wid', k, 'wide'); },
        swatches: COLORS.map(function (s) { var sel = s.id === st.col[k]; return { name: s.name, c: s.c, checked: sel ? 'true' : 'false', r1: sel ? 2 : 0, r2: sel ? 3.5 : 0, pick: function () { self.set('col', k, s.id); } }; }),
        down: function (e) { self.dragStart(k, e); }, move: function (e) { self.dragMove(e); }, up: function () { self.dragEnd(); },
        key: function (e) { if (e.key === 'ArrowUp') { e.preventDefault(); self.moveBy(k, -1); } else if (e.key === 'ArrowDown') { e.preventDefault(); self.moveBy(k, 1); } }
      };
    });

    /* Live preview: the same packshot layers; band order, width and color update in place, wrist size widens the stack. */
    /* Live preview. Each band keeps its own layer (keyed k0–k5), so changing count, size, width, color or order
       only moves or re-skins that layer. The stack is anchored to a fixed baseline: the bottom band never moves. */
    var active = st.order.slice(0, st.count), up = active.slice().reverse();
    var lay = bandLayout(up.map(function (k) { return { w: st.wid[k] === 'slim' ? 'S' : 'W' }; }), PVW, PVH, PVFLOOR), kk = lay.k, seatOf = {};
    up.forEach(function (k, j) { seatOf[k] = lay.seats[j]; });
    var botW = st.wid[up[0]] === 'slim' ? 'S' : 'W';
    var pv = { w: PVW, ml: -Math.round(PVW / 2), sx: SX[st.size], shSrc: BAND_SHADOW, shW: Math.round(455 / 360 * PVW), shX: Math.round(-68.9 / 360 * PVW), shY: Math.round(lay.floor - 317.8 / 360 * PVW),
      layers: KEYS.map(function (k) {
        var i = st.order.indexOf(k), on = i < st.count, w = st.wid[k] === 'slim' ? 'S' : 'W', c = st.col[k], dragging = st.dragKey === k;
        var imgs = [];
        CFG.forEach(function (cid) { ['W', 'S'].forEach(function (ww) { var g = BG[ww]; imgs.push({ src: BAND[ww][cid], w: Math.round(g.w * kk * 10) / 10, top: -Math.round(g.h * kk * 10) / 10, dx: g.dx * kk, o: on && cid === c && ww === w ? 1 : 0 }); }); });
        return { key: k, imgs: imgs, z: dragging ? 60 : 50 - i, o: on ? 1 : 0, x: on ? (dragging ? 16 : 0) : 0, y: on ? seatOf[k] : lay.top - 60 };
      }) };
    var total = active.reduce(function (a, k) { return a + (st.wid[k] === 'slim' ? SLIMP : WIDEP); }, 0);
    var preload = [];
    ['W', 'S'].forEach(function (w) { CFG.forEach(function (c) { preload.push(BAND[w][c]); }); });
    var names = active.map(function (k) { return BY[st.col[k]].name + ' ' + (st.wid[k] === 'slim' ? 'Slim' : 'Wide'); });
    var nSlim = active.filter(function (k) { return st.wid[k] === 'slim'; }).length, nWide = st.count - nSlim;
    var widthCount = [nSlim ? nSlim + ' Slim' : '', nWide ? nWide + ' Wide' : ''].filter(Boolean).join(', ');

    var all = [];
    COLORS.forEach(function (m) { all.push({ name: m.name + ' single', price: '$' + SINGLE[m.id], themes: TAGS[m.id], count: 1, wkind: 'both', bands: [[m.id, 'S']], img: SINGLEIMG[m.id], widths: 'Slim or Wide', meta: 'Single band · ' + TAGS[m.id].map(function (t) { return TBY[t].name; }).join(', '), tag: 'Packshot' }); });
    THEMES.forEach(function (t) { t.stacks.forEach(function (bands) { var wl = widthLabel(bands); all.push({ name: t.name + ' ' + bands.length + '-band stack', price: stackPrice(t.id, bands.length), img: PHOTO[t.id + '-' + bands.length], themes: [t.id], count: bands.length, wkind: wl.toLowerCase(), widths: wl, bands: bands, meta: t.name + ' · ' + bands.length + ' bands', tag: 'Stack' }); }); });
    var matched = all.filter(function (p) {
      var wOk = st.fWidth === 'all' || p.wkind === st.fWidth || (p.wkind === 'both' && st.fWidth !== 'mixed');
      return (st.fCount === 'all' || p.count === st.fCount) && (st.fTheme === 'all' || p.themes.indexOf(st.fTheme) >= 0) && wOk;
    });
    var shown = st.showAll ? matched : matched.slice(0, PAGE);
    var products = shown.map(function (p) {
      var isPhoto = !!p.img;
      return { name: p.name, price: p.price, isPhoto: isPhoto, isStack: !isPhoto, img: p.img || '', meta: p.meta, widths: p.widths, tag: p.tag, g: isPhoto ? { w: 0, ml: 0, shY: 0, layers: [] } : stack(p.bands, 230, 320), alt: 'Product image: ' + p.name + ', ' + p.bands.map(function (b) { return BY[b[0]].name + ' ' + (b[1] === 'S' ? 'Slim' : 'Wide'); }).join(', '), aria: 'Add ' + p.name + ' to bag' };
    });
    var groups = [
      { key: 'fSize', label: 'Size', opts: [['all', 'All sizes'], ['S', 'Small'], ['M', 'Medium'], ['L', 'Large']] },
      { key: 'fCount', label: 'Stack count', opts: [['all', 'All'], [1, 'Single'], [2, '2 bands'], [3, '3 bands'], [4, '4 bands'], [5, '5 bands']] },
      { key: 'fWidth', label: 'Width', opts: [['all', 'All'], ['slim', 'Slim'], ['wide', 'Wide'], ['mixed', 'Mixed']] },
      { key: 'fTheme', label: 'Mood', opts: [['all', 'All moods']].concat(THEMES.map(function (t) { return [t.id, t.name]; })) }
    ];
    var fGroups = groups.map(function (g) {
      return { label: g.label, opts: g.opts.map(function (o) { var on = st[g.key] === o[0], u = {}; u[g.key] = o[0]; u.showAll = false; return { label: o[1], checked: on ? 'true' : 'false', fill: on ? 4 : 0, wt: on ? 600 : 400, pick: function () { self.setState(u); } }; }) };
    });
    var activeChips = [];
    groups.forEach(function (g) {
      if (st[g.key] !== 'all') {
        var lbl = g.opts.filter(function (o) { return o[0] === st[g.key]; })[0][1], u = {};
        u[g.key] = 'all';
        activeChips.push({ label: lbl, aria: 'Remove filter ' + g.label + ': ' + lbl, remove: function () { self.setState(u); } });
      }
    });
    var looks = LOOKS.map(function (k) { return { src: PH[k.src], pos: k.pos, alt: k.alt }; });
    var feature = { src: PH[FEATURE.src], pos: FEATURE.pos, alt: FEATURE.alt };
    var footCols = FOOT.map(function (f) { return { title: f.title, col: f.col, links: f.links.map(function (l) { return { label: l[0], href: l[1] }; }) }; });

    return {
      ph: PH, preload: preload, total: '$' + total, slimPrice: '$' + SLIMP, widePrice: '$' + WIDEP, ways: ways, themes: themes, cur: cur, panes: panes,
      ddCount: ddCount, ddSize: ddSize, anyOpen: st.open !== null, closeAll: function () { self.setState({ open: null }); },
      rows: rows, edit: edit, pv: pv, sizeNote: sizeNote, listH: st.count * ROWH, sizeName: sizeName,
      measure: st.measure, measureOpen: st.measure ? 'true' : 'false', toggleMeasure: function () { self.setState({ measure: !self.state.measure }); },
      summaryLine: st.count + ' bands · ' + sizeName, colorLine: names.join(' · '), widthCount: widthCount,
      previewAria: 'Preview: ' + st.count + '-band stack, size ' + sizeName + ', top to bottom: ' + names.join(', '),
      looks: looks, feature: feature, footCols: footCols, stackName: st.count + '-band stack',
      fGroups: fGroups, activeChips: activeChips, hasActive: activeChips.length > 0,
      clearFilters: function () { self.setState({ fSize: 'all', fCount: 'all', fTheme: 'all', fWidth: 'all', showAll: false }); },
      products: products, noResults: matched.length === 0, resultLabel: matched.length + (matched.length === 1 ? ' product' : ' products'),
      canShowMore: matched.length > PAGE, showMoreLabel: st.showAll ? 'Show fewer' : 'Show all ' + matched.length,
      showMore: function () { self.setState({ showAll: !self.state.showAll }); }
    };
  }
}
return { Component: Component, template: "<div style=\"min-height: 100vh; background: #F3F1EC; color: #161616; font-family: 'Instrument Sans', sans-serif; overflow-x: hidden\">\n\n<header style=\"position: sticky; top: 0; z-index: 100; background: rgba(243,241,236,0.94); backdrop-filter: blur(12px)\">\n<div class=\"wrap\" style=\"display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; height: 64px\">\n<a class=\"wordmark\" href=\"#top\" aria-label=\"POPLAB home\">POPLAB</a>\n<nav class=\"navlinks\" aria-label=\"Primary\" style=\"display: flex; gap: 36px\">\n<a class=\"navlink\" href=\"#top\">New &amp; Featured</a>\n<a class=\"navlink\" href=\"#drop\">Shop</a>\n<a class=\"navlink\" href=\"#top\" aria-current=\"page\">MoodBands</a>\n<a class=\"navlink\" href=\"#footer\">About</a>\n</nav>\n<div style=\"display: flex; justify-content: flex-end; gap: 4px\">\n<button class=\"ibtn\" aria-label=\"Search\"><svg width=\"19\" height=\"19\" viewBox=\"0 0 20 20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" aria-hidden=\"true\"><circle cx=\"8.5\" cy=\"8.5\" r=\"5.5\"></circle><path d=\"M12.5 12.5l4.5 4.5\" stroke-linecap=\"round\"></path></svg></button>\n<button class=\"ibtn\" aria-label=\"Account\"><svg width=\"19\" height=\"19\" viewBox=\"0 0 20 20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" aria-hidden=\"true\"><circle cx=\"10\" cy=\"7\" r=\"3.5\"></circle><path d=\"M3.5 17.5c1-3.3 3.4-5 6.5-5s5.5 1.7 6.5 5\" stroke-linecap=\"round\"></path></svg></button>\n<button class=\"ibtn\" aria-label=\"Bag, 0 items\"><svg width=\"19\" height=\"19\" viewBox=\"0 0 20 20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" aria-hidden=\"true\"><path d=\"M4 6.5h12l-1 11H5z\"></path><path d=\"M7.5 6.5V5a2.5 2.5 0 0 1 5 0v1.5\"></path></svg></button>\n</div>\n</div>\n</header>\n\n<main>\n<section id=\"top\" aria-label=\"MoodBands campaign\" style=\"position: relative; height: 720px; overflow: hidden; background: #6FB6DE\">\n<div class=\"push\" style=\"position: absolute; inset: 0\"><img class=\"photo drift\" src=\"{{ph.heroD}}\" alt=\"A raised fist against a sunlit blue wall, the wrist stacked with lime, orange, purple and red MoodBands\" style=\"object-position: 60% 50%\"></div>\n<div aria-hidden=\"true\" style=\"position: absolute; inset: 0; background: linear-gradient(90deg, rgba(14,52,86,0.38) 0%, rgba(14,52,86,0.16) 34%, rgba(14,52,86,0) 55%)\"></div>\n<div class=\"wrap\" style=\"position: relative; height: 100%; display: flex; flex-direction: column; justify-content: center\">\n<div class=\"rise\" style=\"max-width: 460px; color: #FFFFFF; animation-delay: .5s\">\n<h1 class=\"t-hero\" style=\"margin: 0\">Wear your<br><em>mood.</em></h1>\n<p class=\"t-body\" style=\"margin: 22px 0 0; max-width: 340px; font-size: 17px\">Colorful silicone wristbands made to mix, match and stack your way.</p>\n<div style=\"display: flex; align-items: center; gap: 12px; margin-top: 30px\">\n<a class=\"btn btn-primary\" href=\"#drop\">Shop MoodBands</a>\n<a class=\"btn btn-ghost\" href=\"#create\">Create your stack</a>\n</div>\n</div>\n</div>\n</section>\n\n<section id=\"ways\" class=\"wrap\" style=\"padding-top: 128px; padding-bottom: 128px\">\n<h2 class=\"t-h1\" style=\"margin: 0\">Three ways to wear them.</h2>\n<div class=\"g3\" style=\"display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; margin-top: 40px\">\n<sc-for list=\"{{ways}}\" as=\"w\" hint-placeholder-count=\"3\">\n<article class=\"wcard\" style=\"display: flex; flex-direction: column\">\n<a href=\"{{w.href}}\" onClick=\"{{w.go}}\" aria-label=\"{{w.aria}}\" class=\"ph\" style=\"display: block; height: 520px; background: #EAE7E2\">\n<img class=\"photo wimg\" src=\"{{w.life}}\" alt=\"{{w.lifeAlt}}\" style=\"object-position: {{w.pos}}\">\n</a>\n<p class=\"t-h2\" style=\"margin: 18px 0 0; font-size: 20px; line-height: 24px\">{{w.title}}</p>\n<p class=\"t-meta\" style=\"margin: 4px 0 0; font-size: 15px; line-height: 20px\">{{w.copy}}</p>\n<a class=\"tlink tlink-u\" href=\"{{w.href}}\" onClick=\"{{w.go}}\" style=\"margin-top: 16px; align-self: flex-start\">{{w.cta}}<span class=\"arr\" aria-hidden=\"true\">\u2192</span></a>\n</article>\n</sc-for>\n</div>\n</section>\n\n<section id=\"moods\" class=\"wrap sec-white\" style=\"padding-top: 88px; padding-bottom: 128px\">\n<h2 class=\"t-h1\" style=\"margin: 0\">Find your mood.</h2>\n<div role=\"tablist\" aria-label=\"Moods\" style=\"display: flex; gap: 36px; margin-top: 20px\">\n<sc-for list=\"{{themes}}\" as=\"t\" hint-placeholder-count=\"5\">\n<button class=\"mtab\" role=\"tab\" id=\"{{t.tabId}}\" aria-selected=\"{{t.sel}}\" aria-controls=\"mood-panel\" onClick=\"{{t.pick}}\" style=\"color: {{t.fg}}\">{{t.name}}</button>\n</sc-for>\n</div>\n<div id=\"mood-panel\" role=\"tabpanel\" aria-labelledby=\"{{cur.tabId}}\">\n<sc-for list=\"{{panes}}\" as=\"cur\" hint-placeholder-count=\"1\">\n<sc-if value=\"{{cur.on}}\" hint-placeholder-val=\"{{true}}\">\n<div style=\"display: grid; grid-template-columns: 220px repeat(4, minmax(0, 1fr)); gap: 20px; margin-top: 30px; align-items: start\">\n<div class=\"rise\" style=\"display: flex; flex-direction: column; justify-content: center; height: 272px; padding-right: 12px\">\n<p class=\"t-h2\" style=\"margin: 0; font-size: 26px; line-height: 32px\">{{cur.name}}</p>\n<p class=\"t-body\" style=\"margin: 10px 0 0; color: #4E4A43; font-size: 15px; line-height: 24px\" aria-live=\"polite\">{{cur.desc}}</p>\n<a class=\"btn btn-primary\" href=\"#drop\" onClick=\"{{cur.viewAll}}\" style=\"margin-top: 24px; align-self: flex-start\">Shop this mood</a>\n</div>\n<sc-for list=\"{{cur.products}}\" as=\"p\" hint-placeholder-count=\"4\">\n<article class=\"pcard rise\" style=\"animation-delay: {{p.delay}}ms\">\n<div class=\"ph\" style=\"height: 272px; background: #EAE7E2\"><img class=\"photo\" src=\"{{p.img}}\" alt=\"{{p.alt}}\"></div>\n<div style=\"display: flex; justify-content: space-between; gap: 8px; margin-top: 12px\"><span class=\"t-prod\">{{p.name}}</span><span class=\"t-prod\" style=\"font-weight: 600\">{{p.price}}</span></div>\n<span class=\"t-meta\" style=\"margin-top: 2px\">{{p.meta}}</span>\n<button class=\"btn btn-secondary btn-sm\" aria-label=\"{{p.aria}}\" style=\"margin-top: 16px; align-self: flex-start\">Add to bag</button>\n</article>\n</sc-for>\n</div>\n</sc-if>\n</sc-for>\n</div>\n</section>\n\n<section id=\"create\" class=\"sec-white\">\n<div class=\"preload\" aria-hidden=\"true\"><sc-for list=\"{{preload}}\" as=\"u\" hint-placeholder-count=\"2\"><img src=\"{{u}}\" alt=\"\"></sc-for></div>\n<sc-if value=\"{{anyOpen}}\" hint-placeholder-val=\"{{false}}\"><div onClick=\"{{closeAll}}\" aria-hidden=\"true\" style=\"position: fixed; inset: 0; z-index: 40\"></div></sc-if>\n<div class=\"wrap g12\" style=\"display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); column-gap: 48px; padding-top: 88px; padding-bottom: 160px; align-items: stretch\">\n\n<div style=\"grid-column: 1 / span 6; display: flex; flex-direction: column\">\n<div class=\"ph\" role=\"img\" aria-label=\"{{previewAria}}\" style=\"height: 640px; background: #EAE7E2\">\n<div class=\"stk\" aria-hidden=\"true\" style=\"width: {{pv.w}}px; margin-left: {{pv.ml}}px; transform: scaleX({{pv.sx}}); transition: transform 420ms cubic-bezier(.2,.8,.2,1)\">\n<img class=\"bshd\" src=\"{{pv.shSrc}}\" alt=\"\" style=\"width: {{pv.shW}}px; transform: translate({{pv.shX}}px, {{pv.shY}}px)\">\n<sc-for list=\"{{pv.layers}}\" as=\"L\" hint-placeholder-count=\"6\"><div class=\"band\" style=\"z-index: {{L.z}}; opacity: {{L.o}}; transform: translate({{L.x}}px, {{L.y}}px)\"><sc-for list=\"{{L.imgs}}\" as=\"I\" hint-placeholder-count=\"2\"><img src=\"{{I.src}}\" alt=\"\" style=\"left: {{I.dx}}px; top: {{I.top}}px; width: {{I.w}}px; opacity: {{I.o}}\"></sc-for></div></sc-for>\n</div>\n</div>\n</div>\n\n<div style=\"grid-column: 7 / span 6; display: flex; flex-direction: column\">\n<h2 class=\"t-h1\" style=\"margin: 0\">Create your stack.</h2>\n\n<div style=\"display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 24px; position: relative; z-index: 50\">\n<div class=\"dd\">\n<p class=\"t-meta\" id=\"lbl-count\" style=\"margin: 0 0 8px\">Bands</p>\n<button class=\"ddbtn\" aria-haspopup=\"listbox\" aria-expanded=\"{{ddCount.open}}\" aria-labelledby=\"lbl-count\" onClick=\"{{ddCount.toggle}}\"><span>{{ddCount.label}}</span><svg width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" style=\"transform: rotate({{ddCount.rot}}deg); transition: transform .2s\"><path d=\"M4 6l4 4 4-4\"></path></svg></button>\n<sc-if value=\"{{ddCount.isOpen}}\" hint-placeholder-val=\"{{false}}\">\n<div class=\"ddlist\" role=\"listbox\" aria-labelledby=\"lbl-count\">\n<sc-for list=\"{{ddCount.opts}}\" as=\"o\" hint-placeholder-count=\"5\"><button class=\"ddopt\" role=\"option\" aria-selected=\"{{o.sel}}\" onClick=\"{{o.pick}}\" onKeyDown=\"{{o.key}}\" style=\"font-weight: {{o.wt}}\">{{o.label}}<svg width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" style=\"opacity: {{o.chk}}\"><path d=\"M3.5 8.5l3 3 6-7\"></path></svg></button></sc-for>\n</div>\n</sc-if>\n</div>\n<div class=\"dd\">\n<div style=\"display: flex; justify-content: space-between; align-items: baseline; margin: 0 0 8px\">\n<p class=\"t-meta\" id=\"lbl-size\" style=\"margin: 0\">Wrist size</p>\n<button class=\"tlink\" onClick=\"{{toggleMeasure}}\" aria-expanded=\"{{measureOpen}}\" style=\"min-height: 0; font-size: 12px; text-decoration: underline; text-underline-offset: 2px\">Size Help</button>\n</div>\n<button class=\"ddbtn\" aria-haspopup=\"listbox\" aria-expanded=\"{{ddSize.open}}\" aria-labelledby=\"lbl-size\" onClick=\"{{ddSize.toggle}}\"><span>{{ddSize.label}}<span style=\"font-size: 12px\">{{sizeNote}}</span></span><svg width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" style=\"transform: rotate({{ddSize.rot}}deg); transition: transform .2s\"><path d=\"M4 6l4 4 4-4\"></path></svg></button>\n<sc-if value=\"{{ddSize.isOpen}}\" hint-placeholder-val=\"{{false}}\">\n<div class=\"ddlist\" role=\"listbox\" aria-labelledby=\"lbl-size\">\n<sc-for list=\"{{ddSize.opts}}\" as=\"o\" hint-placeholder-count=\"3\"><button class=\"ddopt\" role=\"option\" aria-selected=\"{{o.sel}}\" onClick=\"{{o.pick}}\" onKeyDown=\"{{o.key}}\" style=\"font-weight: {{o.wt}}\">{{o.label}}<svg width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" style=\"opacity: {{o.chk}}\"><path d=\"M3.5 8.5l3 3 6-7\"></path></svg></button></sc-for>\n</div>\n</sc-if>\n</div>\n</div>\n<sc-if value=\"{{measure}}\" hint-placeholder-val=\"{{false}}\">\n<p class=\"t-meta\" style=\"margin: 12px 0 0; padding: 10px 14px; background: #F3F1EC; border-radius: 8px\">Wrap a soft tape measure around your wrist just above the wrist bone. The size chart will be published with the drop.</p>\n</sc-if>\n\n<div style=\"margin-top: 24px\">\n<div role=\"list\" aria-label=\"Your bands, top to bottom. Select a band to change it; drag to reorder.\" style=\"position: relative; height: {{listH}}px; transition: height 300ms ease\">\n<sc-for list=\"{{rows}}\" as=\"r\" hint-placeholder-count=\"6\">\n<div class=\"crow\" role=\"listitem\" data-drag=\"{{r.dragStr}}\" data-sel=\"{{r.selStr}}\" aria-posinset=\"{{r.pos}}\" aria-setsize=\"{{r.size}}\" aria-hidden=\"{{r.hidden}}\" style=\"position: absolute; left: 0; right: 0; top: 0; height: 52px; display: flex; align-items: center; gap: 4px; padding: 0 4px; box-shadow: {{r.shadow}}; transform: translateY({{r.y}}px) scale({{r.s}}); opacity: {{r.o}}; visibility: {{r.vis}}; z-index: {{r.z}}; transition: {{r.tr}}\">\n<button class=\"handle\" aria-label=\"{{r.handleAria}}\" onPointerDown=\"{{r.down}}\" onPointerMove=\"{{r.move}}\" onPointerUp=\"{{r.up}}\" onPointerCancel=\"{{r.up}}\" onKeyDown=\"{{r.key}}\"><svg width=\"10\" height=\"16\" viewBox=\"0 0 10 16\" fill=\"currentColor\" aria-hidden=\"true\"><circle cx=\"2.5\" cy=\"2.5\" r=\"1.4\"></circle><circle cx=\"7.5\" cy=\"2.5\" r=\"1.4\"></circle><circle cx=\"2.5\" cy=\"8\" r=\"1.4\"></circle><circle cx=\"7.5\" cy=\"8\" r=\"1.4\"></circle><circle cx=\"2.5\" cy=\"13.5\" r=\"1.4\"></circle><circle cx=\"7.5\" cy=\"13.5\" r=\"1.4\"></circle></svg></button>\n<button class=\"rsel\" aria-pressed=\"{{r.selStr}}\" aria-label=\"{{r.selAria}}\" onClick=\"{{r.select}}\">\n<span aria-hidden=\"true\" style=\"width: 56px; height: 18px; display: flex; align-items: center; flex: none\"><span style=\"display: block; width: 56px; height: {{r.gh}}px; border-radius: 999px; background-color: {{r.c}}; box-shadow: inset 0 0 0 1px rgba(22,22,22,0.12), inset 0 -1px 0 rgba(0,0,0,.12); transition: height .3s cubic-bezier(.3,1.3,.5,1), background-color .3s\"></span></span>\n<span>{{r.cname}}</span>\n</button>\n</div>\n</sc-for>\n</div>\n<div style=\"display: flex; align-items: center; gap: 60px; margin-top: 20px; padding: 16px; background: #FAF7EF; border-radius: 16px\">\n<div role=\"radiogroup\" aria-label=\"{{edit.widthAria}}\" style=\"display: flex; gap: 8px; flex: none\">\n<button class=\"wpick\" role=\"radio\" aria-checked=\"{{edit.slimOn}}\" aria-label=\"Slim\" title=\"Slim\" onClick=\"{{edit.slim}}\"><span aria-hidden=\"true\" style=\"display: block; width: 40px; height: 5px; border-radius: 999px; background: {{edit.c}}; box-shadow: inset 0 0 0 1px rgba(22,22,22,0.15)\"></span></button>\n<button class=\"wpick\" role=\"radio\" aria-checked=\"{{edit.wideOn}}\" aria-label=\"Wide\" title=\"Wide\" onClick=\"{{edit.wide}}\"><span aria-hidden=\"true\" style=\"display: block; width: 40px; height: 14px; border-radius: 999px; background: {{edit.c}}; box-shadow: inset 0 0 0 1px rgba(22,22,22,0.15)\"></span></button>\n</div>\n<div role=\"radiogroup\" aria-label=\"{{edit.colorAria}}\" style=\"display: flex; flex-wrap: wrap; gap: 8px\">\n<sc-for list=\"{{edit.swatches}}\" as=\"s\" hint-placeholder-count=\"10\"><button class=\"sw\" role=\"radio\" aria-checked=\"{{s.checked}}\" aria-label=\"{{s.name}}\" title=\"{{s.name}}\" onClick=\"{{s.pick}}\" style=\"background: {{s.c}}; box-shadow: inset 0 0 0 1px rgba(22,22,22,0.14), 0 0 0 {{s.r1}}px #ECE9E2, 0 0 0 {{s.r2}}px #161616\"></button></sc-for>\n</div>\n</div>\n</div>\n\n<div style=\"margin-top: auto; padding-top: 20px\">\n<div style=\"display: flex; align-items: center; gap: 32px; padding-top: 8px\" aria-live=\"polite\">\n<div style=\"flex: 1; min-width: 0\"><p class=\"t-prod\" style=\"margin: 0; font-size: 16px\">{{stackName}}</p><p class=\"t-meta\" style=\"margin: 2px 0 0; font-size: 14px\">{{sizeName}}</p></div>\n<div style=\"text-align: right\"><p class=\"t-meta\" style=\"margin: 0\">Total</p><p class=\"t-h2\" style=\"margin: 0; font-size: 26px; line-height: 28px; font-weight: 600\">{{total}}</p></div>\n<button class=\"btn btn-primary\" style=\"height: 52px; padding: 0 32px; font-size: 15px\">Buy your stack</button>\n</div>\n</div>\n</div>\n</div>\n</section>\n\n<section id=\"style\" class=\"wrap sec-white\" style=\"padding-bottom: 128px\">\n<div style=\"display: flex; justify-content: space-between; align-items: flex-end; gap: 40px\">\n<h2 class=\"t-h1\" style=\"margin: 0\">Style it.</h2>\n<p class=\"t-body\" style=\"margin: 0; font-size: 15px; line-height: 24px; color: #4E4A43\">Ways to wear MoodBands, on their own or stacked.</p>\n</div>\n<figure class=\"ph\" style=\"height: 600px; margin-top: 32px; background: #E6E2D9\"><img class=\"photo look\" src=\"{{feature.src}}\" alt=\"{{feature.alt}}\" style=\"object-position: {{feature.pos}}\"></figure>\n<div class=\"g3\" style=\"display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; margin-top: 32px\">\n<sc-for list=\"{{looks}}\" as=\"k\" hint-placeholder-count=\"3\">\n<figure class=\"ph\" style=\"height: 480px; background: #E6E2D9\"><img class=\"photo look\" src=\"{{k.src}}\" alt=\"{{k.alt}}\" style=\"object-position: {{k.pos}}\"></figure>\n</sc-for>\n</div>\n</section>\n\n<section id=\"drop\" class=\"wrap sec-white\" style=\"padding-bottom: 126px\">\n<div style=\"display: flex; justify-content: space-between; align-items: flex-end; gap: 40px\">\n<h2 class=\"t-h1\" style=\"margin: 0\">The MoodBands drop.</h2>\n<p class=\"t-meta\" style=\"margin: 0; max-width: 320px; font-size: 14px\">Singles and curated stacks in Slim and Wide.</p>\n</div>\n<div class=\"shop\" style=\"display: flex; gap: 48px; margin-top: 48px; align-items: flex-start\">\n<aside aria-label=\"Filters\" style=\"flex: 0 0 200px; display: flex; flex-direction: column; gap: 30px\">\n<sc-for list=\"{{fGroups}}\" as=\"g\" hint-placeholder-count=\"4\">\n<div role=\"radiogroup\" aria-label=\"{{g.label}}\" style=\"display: flex; flex-direction: column\">\n<p class=\"t-label\" style=\"margin: 0 0 6px\">{{g.label}}</p>\n<sc-for list=\"{{g.opts}}\" as=\"o\" hint-placeholder-count=\"4\">\n<button class=\"fopt\" role=\"radio\" aria-checked=\"{{o.checked}}\" onClick=\"{{o.pick}}\"><span aria-hidden=\"true\" style=\"width: 16px; height: 16px; border-radius: 50%; box-shadow: inset 0 0 0 1px #161616, inset 0 0 0 {{o.fill}}px #161616; flex: none\"></span><span style=\"font-weight: {{o.wt}}\">{{o.label}}</span></button>\n</sc-for>\n</div>\n</sc-for>\n</aside>\n<div style=\"flex: 1; min-width: 0\">\n<span class=\"sr-only\" aria-live=\"polite\">{{resultLabel}}</span>\n<sc-if value=\"{{hasActive}}\" hint-placeholder-val=\"{{false}}\">\n<div style=\"display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; min-height: 36px; margin-bottom: 18px\">\n<div style=\"display: flex; flex-wrap: wrap; gap: 6px; align-items: center\">\n<sc-for list=\"{{activeChips}}\" as=\"a\" hint-placeholder-count=\"2\"><button class=\"achip\" onClick=\"{{a.remove}}\" aria-label=\"{{a.aria}}\">{{a.label}}<svg width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" aria-hidden=\"true\"><path d=\"M5 5l6 6M11 5l-6 6\"></path></svg></button></sc-for>\n<button class=\"tlink\" onClick=\"{{clearFilters}}\" style=\"padding: 0 6px; font-size: 13px; min-height: 32px\">Clear all</button>\n</div>\n<span class=\"t-meta\" aria-hidden=\"true\">{{resultLabel}}</span>\n</div>\n</sc-if>\n<sc-if value=\"{{noResults}}\" hint-placeholder-val=\"{{false}}\"><p class=\"t-h2\" style=\"margin: 32px 0 0; color: #6B675F\">Nothing matches those filters yet.</p></sc-if>\n<div class=\"g3\" style=\"display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 32px 20px\">\n<sc-for list=\"{{products}}\" as=\"c\" hint-placeholder-count=\"9\">\n<article class=\"pcard\">\n<div class=\"ph\" role=\"img\" aria-label=\"{{c.alt}}\" style=\"height: 320px; background: #EAE7E2\">\n<sc-if value=\"{{c.isPhoto}}\" hint-placeholder-val=\"{{true}}\"><img class=\"photo\" src=\"{{c.img}}\" alt=\"\"></sc-if>\n<sc-if value=\"{{c.isStack}}\" hint-placeholder-val=\"{{false}}\"><div class=\"stk\" aria-hidden=\"true\" style=\"width: {{c.g.w}}px; margin-left: {{c.g.ml}}px\">\n<img class=\"shd\" src=\"assets/images/photos/4c7eb7491e8e4dde19e34ad7ac97fbc2.webp\" alt=\"\" style=\"top: {{c.g.shY}}px; width: {{c.g.w}}px\">\n<sc-for list=\"{{c.g.layers}}\" as=\"L\" hint-placeholder-count=\"1\"><img src=\"{{L.src}}\" alt=\"\" style=\"top: {{L.y}}px; width: {{L.w}}px; z-index: {{L.z}}\"></sc-for>\n</div></sc-if>\n</div>\n<div style=\"display: flex; justify-content: space-between; gap: 12px; margin-top: 12px\">\n<span class=\"t-prod\">{{c.name}}</span>\n<span class=\"t-prod\" style=\"font-weight: 600\">{{c.price}}</span>\n</div>\n<span class=\"t-meta\" style=\"margin-top: 2px\">{{c.meta}}</span>\n<span class=\"t-meta\">{{c.widths}} \u00b7 Sizes S \u00b7 M \u00b7 L</span>\n<button class=\"btn btn-secondary\" style=\"height: 38px; margin-top: 16px; align-self: flex-start; font-size: 13px; padding: 0 18px\" aria-label=\"{{c.aria}}\">Add to bag</button>\n</article>\n</sc-for>\n</div>\n<sc-if value=\"{{canShowMore}}\" hint-placeholder-val=\"{{true}}\">\n<div style=\"display: flex; justify-content: center; margin-top: 44px\"><button class=\"btn btn-primary\" onClick=\"{{showMore}}\">{{showMoreLabel}}</button></div>\n</sc-if>\n</div>\n</div>\n</section>\n\n<section aria-label=\"Change your mood\" style=\"position: relative; overflow: hidden; background: #FFFFFF\">\n<img class=\"photo\" src=\"{{ph.bannerArms}}\" alt=\"Four arms reaching in from the right, wearing red, lime, orange and yellow MoodBands\" style=\"object-position: 100% 50%\">\n<div aria-hidden=\"true\" style=\"position: absolute; inset: 0; background: rgba(0,0,0,0.03)\"></div>\n<div class=\"banner-in\" style=\"position: relative; max-width: 1440px; margin: 0 auto; display: flex; flex-direction: column; justify-content: center; min-height: 700px\">\n<div style=\"width: 100%; max-width: 516px; display: flex; flex-direction: column\">\n<h2 class=\"t-hero\" style=\"margin: 0; font-size: 60px; line-height: 60px\">Change your mood.<br><em>Change your stack.</em></h2>\n<p class=\"t-body\" style=\"margin: 25px 0 0; color: #4E4A43; text-align: center; line-height: 26px\">Swap a band, add one, start again tomorrow.</p>\n<a class=\"btn btn-primary\" href=\"#drop\" style=\"margin-top: 25px; align-self: center\">Shop MoodBands</a>\n</div>\n</div>\n</section>\n</main>\n\n<footer id=\"footer\" style=\"background: #EAE6DE\">\n<div class=\"wrap g12\" style=\"display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); column-gap: 24px; padding-top: 56px; padding-bottom: 48px\">\n<div style=\"grid-column: 1 / span 4\">\n<a class=\"wordmark\" href=\"#top\" style=\"font-size: 26px\">POPLAB</a>\n</div>\n<sc-for list=\"{{footCols}}\" as=\"f\" hint-placeholder-count=\"4\">\n<nav aria-label=\"{{f.title}}\" style=\"grid-column: {{f.col}}; display: flex; flex-direction: column\">\n<p class=\"t-label\" style=\"margin: 0 0 12px; color: #6B675F\">{{f.title}}</p>\n<sc-for list=\"{{f.links}}\" as=\"l\" hint-placeholder-count=\"3\"><a class=\"flink\" href=\"{{l.href}}\">{{l.label}}</a></sc-for>\n</nav>\n</sc-for>\n</div>\n<div class=\"wrap\" style=\"display: flex; justify-content: space-between; align-items: center; gap: 24px; padding-top: 18px; padding-bottom: 24px\">\n<p class=\"t-meta\" style=\"margin: 0\">\u00a9 POPLAB</p>\n<div style=\"display: flex; gap: 24px\"><a class=\"flink\" href=\"#footer\" style=\"font-size: 13px; color: #6B675F\">Privacy</a><a class=\"flink\" href=\"#footer\" style=\"font-size: 13px; color: #6B675F\">Terms</a></div>\n</div>\n</footer>\n</div>" };
})();

/* ===== Mobile view ===== */
var MobileView = (function () {
var COLORS = [
  ['hotpink', 'Hot Pink', '#FF3E8A'], ['red', 'Red', '#E8243D'], ['orange', 'Orange', '#FF6A1A'], ['yellow', 'Yellow', '#FFD21A'], ['lime', 'Lime', '#9EE02F'],
  ['blue', 'Blue', '#2F6BFF'], ['lavender', 'Lavender', '#B7A2FF'], ['purple', 'Purple', '#7B3FE4'], ['pink', 'Pink', '#FFA3C9'], ['white', 'White', '#F7F5EF']
].map(function (r) { return { id: r[0], name: r[1], c: r[2] }; });
var BY = {};
COLORS.forEach(function (m) { BY[m.id] = m; });
function hx(h) { var x = parseInt(h.slice(1), 16); return [(x >> 16) & 255, (x >> 8) & 255, x & 255]; }
function toHex(a) { return '#' + a.map(function (v) { var s = Math.round(v).toString(16); return s.length < 2 ? '0' + s : s; }).join('').toUpperCase(); }
function mix(a, b, t) { var x = hx(a), y = hx(b); return toHex(x.map(function (v, i) { return v * (1 - t) + y[i] * t; })); }
function tone(ids, k) { var s = [0, 0, 0]; ids.forEach(function (id) { var c = hx(BY[id].c); s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; }); return mix(toHex(s.map(function (v) { return v / ids.length; })), '#E9E5DD', k || 0.88); }

/* Product images: one studio packshot, recolored per colorway; Slim is cut from the same shot so proportions never drift.
   [0] = band on top of a stack (open), [1] = band lower in a stack (opening in shadow). */
var IMG = {
  W: { blue: ['', ''], hotpink: ['', ''], lavender: ['', ''], lime: ['', ''], orange: ['', ''], pink: ['', ''], purple: ['', ''], red: ['', ''], white: ['', ''], yellow: ['', ''] },
  S: { blue: ['', ''], hotpink: ['', ''], lavender: ['', ''], lime: ['', ''], orange: ['', ''], pink: ['', ''], purple: ['', ''], red: ['', ''], white: ['', ''], yellow: ['', ''] }
};
var SHADOW = 'assets/images/photos/4c7eb7491e8e4dde19e34ad7ac97fbc2.webp';
/* Supplied MoodBands band images (Figma Assets page). Wide 720x463, Slim 714x398 at source; both share the rim line,
   so a band sits on the one below with its bottom edge on that band's front rim. */
var BAND = {
  W: { hotpink: 'assets/images/bands/W-hotpink.webp', red: 'assets/images/bands/W-red.webp', orange: 'assets/images/bands/W-orange.webp', yellow: 'assets/images/bands/W-yellow.webp', lime: 'assets/images/bands/W-lime.webp', blue: 'assets/images/bands/W-blue.webp', lavender: 'assets/images/bands/W-lavender.webp', purple: 'assets/images/bands/W-purple.webp', pink: 'assets/images/bands/W-pink.webp' },
  S: { hotpink: 'assets/images/bands/S-hotpink.webp', red: 'assets/images/bands/S-red.webp', orange: 'assets/images/bands/S-orange.webp', yellow: 'assets/images/bands/S-yellow.webp', lime: 'assets/images/bands/S-lime.webp', blue: 'assets/images/bands/S-blue.webp', lavender: 'assets/images/bands/S-orchid.webp', purple: 'assets/images/bands/S-purple.webp', pink: 'assets/images/bands/S-orchid.webp' }
};
var BAND_SHADOW = 'assets/images/bands/shadow.webp';
var BG = { W: { w: 720, h: 463, rim: 329.5, dx: 0 }, S: { w: 714, h: 398, rim: 329.5, dx: 3.2 } };
var CFG = ['hotpink', 'red', 'orange', 'yellow', 'lime', 'blue', 'lavender', 'purple', 'pink'];
/* Live preview geometry: each band layer is anchored at its seat line (its bottom edge). */
function bandLayout(bands, dispW, boxH, minFloor) {
  var k = dispW / 720, hs = bands.map(function (b) { return BG[b.w].h * k; }), H = hs[0], i;
  for (i = 1; i < bands.length; i++) H += (BG[bands[i].w].h - BG[bands[i].w].rim) * k;
  var floor = Math.max(minFloor, Math.round((boxH + H) / 2)), seats = [], seat = floor;
  for (i = 0; i < bands.length; i++) { seats.push(seat); seat = seat - hs[i] + BG[bands[i].w].rim * k; }
  return { floor: floor, seats: seats, top: seat - (BG.W.h - BG.W.rim) * k, k: k };
}
/* Studio product photographs, one per curated stack (theme + band count). */
var PHOTO = {
  'everyday-2': 'assets/images/photos/83cfd4d54b56cba959c38cb8e8d2f872.webp', 'everyday-3': 'assets/images/photos/6b3787220fae01fcb7fa44bee208c2e0.webp', 'everyday-4': 'assets/images/photos/eaee7358449ee337e5a8bc472d57e3f1.webp', 'everyday-5': 'assets/images/photos/eb3c2f9c00f6a734f0feb759d163e246.webp',
  'festive-2': 'assets/images/photos/ddf31252ad8a982e673a5b3c0d502394.webp', 'festive-3': 'assets/images/photos/77fa6a013f9584f37559c5349126f221.webp', 'festive-4': 'assets/images/photos/737a7ef263d6533b3cd92f4332b7473e.webp', 'festive-5': 'assets/images/photos/b3d8912248f92ec6965b5e5c7e504e50.webp',
  'gym-2': 'assets/images/photos/8a344c849d66fe6598c9a13aa3ed016e.webp', 'gym-3': 'assets/images/photos/1a3639f7a2062e75ba0d7daa3fc46e6e.webp', 'gym-4': 'assets/images/photos/1994756b6d7c80bda2dedc5678917171.webp', 'gym-5': 'assets/images/photos/ca7d7f51bd854a49e1cf71cab523baad.webp',
  'summer-2': 'assets/images/photos/f4ca9cbcda9643df09b91cad28cb24d4.webp', 'summer-3': 'assets/images/photos/e016f09b428990f54aa125eac592866c.webp', 'summer-4': 'assets/images/photos/7d33e8837d98170f4ed730482dd07fbc.webp', 'summer-5': 'assets/images/photos/c5d6ee713fe7a9d69ad3a2f25a90a717.webp',
  'beach-2': 'assets/images/photos/54dcb565c5dffbe0b6e69b24686e7045.webp', 'beach-3': 'assets/images/photos/b6bc09f23e686670876afd4ece41d448.webp', 'beach-4': 'assets/images/photos/9c4c170490fe3770fa0a06c9f04a3df5.webp', 'beach-5': 'assets/images/photos/12f76f21f6854ec06e4dc03e1ffe0059.webp'
};
/* Illustrative prices. */
var BASE = { 2: 16, 3: 22, 4: 28, 5: 34 }, TADJ = { everyday: 0, festive: 2, gym: -1, summer: 1, beach: 0 };
function stackPrice(theme, n) { return '$' + (BASE[n] + TADJ[theme]); }
var SINGLE = { hotpink: 9, red: 9, orange: 8, yellow: 8, lime: 8, blue: 9, lavender: 10, purple: 9, pink: 10, white: 8 };
var SLIMP = 7, WIDEP = 9;

/* Real photography (licensed stock, bands retouched to MoodBands colors) and studio singles. */
var REAL = { heroD: 'assets/images/photos/heroD.jpg', heroM: 'assets/images/photos/heroM.jpg', bannerArms: 'assets/images/photos/bannerD.jpg', bannerM: 'assets/images/photos/bannerM.jpg',
  wOne: 'assets/images/photos/wOne.jpg', wReady: 'assets/images/photos/wReady.jpg', wOwn: 'assets/images/photos/wOwn.jpg',
  sHold: 'assets/images/photos/sHold.jpg', sFace: 'assets/images/photos/sFace.jpg', sCross: 'assets/images/photos/sCross.jpg', sFists: 'assets/images/photos/sFists.jpg' };
var SINGLEIMG = { hotpink: 'assets/images/photos/4cbc64f2712af7b4295fa2a81d06b082.webp', red: 'assets/images/photos/2b0656f2c71a7aa7feb5e262cffcbe07.webp', orange: 'assets/images/photos/6ca342318e9af4d2c56cf450822f5fbf.webp', yellow: 'assets/images/photos/681516cb1b992bb532ffea685a5d17d4.webp', lime: 'assets/images/photos/915fc8728998c3cddefb2cfa1c0b05db.webp',
  blue: 'assets/images/photos/5f89a4125e60aba4dbf2747d5f390b76.webp', lavender: 'assets/images/photos/1ef0df58f572684af728f6ee4df7a452.webp', purple: 'assets/images/photos/7b788d1952bb17680a8e9e41e3998add.webp', pink: 'assets/images/photos/1f8ee4ad4c2c6cabed02924ba65c8c76.webp', white: 'assets/images/photos/ec5da4be48acee599ce80d137e41e6ed.webp' };
var PH = {
  hero: '', curated: '', build: '',
  single: '', pair: '', stack: '', banner: '',
  hero1: '', hero2: '', hero3: '', hero4: '', banner2: '',
  street: '', phone: '', bike: '', cafe: '',
  pSingle: 'assets/images/photos/7cc975fbf7ba178b4e954bcb5d9ae249.webp', pCurated: 'assets/images/photos/d46cbfe298b48ca3a1f9a4608cc44d3d.webp', pBuild: 'assets/images/photos/0e5548d05f7689e16b5d5dfd5fc99cc3.webp',
  heroD: REAL.heroD, heroM: REAL.heroM, bannerArms: REAL.bannerArms, bannerM: REAL.bannerM, sHold: REAL.sHold, sFace: REAL.sFace, sCross: REAL.sCross, sFists: REAL.sFists,
  everyday: '', festive: '', gym: '', summer: '', beach: ''
};
/* Source frame 600 x 364; a band above sits higher by its own wall height: Wide 100, Slim 39 (about 10 mm vs 3.5 mm). */
var RW = 600, RH = 364, SHH = 386, OFF = { W: 100, S: 39 };
function stack(bands, dispW, boxH) {
  var s = dispW / RW, ih = Math.round(RH * s), above = 0, i;
  for (i = 0; i < bands.length - 1; i++) above += OFF[bands[i][1]] * s;
  var y = Math.round((boxH - ih - above) / 2 - boxH * 0.02);
  var layers = bands.map(function (b, j) { var L = { src: IMG[b[1]][b[0]][j === 0 ? 0 : 1], y: Math.round(y), z: 20 - j, w: dispW }; y += OFF[b[1]] * s; return L; });
  return { w: dispW, ml: -Math.round(dispW / 2), shY: layers[layers.length - 1].y, layers: layers };
}
function widthLabel(bands) { var s = bands.filter(function (b) { return b[1] === 'S'; }).length; return s === bands.length ? 'Slim' : (s === 0 ? 'Wide' : 'Mixed'); }

var THEMES = [
  { id: 'everyday', alt: 'a hand on a tote strap, three bands under a denim cuff', name: 'Everyday', desc: 'Versatile colors that go with what you already wear.', stacks: [
    [['lavender', 'W'], ['white', 'S']], [['blue', 'S'], ['white', 'W'], ['lavender', 'S']], [['lavender', 'W'], ['pink', 'S'], ['white', 'S'], ['blue', 'W']], [['white', 'S'], ['blue', 'S'], ['lavender', 'W'], ['pink', 'S'], ['white', 'S']]] },
  { id: 'festive', alt: 'a raised glass at a party, four bands under string lights', name: 'Festive', desc: 'Bold, celebratory color for big nights and big days.', stacks: [
    [['hotpink', 'W'], ['yellow', 'S']], [['red', 'W'], ['yellow', 'S'], ['purple', 'W']], [['red', 'W'], ['yellow', 'S'], ['purple', 'S'], ['hotpink', 'W']], [['hotpink', 'S'], ['red', 'W'], ['orange', 'S'], ['yellow', 'W'], ['purple', 'S']]] },
  { id: 'gym', alt: 'a hand on a water bottle after training, two Wide bands', name: 'Gym', desc: 'Energetic, sporty color that keeps up with you.', stacks: [
    [['lime', 'W'], ['blue', 'W']], [['lime', 'S'], ['orange', 'W'], ['white', 'S']], [['blue', 'W'], ['lime', 'W'], ['white', 'W'], ['orange', 'W']], [['lime', 'S'], ['blue', 'S'], ['orange', 'S'], ['white', 'S'], ['lime', 'S']]] },
  { id: 'summer', alt: 'an arm on a sunny cafe table, a bright three-band stack', name: 'Summer', desc: 'Bright, playful colors for long days outside.', stacks: [
    [['yellow', 'S'], ['orange', 'S']], [['yellow', 'S'], ['hotpink', 'W'], ['orange', 'S']], [['hotpink', 'W'], ['yellow', 'S'], ['lime', 'S'], ['orange', 'W']], [['yellow', 'W'], ['orange', 'S'], ['hotpink', 'W'], ['pink', 'S'], ['lime', 'W']]] },
  { id: 'beach', alt: 'a wrist on a striped beach towel, three bands with sand on skin', name: 'Beach', desc: 'Relaxed, colorful and easy to swap around.', stacks: [
    [['blue', 'W'], ['white', 'S']], [['blue', 'W'], ['yellow', 'S'], ['white', 'W']], [['blue', 'S'], ['lime', 'S'], ['yellow', 'S'], ['white', 'S']], [['white', 'S'], ['blue', 'W'], ['yellow', 'S'], ['lime', 'S'], ['blue', 'S']]] }
];
var TBY = {};
THEMES.forEach(function (t) { TBY[t.id] = t; });
var TAGS = { hotpink: ['summer', 'festive'], red: ['festive'], orange: ['summer', 'gym', 'festive'], yellow: ['summer', 'beach', 'festive'], lime: ['gym', 'summer', 'beach'], blue: ['everyday', 'beach', 'gym'], lavender: ['everyday'], purple: ['festive'], pink: ['everyday', 'summer'], white: ['everyday', 'beach', 'gym'] };
var SIZES = [['S', 'Small'], ['M', 'Medium'], ['L', 'Large']];
var COUNTS = [2, 3, 4, 5, 6];
var KEYS = ['k0', 'k1', 'k2', 'k3', 'k4', 'k5'];
var ROWH = 56;
var PVW = 180, PVBASE = 0, PVFLOOR = 215, SX = { S: 0.94, M: 1, L: 1.06 };
var PVH = 290;
var HERO = [['hotpink', 'W'], ['yellow', 'S'], ['blue', 'W'], ['lime', 'S']];
var FEATURE = { src: 'sFists', pos: '50% 45%', alt: 'Friends bumping fists in a circle, wrists wearing yellow, pink, purple, lime and red MoodBands' };
var LOOKS = [
  { src: 'sHold', pos: '50% 50%', alt: 'Point-of-view photo: holding a friend\'s hand across a park lawn, a blue MoodBand on the wrist' },
  { src: 'sFace', pos: '35% 50%', alt: 'Close portrait: a hand raised across the face, one orange MoodBand on the wrist' },
  { src: 'sCross', pos: '45% 40%', alt: 'Hands resting on a chair back, a lime MoodBand on one wrist' }
];
var FOOT = [
  { title: 'Shop', links: [['New & Featured', '#m-top'], ['MoodBands', '#m-top'], ['All Products', '#m-drop']] },
  { title: 'Help', links: [['Shipping', '#m-footer'], ['Returns', '#m-footer'], ['Contact', '#m-footer']] },
  { title: 'About', links: [['About POPLAB', '#m-footer'], ['Our Story', '#m-footer']] },
  { title: 'Social', links: [['Instagram', '#m-footer'], ['TikTok', '#m-footer']] }
];
var PAGE = 6;

class Component extends window.DCLogic {
  constructor(props) {
    super(props);
    this.state = {
      theme: 'everyday', count: 4, size: 'M', order: KEYS.slice(),
      col: { k0: 'hotpink', k1: 'yellow', k2: 'blue', k3: 'lime', k4: 'orange', k5: 'lavender' },
      wid: { k0: 'wide', k1: 'slim', k2: 'wide', k3: 'slim', k4: 'wide', k5: 'slim' },
      open: null, menu: false, measure: false, dragKey: null, dragDy: 0, sel: 'k0',
      fSize: 'all', fCount: 'all', fTheme: 'all', fWidth: 'all', showAll: false, sheet: false
    };
    this.drag = null;
  }
  set(field, key, val) { var o = Object.assign({}, this.state[field]); o[key] = val; var u = {}; u[field] = o; this.setState(u); }
  moveBy(key, dir) {
    var o = this.state.order.slice(), i = o.indexOf(key), j = i + dir;
    if (j < 0 || j >= this.state.count) return;
    o[i] = o[j]; o[j] = key;
    this.setState({ order: o });
  }
  dragStart(key, e) {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
    this.drag = { key: key, y0: e.clientY };
    this.setState({ dragKey: key, dragDy: 0 });
  }
  dragMove(e) {
    var d = this.drag;
    if (!d) return;
    var dy = e.clientY - d.y0, o = this.state.order.slice(), i = o.indexOf(d.key);
    while (dy > ROWH / 2 && i < this.state.count - 1) { o[i] = o[i + 1]; o[i + 1] = d.key; i++; d.y0 += ROWH; dy -= ROWH; }
    while (dy < -ROWH / 2 && i > 0) { o[i] = o[i - 1]; o[i - 1] = d.key; i--; d.y0 -= ROWH; dy += ROWH; }
    this.setState({ order: o, dragDy: dy });
  }
  dragEnd() { this.drag = null; this.setState({ dragKey: null, dragDy: 0 }); }
  customize(bands) {
    var c = Object.assign({}, this.state.col), w = Object.assign({}, this.state.wid), o = this.state.order;
    bands.forEach(function (b, i) { c[o[i]] = b[0]; w[o[i]] = b[1] === 'S' ? 'slim' : 'wide'; });
    this.setState({ col: c, wid: w, count: bands.length, open: null });
  }
  dropdown(id, label, opts, cur, pick) {
    var self = this, isOpen = this.state.open === id;
    return {
      label: label, isOpen: isOpen, open: isOpen ? 'true' : 'false', rot: isOpen ? 180 : 0,
      toggle: function () { self.setState({ open: self.state.open === id ? null : id }); },
      opts: opts.map(function (o) {
        var on = o[0] === cur;
        return { label: o[1], sel: on ? 'true' : 'false', chk: on ? 1 : 0, wt: on ? 600 : 400,
          pick: function () { pick(o[0]); self.setState({ open: null }); },
          key: function (e) { if (e.key === 'Escape') { e.preventDefault(); self.setState({ open: null }); } } };
      })
    };
  }
  renderVals() {
    var self = this, st = this.state;

    var ways = [
      { title: 'One band', copy: 'Keep it simple. One band, one statement.', life: REAL.wOne, pos: '50% 30%', lifeAlt: 'A hand gathering dark hair, one red MoodBand on the wrist', aria: 'Shop singles', cta: 'Shop Singles', href: '#m-drop', go: function () { self.setState({ fCount: 1, fTheme: 'all', fWidth: 'all', showAll: false }); } },
      { title: 'Ready-made stack', copy: 'Good combinations, already figured out.', life: REAL.wReady, pos: '55% 55%', lifeAlt: 'A wet hand on a pool edge wearing a magenta and a lime MoodBand together', aria: 'Shop ready-made stacks', cta: 'Shop Stacks', href: '#m-moods', go: function () {} },
      { title: 'Make your own', copy: 'Choose your colours and build your stack.', life: REAL.wOwn, pos: '40% 40%', lifeAlt: 'A wrist on a wooden table wearing a big mixed stack of colorful bands', aria: 'Build your own stack', cta: 'Build Yours', href: '#m-create', go: function () {} }
    ];

    var themes = THEMES.map(function (t) {
      var on = st.theme === t.id;
      return { name: t.name, tabId: 'm-tab-' + t.id, sel: on ? 'true' : 'false', fg: on ? '#161616' : '#8A857B', pick: function () { self.setState({ theme: t.id }); } };
    });
    var T = TBY[st.theme];
    var cur = {
      name: T.name, tabId: 'm-tab-' + T.id, desc: T.desc,
      viewAll: function () { self.setState({ fTheme: T.id, fCount: 'all', fWidth: 'all', showAll: false }); },
      products: T.stacks.map(function (bands, pi) {
        var wl = widthLabel(bands), nm = T.name + ' ' + bands.length + '-band stack';
        return {
          name: nm, meta: bands.length + ' bands · ' + wl, img: PHOTO[T.id + '-' + bands.length], price: stackPrice(T.id, bands.length), delay: 80 + pi * 60,
          alt: 'Product image: ' + nm + ', ' + bands.map(function (b) { return BY[b[0]].name + ' ' + (b[1] === 'S' ? 'Slim' : 'Wide'); }).join(', '),
          aria: 'Add ' + nm + ' to bag'
        };
      })
    };

    var panes = THEMES.map(function (t) {
      return { on: t.id === st.theme, viewAll: cur.viewAll, name: t.name, desc: t.desc, products: t.id === st.theme ? cur.products : [] };
    });
    var sizeName = SIZES.filter(function (z) { return z[0] === st.size; })[0][1];
    var ddCount = this.dropdown('count', st.count + ' bands', COUNTS.map(function (n) { return [n, n + ' bands']; }), st.count, function (v) { self.setState({ count: v }); });
    var sizeNote = st.size === 'M' ? ' (7.5 inch)' : '';
    var ddSize = this.dropdown('size', sizeName, SIZES, st.size, function (v) { self.setState({ size: v }); });

    var selKey = st.order.indexOf(st.sel) < st.count ? st.sel : st.order[0], selI = st.order.indexOf(selKey);
    var edit = {
      c: BY[st.col[selKey]].c, slimOn: st.wid[selKey] === 'slim' ? 'true' : 'false', wideOn: st.wid[selKey] === 'slim' ? 'false' : 'true',
      widthAria: 'Width for band ' + (selI + 1), colorAria: 'Color for band ' + (selI + 1),
      slim: function () { self.set('wid', selKey, 'slim'); }, wide: function () { self.set('wid', selKey, 'wide'); },
      swatches: CFG.map(function (id) { return BY[id]; }).map(function (c) { var on = c.id === st.col[selKey]; return { name: c.name, c: c.c, checked: on ? 'true' : 'false', r1: on ? 3 : 0, r2: on ? 5 : 0, pick: function () { self.set('col', selKey, c.id); } }; })
    };
    var rows = KEYS.map(function (k) {
      var i = st.order.indexOf(k), on = i < st.count, m = BY[st.col[k]], w = st.wid[k], dragging = st.dragKey === k, sl = w === 'slim';
      return {
        pos: i + 1, size: st.count, hidden: on ? 'false' : 'true', vis: on ? 'visible' : 'hidden', o: on ? 1 : 0,
        label: 'Band 0' + (i + 1), name: m.name + ' · ' + (sl ? 'Slim' : 'Wide'), cname: m.name, c: m.c, gh: sl ? 5 : 13,
        selStr: k === selKey ? 'true' : 'false', selAria: 'Band ' + (i + 1) + ': ' + m.name + ', ' + (sl ? 'Slim' : 'Wide') + (k === selKey ? ', selected' : '. Select to edit'),
        select: function () { self.setState({ sel: k }); },
        y: i * ROWH + (dragging ? st.dragDy : 0), s: dragging ? 1.02 : 1, z: dragging ? 10 : 1, dragStr: dragging ? 'true' : 'false',
        shadow: dragging ? '0 14px 30px -14px rgba(22,22,22,0.4), 0 0 0 1px #E2DED5' : '',
        tr: dragging ? 'box-shadow 150ms ease' : 'transform 320ms cubic-bezier(.2,.9,.3,1.15), opacity 220ms ease, box-shadow 200ms ease',
        handleAria: 'Reorder band ' + (i + 1) + ', ' + m.name + ' ' + w + '. Drag, or use the arrow keys',
        widthAria: 'Width for band ' + (i + 1), colorAria: 'Color for band ' + (i + 1),
        slimOn: sl ? 'true' : 'false', wideOn: sl ? 'false' : 'true',
        slimBg: sl ? '#FFFFFF' : 'transparent', slimFg: sl ? '#161616' : '#6B675F', slimSh: sl ? '0 1px 2px rgba(22,22,22,.18), 0 0 0 1px rgba(22,22,22,.06)' : 'none',
        wideBg: sl ? 'transparent' : '#FFFFFF', wideFg: sl ? '#6B675F' : '#161616', wideSh: sl ? 'none' : '0 1px 2px rgba(22,22,22,.18), 0 0 0 1px rgba(22,22,22,.06)',
        slim: function () { self.set('wid', k, 'slim'); }, wide: function () { self.set('wid', k, 'wide'); },
        swatches: COLORS.map(function (s) { var sel = s.id === st.col[k]; return { name: s.name, c: s.c, checked: sel ? 'true' : 'false', r1: sel ? 2 : 0, r2: sel ? 3.5 : 0, pick: function () { self.set('col', k, s.id); } }; }),
        down: function (e) { self.dragStart(k, e); }, move: function (e) { self.dragMove(e); }, up: function () { self.dragEnd(); },
        key: function (e) { if (e.key === 'ArrowUp') { e.preventDefault(); self.moveBy(k, -1); } else if (e.key === 'ArrowDown') { e.preventDefault(); self.moveBy(k, 1); } }
      };
    });

    var active = st.order.slice(0, st.count), up = active.slice().reverse();
    var lay = bandLayout(up.map(function (k) { return { w: st.wid[k] === 'slim' ? 'S' : 'W' }; }), PVW, PVH, PVFLOOR), kk = lay.k, seatOf = {};
    up.forEach(function (k, j) { seatOf[k] = lay.seats[j]; });
    var botW = st.wid[up[0]] === 'slim' ? 'S' : 'W';
    var pv = { w: PVW, ml: -Math.round(PVW / 2), sx: SX[st.size], shSrc: BAND_SHADOW, shW: Math.round(455 / 360 * PVW), shX: Math.round(-68.9 / 360 * PVW), shY: Math.round(lay.floor - 317.8 / 360 * PVW),
      layers: KEYS.map(function (k) {
        var i = st.order.indexOf(k), on = i < st.count, w = st.wid[k] === 'slim' ? 'S' : 'W', c = st.col[k], dragging = st.dragKey === k;
        var imgs = [];
        CFG.forEach(function (cid) { ['W', 'S'].forEach(function (ww) { var g = BG[ww]; imgs.push({ src: BAND[ww][cid], w: Math.round(g.w * kk * 10) / 10, top: -Math.round(g.h * kk * 10) / 10, dx: g.dx * kk, o: on && cid === c && ww === w ? 1 : 0 }); }); });
        return { key: k, imgs: imgs, z: dragging ? 60 : 50 - i, o: on ? 1 : 0, x: on ? (dragging ? 8 : 0) : 0, y: on ? seatOf[k] : lay.top - 60 };
      }) };
    var total = active.reduce(function (a, k) { return a + (st.wid[k] === 'slim' ? SLIMP : WIDEP); }, 0);
    var preload = [];
    ['W', 'S'].forEach(function (w) { CFG.forEach(function (c) { preload.push(BAND[w][c]); }); });
    var names = active.map(function (k) { return BY[st.col[k]].name + ' ' + (st.wid[k] === 'slim' ? 'Slim' : 'Wide'); });
    var nSlim = active.filter(function (k) { return st.wid[k] === 'slim'; }).length, nWide = st.count - nSlim;
    var widthCount = [nSlim ? nSlim + ' Slim' : '', nWide ? nWide + ' Wide' : ''].filter(Boolean).join(', ');

    var all = [];
    COLORS.forEach(function (m) { all.push({ name: m.name + ' single', price: '$' + SINGLE[m.id], themes: TAGS[m.id], count: 1, wkind: 'both', bands: [[m.id, 'S']], img: SINGLEIMG[m.id], widths: 'Slim or Wide', meta: 'Single band · ' + TAGS[m.id].map(function (t) { return TBY[t].name; }).join(', '), tag: 'Packshot' }); });
    THEMES.forEach(function (t) { t.stacks.forEach(function (bands) { var wl = widthLabel(bands); all.push({ name: t.name + ' ' + bands.length + '-band', price: stackPrice(t.id, bands.length), img: PHOTO[t.id + '-' + bands.length], themes: [t.id], count: bands.length, wkind: wl.toLowerCase(), widths: wl, bands: bands, meta: t.name, tag: 'Stack' }); }); });
    var matched = all.filter(function (p) {
      var wOk = st.fWidth === 'all' || p.wkind === st.fWidth || (p.wkind === 'both' && st.fWidth !== 'mixed');
      return (st.fCount === 'all' || p.count === st.fCount) && (st.fTheme === 'all' || p.themes.indexOf(st.fTheme) >= 0) && wOk;
    });
    var shown = st.showAll ? matched : matched.slice(0, PAGE);
    var products = shown.map(function (p) {
      var isPhoto = !!p.img;
      return { name: p.name, price: p.price, isPhoto: isPhoto, isStack: !isPhoto, img: p.img || '', meta: p.meta, widths: p.widths, tag: p.tag, g: isPhoto ? { w: 0, ml: 0, shY: 0, layers: [] } : stack(p.bands, 140, 200), alt: 'Product image: ' + p.name + ', ' + p.bands.map(function (b) { return BY[b[0]].name + ' ' + (b[1] === 'S' ? 'Slim' : 'Wide'); }).join(', '), aria: 'Add ' + p.name + ' to bag' };
    });
    var opt = function (on) { return { bg: on ? '#161616' : 'transparent', fg: on ? '#F3F1EC' : '#161616', line: on ? '#161616' : '#C9C4B9', checked: on ? 'true' : 'false' }; };
    var groups = [
      { key: 'fSize', label: 'Size', opts: [['all', 'All'], ['S', 'S'], ['M', 'M'], ['L', 'L']] },
      { key: 'fCount', label: 'Stack count', opts: [['all', 'All'], [1, 'Single'], [2, '2'], [3, '3'], [4, '4'], [5, '5']] },
      { key: 'fWidth', label: 'Width', opts: [['all', 'All'], ['slim', 'Slim'], ['wide', 'Wide'], ['mixed', 'Mixed']] },
      { key: 'fTheme', label: 'Mood', opts: [['all', 'All']].concat(THEMES.map(function (t) { return [t.id, t.name]; })) }
    ];
    var fGroups = groups.map(function (g) {
      return { label: g.label, opts: g.opts.map(function (o) { var on = st[g.key] === o[0], u = {}, c = opt(on); u[g.key] = o[0]; u.showAll = false; c.label = o[1]; c.pick = function () { self.setState(u); }; return c; }) };
    });
    var activeChips = [];
    groups.forEach(function (g) {
      if (st[g.key] !== 'all') {
        var lbl = g.opts.filter(function (o) { return o[0] === st[g.key]; })[0][1], u = {};
        u[g.key] = 'all';
        activeChips.push({ label: g.label + ': ' + lbl, aria: 'Remove filter ' + g.label + ': ' + lbl, remove: function () { self.setState(u); } });
      }
    });
    var looks = LOOKS.map(function (k) { return { src: PH[k.src], pos: k.pos, alt: k.alt }; });
    var feature = { src: PH[FEATURE.src], pos: FEATURE.pos, alt: FEATURE.alt };
    var footCols = FOOT.map(function (f) { return { title: f.title, links: f.links.map(function (l) { return { label: l[0], href: l[1] }; }) }; });

    return {
      ph: PH, preload: preload, total: '$' + total, ways: ways, themes: themes, cur: cur, panes: panes,
      menu: st.menu, menuClosed: !st.menu, menuOpenStr: st.menu ? 'true' : 'false', menuAria: st.menu ? 'Close menu' : 'Open menu',
      toggleMenu: function () { self.setState({ menu: !self.state.menu }); }, closeMenu: function () { self.setState({ menu: false }); },
      ddCount: ddCount, ddSize: ddSize, anyOpen: st.open !== null, closeAll: function () { self.setState({ open: null }); },
      rows: rows, edit: edit, pv: pv, sizeNote: sizeNote, ctrlZ: st.open ? 45 : 0, listH: st.count * ROWH, sizeName: sizeName,
      measure: st.measure, measureOpen: st.measure ? 'true' : 'false', toggleMeasure: function () { self.setState({ measure: !self.state.measure }); },
      summaryLine: st.count + ' bands · ' + sizeName, widthCount: widthCount,
      previewAria: 'Preview: ' + st.count + '-band stack, size ' + sizeName + ', top to bottom: ' + names.join(', '),
      looks: looks, looksPair: looks.slice(0, 2), looksLast: looks.slice(2), feature: feature, footCols: footCols, stackName: st.count + '-band stack', waysA: ways.slice(0, 1), waysB: ways.slice(1),
      sheet: st.sheet, sheetOpen: st.sheet ? 'true' : 'false',
      openSheet: function () { self.setState({ sheet: true }); }, closeSheet: function () { self.setState({ sheet: false }); },
      filterLabel: activeChips.length ? 'Filter (' + activeChips.length + ')' : 'Filter',
      showLabel: 'Show ' + matched.length + (matched.length === 1 ? ' product' : ' products'),
      fGroups: fGroups, activeChips: activeChips, hasActive: activeChips.length > 0,
      clearFilters: function () { self.setState({ fSize: 'all', fCount: 'all', fTheme: 'all', fWidth: 'all', showAll: false }); },
      products: products, noResults: matched.length === 0, resultLabel: matched.length + (matched.length === 1 ? ' product' : ' products'),
      canShowMore: matched.length > PAGE, showMoreLabel: st.showAll ? 'Show fewer' : 'Show all ' + matched.length,
      showMore: function () { self.setState({ showAll: !self.state.showAll }); }
    };
  }
}
return { Component: Component, template: "<div style=\"width: 100%; background: #F3F1EC; color: #161616; font-family: 'Instrument Sans', sans-serif\">\n\n<header style=\"position: sticky; top: 0; z-index: 100; background: rgba(243,241,236,0.96); backdrop-filter: blur(12px)\">\n<div style=\"height: 56px; display: grid; grid-template-columns: 44px 1fr 44px; align-items: center; padding: 0 8px\">\n<button class=\"icb\" onClick=\"{{toggleMenu}}\" aria-expanded=\"{{menuOpenStr}}\" aria-controls=\"m-menu\" aria-label=\"{{menuAria}}\">\n<sc-if value=\"{{menu}}\" hint-placeholder-val=\"{{false}}\"><svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" aria-hidden=\"true\"><path d=\"M5 5l10 10M15 5L5 15\"></path></svg></sc-if>\n<sc-if value=\"{{menuClosed}}\" hint-placeholder-val=\"{{true}}\"><svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" aria-hidden=\"true\"><path d=\"M3 7h14M3 13h14\"></path></svg></sc-if>\n</button>\n<a class=\"wordmark\" href=\"#m-top\" aria-label=\"POPLAB home\" style=\"justify-self: center\">POPLAB</a>\n<button class=\"icb\" aria-label=\"Bag, 0 items\"><svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" aria-hidden=\"true\"><path d=\"M4 6.5h12l-1 11H5z\"></path><path d=\"M7.5 6.5V5a2.5 2.5 0 0 1 5 0v1.5\"></path></svg></button>\n</div>\n<sc-if value=\"{{menu}}\" hint-placeholder-val=\"{{false}}\">\n<nav id=\"m-menu\" aria-label=\"Primary\" style=\"position: absolute; left: 0; right: 0; top: 57px; background: #F3F1EC; padding: 8px 20px 28px; box-shadow: 0 24px 40px -24px rgba(22,22,22,0.35)\">\n<a class=\"mnav\" href=\"#m-top\" onClick=\"{{closeMenu}}\">New &amp; Featured<span aria-hidden=\"true\" style=\"font-size: 16px\">\u2192</span></a>\n<a class=\"mnav\" href=\"#m-drop\" onClick=\"{{closeMenu}}\">Shop<span aria-hidden=\"true\" style=\"font-size: 16px\">\u2192</span></a>\n<a class=\"mnav\" href=\"#m-top\" onClick=\"{{closeMenu}}\" aria-current=\"page\"><span>MoodBands <span class=\"t-label\" style=\"vertical-align: middle; margin-left: 6px; color: #6B675F\">You're here</span></span><span aria-hidden=\"true\" style=\"width: 6px; height: 6px; border-radius: 50%; background: #161616\"></span></a>\n<a class=\"mnav\" href=\"#m-footer\" onClick=\"{{closeMenu}}\">About<span aria-hidden=\"true\" style=\"font-size: 16px\">\u2192</span></a>\n<div style=\"display: flex; gap: 20px; margin-top: 18px\">\n<button class=\"tlink\" style=\"text-decoration: none\"><svg width=\"18\" height=\"18\" viewBox=\"0 0 20 20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" aria-hidden=\"true\"><circle cx=\"8.5\" cy=\"8.5\" r=\"5.5\"></circle><path d=\"M12.5 12.5l4.5 4.5\" stroke-linecap=\"round\"></path></svg>Search</button>\n<button class=\"tlink\" style=\"text-decoration: none\"><svg width=\"18\" height=\"18\" viewBox=\"0 0 20 20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" aria-hidden=\"true\"><circle cx=\"10\" cy=\"7\" r=\"3.5\"></circle><path d=\"M3.5 17.5c1-3.3 3.4-5 6.5-5s5.5 1.7 6.5 5\" stroke-linecap=\"round\"></path></svg>Account</button>\n</div>\n</nav>\n</sc-if>\n</header>\n\n<main>\n<section id=\"m-top\" style=\"padding-bottom: 88px\">\n<div style=\"position: relative; height: 560px; overflow: hidden; background: #6FB6DE\">\n<img class=\"photo push\" src=\"{{ph.heroM}}\" alt=\"A raised fist against a sunlit blue wall, the wrist stacked with lime, orange, purple and red MoodBands\" style=\"object-position: 50% 50%\">\n<div aria-hidden=\"true\" style=\"position: absolute; inset: 0; background: linear-gradient(180deg, rgba(14,52,86,0.40) 0%, rgba(14,52,86,0) 45%)\"></div>\n<div class=\"rise\" style=\"position: absolute; left: 20px; right: 20px; top: 40px; color: #FFFFFF; animation-delay: .5s\">\n<h1 class=\"t-hero\" style=\"margin: 0; line-height: 45px\">Wear your<br><em>mood.</em></h1>\n<p class=\"t-body\" style=\"margin: 12px 0 0; max-width: 258px; font-size: 14px; line-height: 1.5\">Colorful silicone wristbands made to mix, match and stack your way.</p>\n</div>\n</div>\n<div class=\"px\" style=\"padding-top: 22px\">\n<a class=\"btn btn-primary\" href=\"#m-drop\">Shop MoodBands</a>\n<a class=\"btn btn-secondary\" href=\"#m-create\" style=\"margin-top: 10px\">Create your stack</a>\n</div>\n</section>\n\n<section id=\"m-ways\" class=\"px\" style=\"padding-bottom: 88px\">\n<h2 class=\"t-h1\" style=\"margin: 0\">Three ways<br>to wear them.</h2>\n<sc-for list=\"{{waysA}}\" as=\"w\" hint-placeholder-count=\"1\">\n<article style=\"display: flex; flex-direction: column; margin-top: 28px\">\n<a href=\"{{w.href}}\" onClick=\"{{w.go}}\" aria-label=\"{{w.aria}}\" class=\"ph\" style=\"display: block; height: 360px; background: #EAE7E2\"><img class=\"photo\" src=\"{{w.life}}\" alt=\"{{w.lifeAlt}}\" style=\"object-position: {{w.pos}}\"></a>\n<p class=\"t-h2\" style=\"margin: 12px 0 0; line-height: 22px\">{{w.title}}</p>\n<p class=\"t-meta\" style=\"margin: 2px 0 0; font-size: 14px; line-height: 19px\">{{w.copy}}</p>\n<a class=\"tlink tlink-u\" href=\"{{w.href}}\" onClick=\"{{w.go}}\" style=\"align-self: flex-start; margin-top: 16px\">{{w.cta}}<span class=\"arr\" aria-hidden=\"true\">\u2192</span></a>\n</article>\n</sc-for>\n<div style=\"display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 28px\">\n<sc-for list=\"{{waysB}}\" as=\"w\" hint-placeholder-count=\"2\">\n<article style=\"display: flex; flex-direction: column; min-width: 0\">\n<a href=\"{{w.href}}\" onClick=\"{{w.go}}\" aria-label=\"{{w.aria}}\" class=\"ph\" style=\"display: block; height: 210px; background: #EAE7E2\"><img class=\"photo\" src=\"{{w.life}}\" alt=\"{{w.lifeAlt}}\" style=\"object-position: {{w.pos}}\"></a>\n<p class=\"t-h2\" style=\"margin: 12px 0 0; font-size: 16px; line-height: 22px\">{{w.title}}</p>\n<p class=\"t-meta\" style=\"margin: 2px 0 0; font-size: 14px; line-height: 19px\">{{w.copy}}</p>\n<a class=\"tlink tlink-u\" href=\"{{w.href}}\" onClick=\"{{w.go}}\" style=\"align-self: flex-start; margin-top: 16px\">{{w.cta}}<span class=\"arr\" aria-hidden=\"true\">\u2192</span></a>\n</article>\n</sc-for>\n</div>\n</section>\n\n<section id=\"m-moods\" style=\"padding: 48px 0 88px; background: #FFFFFF\">\n<div class=\"px\">\n<h2 class=\"t-h1\" style=\"margin: 0\">Find your mood.</h2>\n</div>\n<div class=\"hscroll\" role=\"tablist\" aria-label=\"Moods\" style=\"gap: 24px; margin: 12px 0 0 20px; padding: 0 20px 0 0\">\n<sc-for list=\"{{themes}}\" as=\"t\" hint-placeholder-count=\"5\">\n<button class=\"utab\" role=\"tab\" id=\"{{t.tabId}}\" aria-selected=\"{{t.sel}}\" aria-controls=\"m-mood-panel\" onClick=\"{{t.pick}}\" style=\"color: {{t.fg}}\">{{t.name}}</button>\n</sc-for>\n</div>\n<div id=\"m-mood-panel\" role=\"tabpanel\" aria-labelledby=\"{{cur.tabId}}\" class=\"px\" style=\"margin-top: 16px\">\n<p class=\"t-body\" style=\"margin: 0; max-width: 230px; color: #4E4A43; font-size: 14px; line-height: 1.5\" aria-live=\"polite\">{{cur.desc}}</p>\n<sc-for list=\"{{panes}}\" as=\"cur\" hint-placeholder-count=\"1\">\n<sc-if value=\"{{cur.on}}\" hint-placeholder-val=\"{{true}}\">\n<div style=\"display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 40px 12px; margin-top: 32px\">\n<sc-for list=\"{{cur.products}}\" as=\"p\" hint-placeholder-count=\"4\">\n<article class=\"rise\" style=\"display: flex; flex-direction: column; min-width: 0; animation-delay: {{p.delay}}ms\">\n<div class=\"ph\" style=\"height: 180px; background: #EAE7E2\"><img class=\"photo\" src=\"{{p.img}}\" alt=\"{{p.alt}}\"></div>\n<span class=\"t-prod\" style=\"margin-top: 10px; line-height: 19px\">{{p.name}}</span>\n<span class=\"t-meta\" style=\"margin-top: 2px; font-size: 12px; line-height: 17px\">{{p.meta}}</span>\n<span class=\"t-prod\" style=\"margin-top: 12px; font-weight: 600; line-height: 19px\">{{p.price}}</span>\n<button class=\"btn btn-secondary\" aria-label=\"{{p.aria}}\" style=\"margin-top: 8px; height: 36px; font-size: 13px; width: 100%\">Add to bag</button>\n</article>\n</sc-for>\n</div>\n</sc-if>\n</sc-for>\n<a class=\"btn btn-primary\" href=\"#m-drop\" onClick=\"{{cur.viewAll}}\" style=\"margin-top: 40px\">Shop this mood</a>\n</div>\n</section>\n\n<section id=\"m-create\" style=\"padding: 0 0 88px; background: #FFFFFF\">\n<div class=\"preload\" aria-hidden=\"true\"><sc-for list=\"{{preload}}\" as=\"u\" hint-placeholder-count=\"2\"><img src=\"{{u}}\" alt=\"\"></sc-for></div>\n<sc-if value=\"{{anyOpen}}\" hint-placeholder-val=\"{{false}}\"><div onClick=\"{{closeAll}}\" aria-hidden=\"true\" style=\"position: fixed; inset: 0; z-index: 40\"></div></sc-if>\n<div class=\"px\">\n<h2 class=\"t-h1\" style=\"margin: 0\">Create your stack.</h2>\n</div>\n<div class=\"m-pv\">\n<div class=\"ph\" role=\"img\" aria-label=\"{{previewAria}}\" style=\"height: 290px; background: #EAE7E2\">\n<div class=\"stk\" aria-hidden=\"true\" style=\"width: {{pv.w}}px; margin-left: {{pv.ml}}px; transform: scaleX({{pv.sx}}); transition: transform 420ms cubic-bezier(.2,.8,.2,1)\">\n<img class=\"bshd\" src=\"{{pv.shSrc}}\" alt=\"\" style=\"width: {{pv.shW}}px; transform: translate({{pv.shX}}px, {{pv.shY}}px)\">\n<sc-for list=\"{{pv.layers}}\" as=\"L\" hint-placeholder-count=\"6\"><div class=\"band\" style=\"z-index: {{L.z}}; opacity: {{L.o}}; transform: translate({{L.x}}px, {{L.y}}px)\"><sc-for list=\"{{L.imgs}}\" as=\"I\" hint-placeholder-count=\"2\"><img src=\"{{I.src}}\" alt=\"\" style=\"left: {{I.dx}}px; top: {{I.top}}px; width: {{I.w}}px; opacity: {{I.o}}\"></sc-for></div></sc-for>\n</div>\n</div>\n</div>\n<div class=\"px m-ctrl\" style=\"z-index: {{ctrlZ}}\">\n<div style=\"display: flex; gap: 12px; position: relative; z-index: 50\">\n<div class=\"dd\">\n<p class=\"t-meta\" id=\"m-lbl-count\" style=\"margin: 0 0 8px\">Bands</p>\n<button class=\"ddbtn\" aria-haspopup=\"listbox\" aria-expanded=\"{{ddCount.open}}\" aria-labelledby=\"m-lbl-count\" onClick=\"{{ddCount.toggle}}\"><span>{{ddCount.label}}</span><svg width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" style=\"transform: rotate({{ddCount.rot}}deg); transition: transform .2s\"><path d=\"M4 6l4 4 4-4\"></path></svg></button>\n<sc-if value=\"{{ddCount.isOpen}}\" hint-placeholder-val=\"{{false}}\">\n<div class=\"ddlist\" role=\"listbox\" aria-labelledby=\"m-lbl-count\">\n<sc-for list=\"{{ddCount.opts}}\" as=\"o\" hint-placeholder-count=\"5\"><button class=\"ddopt\" role=\"option\" aria-selected=\"{{o.sel}}\" onClick=\"{{o.pick}}\" onKeyDown=\"{{o.key}}\" style=\"font-weight: {{o.wt}}\">{{o.label}}<svg width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" style=\"opacity: {{o.chk}}\"><path d=\"M3.5 8.5l3 3 6-7\"></path></svg></button></sc-for>\n</div>\n</sc-if>\n</div>\n<div class=\"dd\">\n<div style=\"display: flex; justify-content: space-between; align-items: baseline; margin: 0 0 8px\"><p class=\"t-meta\" id=\"m-lbl-size\" style=\"margin: 0\">Wrist size</p><button class=\"tlink tlink-u\" onClick=\"{{toggleMeasure}}\" aria-expanded=\"{{measureOpen}}\" style=\"font-size: 12px\">Size Help</button></div>\n<button class=\"ddbtn\" aria-haspopup=\"listbox\" aria-expanded=\"{{ddSize.open}}\" aria-labelledby=\"m-lbl-size\" onClick=\"{{ddSize.toggle}}\"><span style=\"white-space: nowrap\">{{ddSize.label}}<span style=\"font-size: 12px\">{{sizeNote}}</span></span><svg width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" style=\"transform: rotate({{ddSize.rot}}deg); transition: transform .2s\"><path d=\"M4 6l4 4 4-4\"></path></svg></button>\n<sc-if value=\"{{ddSize.isOpen}}\" hint-placeholder-val=\"{{false}}\">\n<div class=\"ddlist\" role=\"listbox\" aria-labelledby=\"m-lbl-size\">\n<sc-for list=\"{{ddSize.opts}}\" as=\"o\" hint-placeholder-count=\"3\"><button class=\"ddopt\" role=\"option\" aria-selected=\"{{o.sel}}\" onClick=\"{{o.pick}}\" onKeyDown=\"{{o.key}}\" style=\"font-weight: {{o.wt}}\">{{o.label}}<svg width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\" style=\"opacity: {{o.chk}}\"><path d=\"M3.5 8.5l3 3 6-7\"></path></svg></button></sc-for>\n</div>\n</sc-if>\n</div>\n</div>\n<sc-if value=\"{{measure}}\" hint-placeholder-val=\"{{false}}\"><p class=\"t-meta\" style=\"margin: 12px 0 0; padding: 10px 12px; background: #F3F1EC; border-radius: 8px\">Wrap a soft tape measure around your wrist just above the wrist bone. The size chart will be published with the drop.</p></sc-if>\n<div role=\"list\" aria-label=\"Your bands, top to bottom. Select a band to change it; drag to reorder.\" style=\"position: relative; height: {{listH}}px; margin-top: 24px; transition: height 300ms ease\">\n<sc-for list=\"{{rows}}\" as=\"r\" hint-placeholder-count=\"6\">\n<div class=\"crow\" role=\"listitem\" data-drag=\"{{r.dragStr}}\" data-sel=\"{{r.selStr}}\" aria-posinset=\"{{r.pos}}\" aria-setsize=\"{{r.size}}\" aria-hidden=\"{{r.hidden}}\" style=\"position: absolute; left: 0; right: 0; top: 0; height: 52px; display: flex; align-items: center; gap: 2px; padding: 0 2px; box-shadow: {{r.shadow}}; transform: translateY({{r.y}}px) scale({{r.s}}); opacity: {{r.o}}; visibility: {{r.vis}}; z-index: {{r.z}}; transition: {{r.tr}}\">\n<button class=\"handle\" aria-label=\"{{r.handleAria}}\" onPointerDown=\"{{r.down}}\" onPointerMove=\"{{r.move}}\" onPointerUp=\"{{r.up}}\" onPointerCancel=\"{{r.up}}\" onKeyDown=\"{{r.key}}\"><svg width=\"10\" height=\"16\" viewBox=\"0 0 10 16\" fill=\"currentColor\" aria-hidden=\"true\"><circle cx=\"2.5\" cy=\"2.5\" r=\"1.4\"></circle><circle cx=\"7.5\" cy=\"2.5\" r=\"1.4\"></circle><circle cx=\"2.5\" cy=\"8\" r=\"1.4\"></circle><circle cx=\"7.5\" cy=\"8\" r=\"1.4\"></circle><circle cx=\"2.5\" cy=\"13.5\" r=\"1.4\"></circle><circle cx=\"7.5\" cy=\"13.5\" r=\"1.4\"></circle></svg></button>\n<button class=\"rsel\" aria-pressed=\"{{r.selStr}}\" aria-label=\"{{r.selAria}}\" onClick=\"{{r.select}}\">\n<span aria-hidden=\"true\" style=\"width: 48px; height: 16px; display: flex; align-items: center; flex: none\"><span style=\"display: block; width: 48px; height: {{r.gh}}px; border-radius: 999px; background-color: {{r.c}}; box-shadow: inset 0 0 0 1px rgba(22,22,22,0.12); transition: height .3s, background-color .3s\"></span></span>\n<span>{{r.cname}}</span>\n</button>\n</div>\n</sc-for>\n</div>\n<div style=\"margin-top: 14px; padding: 14px; background: #ECE9E2; border-radius: 16px\">\n<div role=\"radiogroup\" aria-label=\"{{edit.widthAria}}\" style=\"display: flex; gap: 8px\">\n<button class=\"wpick\" role=\"radio\" aria-checked=\"{{edit.slimOn}}\" aria-label=\"Slim\" onClick=\"{{edit.slim}}\"><span aria-hidden=\"true\" style=\"display: block; width: 36px; height: 5px; border-radius: 999px; background: {{edit.c}}; box-shadow: inset 0 0 0 1px rgba(22,22,22,0.15)\"></span></button>\n<button class=\"wpick\" role=\"radio\" aria-checked=\"{{edit.wideOn}}\" aria-label=\"Wide\" onClick=\"{{edit.wide}}\"><span aria-hidden=\"true\" style=\"display: block; width: 36px; height: 13px; border-radius: 999px; background: {{edit.c}}; box-shadow: inset 0 0 0 1px rgba(22,22,22,0.15)\"></span></button>\n</div>\n<div role=\"radiogroup\" aria-label=\"{{edit.colorAria}}\" style=\"display: flex; flex-wrap: wrap; gap: 10px 9px; margin-top: 14px\">\n<sc-for list=\"{{edit.swatches}}\" as=\"s\" hint-placeholder-count=\"10\"><button class=\"sw\" role=\"radio\" aria-checked=\"{{s.checked}}\" aria-label=\"{{s.name}}\" onClick=\"{{s.pick}}\" style=\"background: {{s.c}}; box-shadow: inset 0 0 0 1px rgba(22,22,22,0.14), 0 0 0 {{s.r1}}px #ECE9E2, 0 0 0 {{s.r2}}px #161616\"></button></sc-for>\n</div>\n</div>\n<div style=\"display: flex; justify-content: space-between; align-items: flex-end; gap: 14px; margin-top: 22px\" aria-live=\"polite\">\n<div><p class=\"t-prod\" style=\"margin: 0; font-size: 15px\">{{stackName}}</p><p class=\"t-meta\" style=\"margin: 2px 0 0\">{{sizeName}}</p></div>\n<div style=\"text-align: right\"><p class=\"t-meta\" style=\"margin: 0\">Total</p><p class=\"t-h2\" style=\"margin: 0; font-size: 22px; line-height: 22px; font-weight: 600\">{{total}}</p></div>\n</div>\n<button class=\"btn btn-primary\" style=\"width: 100%; height: 54px; margin-top: 16px\">Buy your stack</button>\n</div>\n</section>\n\n<section id=\"m-style\" style=\"padding-bottom: 88px; background: #FFFFFF\">\n<div class=\"px\">\n<h2 class=\"t-h1\" style=\"margin: 0\">Style it.</h2>\n<p class=\"t-body\" style=\"margin: 6px 0 0; color: #4E4A43; font-size: 14px; line-height: 22px\">Ways to wear MoodBands, on their own or stacked.</p>\n<figure class=\"ph\" style=\"height: 250px; margin-top: 20px; background: #E6E2D9\"><img class=\"photo\" src=\"{{feature.src}}\" alt=\"{{feature.alt}}\" style=\"object-position: {{feature.pos}}\"></figure>\n</div>\n<div class=\"px\" style=\"display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px 12px; margin-top: 20px\">\n<sc-for list=\"{{looksPair}}\" as=\"k\" hint-placeholder-count=\"2\">\n<figure class=\"ph\" style=\"height: 215px; background: #E6E2D9\"><img class=\"photo\" src=\"{{k.src}}\" alt=\"{{k.alt}}\" style=\"object-position: {{k.pos}}\"></figure>\n</sc-for>\n<sc-for list=\"{{looksLast}}\" as=\"k\" hint-placeholder-count=\"1\">\n<figure class=\"ph\" style=\"grid-column: 1 / -1; height: 280px; background: #E6E2D9\"><img class=\"photo\" src=\"{{k.src}}\" alt=\"{{k.alt}}\" style=\"object-position: {{k.pos}}\"></figure>\n</sc-for>\n</div>\n</section>\n\n<section id=\"m-drop\" class=\"px\" style=\"padding-bottom: 88px; position: relative; background: #FFFFFF\">\n<div><h2 class=\"t-h1\" style=\"margin: 0\">The MoodBands drop.</h2></div>\n<div style=\"display: flex; justify-content: space-between; align-items: center; margin-top: 32px\">\n<button class=\"btn btn-secondary\" onClick=\"{{openSheet}}\" aria-expanded=\"{{sheetOpen}}\" aria-controls=\"m-filter-sheet\" style=\"display: inline-flex; height: 40px; padding: 0 16px; font-size: 14px\"><svg width=\"16\" height=\"16\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" aria-hidden=\"true\"><path d=\"M2 4h12M4 8h8M6 12h4\"></path></svg>{{filterLabel}}</button>\n<span class=\"t-meta\" aria-live=\"polite\">{{resultLabel}}</span>\n</div>\n<sc-if value=\"{{hasActive}}\" hint-placeholder-val=\"{{false}}\">\n<div style=\"display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px\"><sc-for list=\"{{activeChips}}\" as=\"a\" hint-placeholder-count=\"2\"><button class=\"achip\" onClick=\"{{a.remove}}\" aria-label=\"{{a.aria}}\">{{a.label}}<svg width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" aria-hidden=\"true\"><path d=\"M5 5l6 6M11 5l-6 6\"></path></svg></button></sc-for></div>\n</sc-if>\n<sc-if value=\"{{sheet}}\" hint-placeholder-val=\"{{false}}\">\n<div id=\"m-filter-sheet\" role=\"dialog\" aria-label=\"Filters\" style=\"position: absolute; left: 0; right: 0; top: 130px; z-index: 50; background: #FBFAF7; box-shadow: 0 -12px 40px rgba(22,22,22,0.18); padding: 18px 20px 22px; border-radius: 20px 20px 0 0\">\n<div style=\"display: flex; justify-content: space-between; align-items: center\"><span class=\"t-h2\">Filter</span><button class=\"icb\" onClick=\"{{closeSheet}}\" aria-label=\"Close filters\"><svg width=\"18\" height=\"18\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" aria-hidden=\"true\"><path d=\"M4 4l8 8M12 4l-8 8\"></path></svg></button></div>\n<sc-for list=\"{{fGroups}}\" as=\"g\" hint-placeholder-count=\"4\">\n<div role=\"radiogroup\" aria-label=\"{{g.label}}\" style=\"padding: 14px 0; border-bottom: 1px solid #E5E1D8\">\n<p class=\"t-label\" style=\"margin: 0 0 8px\">{{g.label}}</p>\n<div style=\"display: flex; flex-wrap: wrap; gap: 6px\"><sc-for list=\"{{g.opts}}\" as=\"o\" hint-placeholder-count=\"4\"><button class=\"fopt\" role=\"radio\" aria-checked=\"{{o.checked}}\" onClick=\"{{o.pick}}\" style=\"background: {{o.bg}}; color: {{o.fg}}; box-shadow: inset 0 0 0 1px {{o.line}}\">{{o.label}}</button></sc-for></div>\n</div>\n</sc-for>\n<div style=\"display: flex; gap: 10px; margin-top: 16px\"><button class=\"btn btn-secondary\" onClick=\"{{clearFilters}}\" style=\"flex: 1\">Clear</button><button class=\"btn btn-primary\" onClick=\"{{closeSheet}}\" style=\"flex: 2\">{{showLabel}}</button></div>\n</div>\n</sc-if>\n<sc-if value=\"{{noResults}}\" hint-placeholder-val=\"{{false}}\"><p class=\"t-h2\" style=\"margin: 24px 0 0; color: #6B675F\">Nothing matches those filters yet.</p></sc-if>\n<div style=\"display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 32px 12px; margin-top: 26px\">\n<sc-for list=\"{{products}}\" as=\"c\" hint-placeholder-count=\"6\">\n<article>\n<div class=\"ph\" role=\"img\" aria-label=\"{{c.alt}}\" style=\"height: 200px; background: #EAE7E2\">\n<sc-if value=\"{{c.isPhoto}}\" hint-placeholder-val=\"{{true}}\"><img class=\"photo\" src=\"{{c.img}}\" alt=\"\"></sc-if>\n<sc-if value=\"{{c.isStack}}\" hint-placeholder-val=\"{{false}}\"><div class=\"stk\" aria-hidden=\"true\" style=\"width: {{c.g.w}}px; margin-left: {{c.g.ml}}px\">\n<img class=\"shd\" src=\"assets/images/photos/4c7eb7491e8e4dde19e34ad7ac97fbc2.webp\" alt=\"\" style=\"top: {{c.g.shY}}px; width: {{c.g.w}}px\">\n<sc-for list=\"{{c.g.layers}}\" as=\"L\" hint-placeholder-count=\"1\"><img src=\"{{L.src}}\" alt=\"\" style=\"top: {{L.y}}px; width: {{L.w}}px; z-index: {{L.z}}\"></sc-for>\n</div></sc-if>\n</div>\n<p class=\"t-prod\" style=\"margin: 10px 0 0; line-height: 19px\">{{c.name}}</p>\n<p class=\"t-meta\" style=\"margin: 4px 0 0; font-size: 12px; line-height: 17px\">{{c.meta}} \u00b7 {{c.widths}}</p>\n<p class=\"t-prod\" style=\"margin: 12px 0 0; font-weight: 600; line-height: 19px\">{{c.price}}</p>\n<button class=\"btn btn-secondary\" style=\"height: 44px; margin-top: 16px; font-size: 14px; width: 100%\" aria-label=\"{{c.aria}}\">Add to bag</button>\n</article>\n</sc-for>\n</div>\n<sc-if value=\"{{canShowMore}}\" hint-placeholder-val=\"{{true}}\"><button class=\"btn btn-primary\" onClick=\"{{showMore}}\" style=\"width: 100%; margin-top: 28px\">{{showMoreLabel}}</button></sc-if>\n</section>\n\n<section aria-label=\"Change your mood\" style=\"padding: 16px 0 72px; background: #FFFFFF; position: relative\">\n<div aria-hidden=\"true\" style=\"position: absolute; inset: 0; z-index: 1; pointer-events: none; background: rgba(0,0,0,0.03)\"></div>\n<div style=\"position: relative; height: 440px; overflow: hidden; background: #FFFFFF\">\n<img class=\"photo\" src=\"{{ph.bannerM}}\" alt=\"Four arms reaching in from the right, wearing red, lime, orange and yellow MoodBands\" style=\"object-position: 50% 50%\">\n</div>\n<div class=\"px\" style=\"margin-top: 64px; text-align: center\">\n<h2 class=\"t-hero\" style=\"margin: 0; font-size: 36px; line-height: 45px\">Change your mood.<br><em>Change your stack.</em></h2>\n<p class=\"t-body\" style=\"margin: 12px 0 0; font-size: 14px; line-height: 22px; color: #4E4A43\">Swap a band, add one, start again tomorrow.</p>\n<a class=\"btn btn-primary\" href=\"#m-drop\" style=\"margin-top: 32px\">Shop MoodBands</a>\n</div>\n</section>\n</main>\n\n<footer id=\"m-footer\" style=\"background: #EAE6DE; padding: 36px 20px 24px\">\n<a class=\"wordmark\" href=\"#m-top\" style=\"font-size: 24px\">POPLAB</a>\n<div style=\"display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 28px 16px; margin-top: 28px\">\n<sc-for list=\"{{footCols}}\" as=\"f\" hint-placeholder-count=\"4\">\n<nav aria-label=\"{{f.title}}\" style=\"display: flex; flex-direction: column\">\n<p class=\"t-label\" style=\"margin: 0 0 8px; color: #6B675F\">{{f.title}}</p>\n<sc-for list=\"{{f.links}}\" as=\"l\" hint-placeholder-count=\"3\"><a class=\"flink\" href=\"{{l.href}}\">{{l.label}}</a></sc-for>\n</nav>\n</sc-for>\n</div>\n<div style=\"display: flex; justify-content: space-between; align-items: center; margin-top: 32px; padding-top: 16px\">\n<p class=\"t-meta\" style=\"margin: 0\">\u00a9 POPLAB</p>\n<div style=\"display: flex; gap: 20px\"><a class=\"flink\" href=\"#m-footer\" style=\"font-size: 13px; color: #6B675F\">Privacy</a><a class=\"flink\" href=\"#m-footer\" style=\"font-size: 13px; color: #6B675F\">Terms</a></div>\n</div>\n</footer>\n</div>" };
})();

MoodBandsApp.start({ desktop: DesktopView, mobile: MobileView });
