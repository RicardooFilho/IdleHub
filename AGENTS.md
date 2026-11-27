# Regras para agentes de IA

Leia antes de mexer no projeto. Elas valem para qualquer agente (Claude, Copilot, Cursor, etc.).

## Sobre o projeto

IdleHub é um app de PC (Electron, Windows) para quem joga jogos idle de navegador com várias contas:
- **Jogos:** cada conta de cada jogo roda numa `WebContentsView` própria, com sessão separada (login separado), num mosaico. Watchdog recarrega conta travada, em branco ou que caiu; contas podem "dormir" para liberar memória; alertas leem textos e números da página (`src/main/accounts.js`).
- **Painel:** o [IdleLive](idlelive/README.md) (pontos do canal na Twitch e na Kick, votos, histórico) roda dentro do app, num processo separado (`src/main/idlelive.js`), e a página dele aparece na janela (`src/main/panel.js`).
- Jogos prontos: PokeIdle (4 contas), LoLdle (5) e One Piece Idle (2). Ficam em `catalog/games.json` (o **catálogo**, que também é baixado da internet e conferido em `src/main/catalog.js`; `src/main/games.js` só o lê). Jogo novo entra editando esse arquivo, sem mexer no código. O catálogo é só dado: nunca execute nada que venha dele. Qualquer outro jogo entra pelo link.

O público é de jogadores, não programadores, e o app é distribuído para amigos pelo instalador. Veja o [README.md](README.md).

**O IdleHub é a casa do IdleLive.** A pasta `idlelive/` é a única versão oficial do código dele. O repositório antigo (`RicardooFilho/idlelive`, pasta local `twitch-chat-presence`) está congelado: não faça commits nem releases nele e não traga código de lá. Mudanças no IdleLive são feitas em `idlelive/`, seguindo o [idlelive/AGENTS.md](idlelive/AGENTS.md), e saem junto com as versões do IdleHub.

## A regra mais importante

**Os jogos nunca podem parar de rodar.** Escondidos, minimizados, com o Painel ou uma janela aberta, ou com o app só perto do relógio, os temporizadores dos jogos continuam em 100%:
- `backgroundThrottling: false` nas contas e as chaves `disable-renderer-backgrounding`, `disable-background-timer-throttling` e `disable-backgrounding-occluded-windows` em `src/main/main.js`;
- `src/preload/game.js` faz a página se ver sempre visível (`document.hidden = false`);
- o limite de FPS só reduz a animação (`requestAnimationFrame`). O padrão é 30: menos que isso deixaria lentos os jogos que contam o progresso por quadro (há um teste para isso).

Não troque nada disso sem medir antes (contas escondidas e minimizadas, com `setInterval` e `requestAnimationFrame`).

## Segurança e dados

- Dados de cada pessoa ficam em `%APPDATA%/IdleHub` (`config.json`, sessões das contas) e `%APPDATA%/IdleHub/idlelive` (tokens da Twitch e da Kick, canais, histórico). **Nunca** leia em voz alta, copie, faça commit ou envie esses arquivos. Nada disso pode entrar no repositório (que é público).
- Não peça para o usuário colar senhas, tokens ou segredos no chat.
- O IdleLive usa a porta **3000**, a mesma do IdleLive avulso: assim as duas versões nunca rodam juntas com os mesmos tokens (o refresh token da Twitch só vale uma vez). Não mude a porta nem deixe o IdleHub abrir o IdleLive com a porta ocupada.
- **Não rode uma segunda cópia com os dados reais** enquanto o app do usuário estiver aberto. Para testar, use `IDLEHUB_DATA` (pasta de dados de teste) e `IDLEHUB_IDLELIVE_PORT` (outra porta para o Painel).
- As contas dos jogos rodam com `sandbox`, `contextIsolation` e sem Node. O preload delas (`src/preload/game.js`) não expõe nada para a página. A interface só fala com o app pelo `window.idle` de `src/preload/ui.js`.
- A interface abre por `idlehub://app/…` e esse endereço só serve as pastas de `UI_ALLOWED` em `src/main/main.js`. Não abra outras pastas por ele.
- Ajustes para o login do Google (sem chave de acesso, Firefox só nas páginas de login) estão em `src/preload/game.js` e `src/main/accounts.js`. Não tire: o Google bloqueia login em apps.
- Funções que podem ir contra as regras dos jogos ou das plataformas (comprar sozinho, assistir lives sozinho) ficam desligadas por padrão e com aviso claro.

## Código

- Electron, Node 22+ e JavaScript puro, sem build (CommonJS no `src/main`, módulos na interface). Evite pacotes novos: cada um vai no instalador de todo mundo.
- `src/main/`: app, contas, watchdog, Painel. `src/preload/`: pontes com as páginas. `src/renderer/`: interface. `idlelive/`: o IdleLive, com as regras dele em [idlelive/AGENTS.md](idlelive/AGENTS.md).
- A interface usa **Web Awesome 3.14.0**, ícones do **Font Awesome grátis 7.3.0** e a fonte **Montserrat**, que vêm junto com o app (em `node_modules`, servidos por `idlehub://`), para a janela funcionar sem internet. Siga o [DESIGN.md](DESIGN.md). Mudou um padrão visual? Atualize o `DESIGN.md`.
- As contas dos jogos e o Painel são desenhados **por cima** da página da interface, nos espaços `[data-live]` e `[data-panel]` (`sendLayout()` em `src/renderer/app.js`). Tudo que fica por cima (janelas, confirmações) precisa esconder as contas: `S.modal`/`S.asking` fazem `sendLayout` mandar lista vazia. Menus suspensos e avisos não podem ficar em cima das contas.
- Siga o estilo do código ao redor: comentários curtos e em português explicando o *porquê*, nomes em inglês, `const`, arrow functions, 2 espaços.
- Textos da interface e das notificações são em **português do Brasil**, simples, para quem não é programador.

## Testes

- Antes de terminar, rode `npm run check` (sintaxe), `npm test` (testes do IdleHub, `test/*.test.js`) e, se mexeu em `idlelive/`, `npm run test:idlelive`. O GitHub Actions roda os três a cada push (o IdleHub no Node 22 e 24; o IdleLive no 20, 22 e 24, porque o avulso aceita Node 20).
- Mexeu em `idlelive/`? Leia também o [idlelive/AGENTS.md](idlelive/AGENTS.md), principalmente a seção **Dentro do IdleHub**.
- Testes usam `node:test` e `node:assert`, sem internet e sem os dados reais: defina `IDLEHUB_DATA` com uma pasta temporária **antes** de carregar `src/main/config.js`.
- Mudou lógica em `src/main/`? Crie ou ajuste o teste do módulo. A interface não tem testes: rode o app (`npm start`) com dados de teste e confira na tela.
- Para ver a interface sem abrir a janela na mão: `IDLEHUB_DEBUG=1` mostra o console da interface e o estado das contas no terminal, e `IDLEHUB_UI_EVAL` roda um trecho na interface depois de abrir.
- Antes de distribuir, gere o instalador (`npm run dist`) e abra o app empacotado: o IdleLive roda de fora do `.asar` (`asarUnpack`) e isso só aparece empacotado.
- Não abra janelas na tela do usuário sem avisar.

## Documentação

- Toda mudança visível para o usuário entra no [CHANGELOG.md](CHANGELOG.md), na seção da data do dia (`## DD/MM/AAAA`), em Novidades, Mudanças ou Correções. Mudanças no IdleLive também entram aqui; o `idlelive/CHANGELOG.md` fica como histórico do IdleLive avulso.
- Se mudar a instalação, o uso ou os dados, atualize o [README.md](README.md).

## Commits

- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `build:`, `perf:`), com escopo quando ajudar: `feat(panel): …`, `fix(login): …`. Descrição curta, em inglês, no imperativo.
- **Nunca** mencione Claude, Anthropic ou outra IA nos commits e pull requests (nem `Co-Authored-By`).
- Antes de cada commit, confira com `git status` que nenhum arquivo de dados entrou.

## Versões e atualização

- A versão é o `version` do `package.json`. `npm run release` (com `GH_TOKEN`) gera o instalador e cria o rascunho da release no GitHub; publicado o rascunho, o app de todo mundo se atualiza sozinho (`electron-updater`).
- Dentro do IdleHub, o IdleLive não se atualiza sozinho (`IDLELIVE_EMBEDDED=1`): ele vai junto com cada versão do IdleHub.
