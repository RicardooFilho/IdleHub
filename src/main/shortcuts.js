// Atalhos de teclado do app (só com a janela do IdleHub em foco, nada global).
// As contas e o Painel são views separadas desenhadas por cima da interface: com o foco dentro delas,
// o teclado não chega na página da interface. Por isso lemos as teclas no `before-input-event` de cada
// view e mandamos o atalho para a interface decidir (ela sabe a ordem das contas e qual está aberta).

// Devolve o atalho que a tecla representa, ou null. `input` é o objeto do `before-input-event`.
function matchShortcut(input) {
  if (!input || input.type !== 'keyDown' || input.alt || input.meta) return null;
  const key = String(input.key || '');
  const ctrl = !!input.control;
  const shift = !!input.shift;

  // Trocar de conta anda de uma em uma, então pode repetir segurando a tecla.
  if (ctrl && key === 'Tab') return { action: shift ? 'prev' : 'next' };

  // Os outros disparam uma vez só: segurar a tecla não deve recarregar nem alternar o som sem parar.
  if (input.isAutoRepeat) return null;
  if (ctrl && !shift && /^[1-9]$/.test(key)) return { action: 'goto', index: Number(key) - 1 };
  if (ctrl && !shift && key.toLowerCase() === 'm') return { action: 'mute' };
  if (!ctrl && !shift && key === 'F5') return { action: 'reload' };
  return null;
}

// Liga os atalhos a um webContents. `onShortcut(atalho)` recebe o resultado de matchShortcut.
// A tecla é engolida (a página não a vê): senão o F5 recarregaria a página do jogo por fora do watchdog.
function attachShortcuts(webContents, onShortcut) {
  webContents.on('before-input-event', (event, input) => {
    const shortcut = matchShortcut(input);
    if (!shortcut) return;
    event.preventDefault();
    onShortcut(shortcut);
  });
}

module.exports = { matchShortcut, attachShortcuts };
