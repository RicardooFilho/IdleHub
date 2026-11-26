// Ícones do <wa-icon> vindos dos SVGs do Font Awesome grátis que acompanham o app,
// em vez do site do Font Awesome: a janela funciona sem internet.
import { registerIconLibrary } from '../../node_modules/@awesome.me/webawesome/dist-cdn/webawesome.js';

const SVGS = new URL('../../node_modules/@fortawesome/fontawesome-free/svgs/', import.meta.url);

registerIconLibrary('default', {
  resolver: (name, family, variant) => {
    const folder = family === 'brands' ? 'brands' : variant === 'regular' ? 'regular' : 'solid';
    return new URL(`${folder}/${name}.svg`, SVGS).href;
  },
  mutator: (svg) => svg.setAttribute('fill', 'currentColor'),
});
