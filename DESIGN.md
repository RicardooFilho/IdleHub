# Design do IdleHub

Como a interface do IdleHub (`src/renderer/`) é desenhada. Ela usa a mesma base do Painel (o IdleLive, regras em [idlelive/DESIGN.md](idlelive/DESIGN.md)), para o app inteiro ter uma cara só. Siga estas regras ao criar ou mudar uma tela. As regras gerais estão no [AGENTS.md](AGENTS.md).

## Base

- **Web Awesome 3.14.0**, tema escuro fixo (`<html class="wa-dark">`), fonte **Montserrat** e ícones do **Font Awesome grátis 7.3.0**. Os três vêm junto com o app (não da internet), para a janela funcionar offline. Tamanhos dos componentes: use `size="s"` (o `size="small"` está obsoleto no 3.14).
- Fundo da janela: `--wa-color-surface-lowered`; barra lateral, cards das contas e janelas: `--wa-color-surface-default`; bordas: `--wa-color-surface-border`.
- Texto secundário (dicas, memória, horários) usa `--wa-color-text-quiet`, de preferência pela classe `.meta` (12px).
- Números que mudam (memória, valores dos alertas, contagens) usam `.num` (`tabular-nums`) e `fmt()` (separador de milhar do pt-BR).
- Cantos: 8px nos botões da barra lateral, 10px nos cards das contas e no Painel, 16px na barra lateral. Os componentes do Web Awesome ficam com o padrão deles.
- Títulos: `h1` do cabeçalho em 20px; `h2` dos estados vazios em 15px. Rótulos de grupo (`.form-label`) são 11px, maiúsculos e espaçados (`letter-spacing: .08em`).

## Cores

- O IdleHub é a seção "o resto" do Painel: destaque **laranja** (`--orange`, #fc5e03), que vira a cor "brand" do Web Awesome. Use `--brand`, `--brand-soft`, `--brand-text` em CSS próprio e `variant="brand"` nos componentes.
- **Cor de cada jogo**: vem da configuração do jogo (o jogador escolhe) e só aparece na sigla (`.game-badge`) e no texto do botão do jogo na barra lateral. Nunca use a cor do jogo em botões ou avisos.
- Não escreva cores direto no CSS. Se precisar de uma cor nova que se repete, crie uma variável no `:root`.
- Cores que não mudam:
  - `--live` (verde): conta rodando (bolinha brilhando).
  - `--error-text` / `--error-fill`: erros (conta que travou, aviso de erro).
  - `--wa-color-*` do Web Awesome (`success`, `warning`, `danger`, `neutral`) para estados: conta sem resposta, deslogada ou sem internet é `warning`.
  - `--game-bg`: fundo atrás das contas enquanto elas carregam.

## Espaçamento

Todo espaço (`gap`, `padding`, `margin`) vem da escala do Web Awesome (`--wa-space-3xs` 2px até `--wa-space-3xl` 48px), como no Painel. Use as variáveis, não o número. O espaço dentro de um grupo é menor que o espaço entre grupos.

Fora da escala só: bordas, tamanhos (larguras, alturas, ícones, fontes), a altura do cabeçalho (`--head-h`) e do topo dos cards (`--tile-head-h`), que o cálculo do mosaico usa. Nesses casos, deixe um comentário dizendo de onde vem o número.

## Layout

- **Barra lateral** à esquerda, só com ícones (76px, a mesma largura da sidebar recolhida do Painel), solta da borda como no Painel. De cima para baixo: **Painel** (ícone do IdleLive), **Todas as contas**, um botão por jogo (sigla na cor do jogo, com o selo `rodando/total`), **+** (adicionar jogo); no pé, **Grupos e perfis** (camadas), **Desempenho** (velocímetro), **Atividade** (sino) e **Configurações** (engrenagem). O item aberto fica com `--brand-soft` e a faixa laranja à esquerda.
- **Cabeçalho** (64px): título (`h1`), selos de resumo (`wa-badge` neutro com contorno) e ações à direita.
- **Conteúdo**: o mosaico de contas, ou o Painel ocupando tudo.
- **Mosaico**: grade calculada em `bestCols()` para cada conta ficar o maior possível em 16:9. Cada conta é um card com topo de 36px (bolinha de status, sigla do jogo, nome, status, valores dos alertas, memória e botões) e o jogo embaixo, reduzido a partir de `tileBaseWidth`. Duplo clique no topo expande a conta.
- **Contas e Painel ficam por cima da página** (são desenhados pelo app, não pelo HTML). Por isso:
  - nada pode ficar por cima de `[data-live]` ou `[data-panel]`: nem menus suspensos (`wa-dropdown`), nem dicas, nem avisos. Use botões diretos;
  - toda janela esconde as contas enquanto está aberta (`S.modal`/`S.asking`). Exceção: **Escolher na tela** (`S.picking`), em que a janela do jogo se esconde mas a conta escolhida aparece sozinha, em tamanho cheio (visão `focus`), para a pessoa clicar nela;
  - a resposta rápida (`toast`) aparece no topo, sobre o cabeçalho.

## Componentes

### Botões (`wa-button`)

| Uso | Como |
|---|---|
| Ação principal da janela ou do estado vazio | `variant="brand"` |
| Ações do cabeçalho (Acordar todas, Recarregar, Otimizar…) e secundárias (Adicionar conta) | `variant="brand" appearance="outlined"` |
| Ação discreta (Voltar, Cancelar, Editar jogo, Abrir no navegador) | `appearance="plain"` |
| Botão só com ícone (topo das contas, remover) | `iconBtn()`: `appearance="plain"` + `<wa-icon label>` + `title` |

- Botões do cabeçalho e das contas são `size="s"`. Tamanho normal só nas janelas.
- Ícone de apoio: `slot="start"` para a ação, `slot="end"` para link externo (`arrow-up-right-from-square`).
- Enquanto o app trabalha, use `loading` no botão.
- Não há botão vermelho. Ações destrutivas (excluir jogo, remover conta) pedem confirmação com `ask({ danger: true })`.
- Botões levam `data-action="…"` e são tratados por um único ouvinte de cliques. Não use `onclick` no HTML.

### Avisos

| O quê | Como |
|---|---|
| Dica ou informação numa janela | `<wa-callout variant="neutral" size="small">` com `<wa-icon slot="icon" name="circle-info">` |
| Resposta rápida de uma ação (salvo, erro) | `toast(msg)` (erro) ou `toast(msg, 'info')` |
| O que aconteceu com as contas (recargas, logouts, alertas) | Lista de **Atividade** (sino), alimentada pelo `log()` do `AccountManager`, e notificação do Windows. Não crie outra lista. |

### Aviso do jogo

- Jogo com limite de contas ou aviso de punição (vindos do catálogo) mostra uma faixa `#game-note` entre o cabeçalho e as contas: ícone `triangle-exclamation`, texto de 12px, fundo `surface-lowered`; em `warning` quando a pessoa já passou do limite. Na janela do jogo, o mesmo aviso vira `wa-callout variant="warning"` em Contas. Passar do limite pede confirmação com `ask()` ("Adicionar mesmo assim"), nunca bloqueia.

### Selos

- `wa-badge pill`: `neutral` com contorno para resumos (rodando, dormindo, RAM); `warning` para problema ou alerta disparado; `danger` para contagem de problemas na barra lateral; `success` para o Painel rodando.

### Janelas

- Uma janela só (`#dialog`, `wa-dialog`, `light-dismiss`, largura `min(960px, 94vw)`), com o conteúdo trocado pelo `renderModalBody()`. Botões no `slot="footer"`; Cancelar e Fechar usam `data-dialog="close"`.
- Exceção: as **boas-vindas** não fecham clicando fora nem com Esc (sem jogo nenhum o app fica vazio).
- Confirmação: sempre `ask({ title, text, ok, danger })`, nunca `confirm()` ou `alert()`. O título é uma pergunta curta ("Remover Conta 2?"), o texto diz o que acontece e se dá para voltar atrás, e o botão repete o verbo ("Remover", não "OK").
- **Enquanto você estava fora** (`awayHtml()`): janela normal (`S.modal`, esconde as contas) aberta sozinha quando a pessoa volta. Se outra janela estiver aberta, espera ela fechar (`S.awayPending`). Frase com o tempo fora, quadradinhos de números (`.away-stat`: quedas resolvidas, alertas, tempo rodando, internet) e listas `.away-list` do que aconteceu e do que precisa de atenção. Tudo vem pronto do `summarize()` de `src/main/events.js`; o botão **Ver atividade** abre a lista.
- **Resumo do dia**: o mesmo cartão do "Enquanto você estava fora" (`awayHtml()`), com `kind: 'daily'` no resumo: título **Resumo do dia** e frase "Resumo das últimas …". Abre sozinho no horário marcado (ou ao clicar na notificação do Windows). Nas Configurações, o bloco **Resumo do dia** tem o interruptor, o horário (`wa-input type="time"`) e os botões **Ver resumo agora** (abre o cartão e volta para as Configurações ao fechar, com o que já foi digitado) e **Enviar resumo agora**. O texto para Discord/Telegram sai de `formatDaily()` em `src/main/daily.js`.
- **Grupos e perfis** (`groupsHtml()`, `groupEditHtml()`): botão de camadas (`layer-group`) no pé da barra lateral, antes do Desempenho. A janela tem duas seções, **Grupos** e **Perfis**, com uma linha `.arr-row` por item (fundo `--wa-color-surface-lowered`, nome e resumo `.meta`, botão `variant="brand" appearance="outlined"` de **Trocar para este grupo** ou **Aplicar**, e `iconBtn` de editar, atualizar e apagar). A cor do grupo só aparece na bolinha `.swatch-dot` e no seletor `.swatches` (paleta curta, a mesma de `COLORS` em `src/main/groups.js`, escolhida com botões redondos `.swatch`). Editar grupo abre uma segunda janela (`S.modal.kind = 'group'`) com nome, cor e `wa-checkbox` das contas agrupadas por jogo; **Cancelar** volta para a lista. Apagar pede `ask({ danger: true })`. Trocar de grupo ou aplicar perfil não pede confirmação (é um clique só e dá para voltar atrás aplicando outro), fecha a janela e mostra um `toast` com quantas contas acordam e dormem. Contas que dormem ou acordam fora da interface (menu **Perfis** da bandeja, fila de acordar) chegam pelo `state` (`sleeping`, `rev`) e a tela se refaz sozinha, sem mexer numa janela aberta.
- **Escolher na tela** (`startPick()`, botão com `crosshairs` no fim da linha de cada alerta): a janela de Editar jogo some (o rascunho fica guardado em `S.modal`), a conta aparece em tamanho cheio e o cabeçalho vira o aviso (`.pick-hint`: "Clique no número ou texto que você quer vigiar. Esc cancela.") com só o botão **Cancelar**; a barra lateral fica apagada e sem clique (`body.picking`). Dentro da conta, a página ganha uma camada transparente e um contorno laranja no item sob o cursor (`runPicker()` em `src/main/selector.js`): o clique nunca chega no jogo. Ao terminar, a janela volta com o seletor preenchido e uma `wa-callout` `.pick-note` embaixo da linha com o que foi lido (`success`; `warning` se o seletor depende da posição na página e pode quebrar).
- Formulários: `wa-input` com `label` e `hint`, `wa-select`, `wa-switch` (ligar/desligar) e `wa-checkbox` (escolher itens). Grupos com `.form-block` e rótulo `.form-label`.

### Atalhos de teclado

- Valem só com a janela do IdleHub em foco (nada global) e são tratados no processo principal (`src/main/shortcuts.js`), porque o foco dentro de uma conta ou do Painel não chega na página da interface. A interface só reage ao que chega por `window.idle.onShortcut`.
- A lista aparece nas **Configurações** (só leitura): teclas em `<kbd>` à esquerda, o que fazem à direita (`.shortcuts`). Atalho novo entra em `matchShortcut()`, no teste dele e nessa lista.
- Com janela ou confirmação aberta (`S.modal`/`S.asking`), os atalhos são ignorados.

### Abas da conta (subpáginas)

- Conta com subpáginas ganha uma faixa de 28px entre o topo e o jogo (`.sub-tabs`): a aba **Jogo** (`gamepad`) e uma aba por subpágina (`.sub-tab`, texto de 12px, sem botões do Web Awesome para caber no mosaico). A aba da frente fica com `--brand-soft` e linha `--brand` embaixo. A aba de uma subpágina já carregada ganha um **×** (`xmark`, `.sub-close`) que fecha a página.
- A subpágina é desenhada no mesmo espaço `[data-live]` do jogo, por cima dele; o jogo segue rodando por baixo. Ela se esconde com janelas e confirmações abertas, como as contas.
- Na janela do jogo, o botão **Subpáginas** (`globe`) de cada conta abre a lista (`.sub-edit`): nome da aba, link e remover (`trash`), mais **Adicionar subpágina** e **Copiar para as outras contas** (`clone`).

### Estados

- Lista vazia, conta dormindo, jogo sem link e Painel abrindo: `<div class="empty">` com ícone, `h2`, uma frase que diz o que fazer e o botão da ação.
- Conta: `.dot.ok` (verde brilhando), `.loading` (laranja piscando), `.unresponsive`/`.no-internet`/`.server-down`/`.challenge`/`.attention`/`.logged-out`/`.session-taken`/`.reconnecting`/`.no-data`/`.conn-dropped` (amarelo), `.crashed` (vermelho), `.sleeping`/`.no-url` (cinza). Status em texto ao lado. Rodando bem, o texto é a conexão com o servidor do jogo (regra em `src/main/connection.js`): "Conectada" (bolinha verde), "Sem dados há N min" e "Conexão caiu" (amarelo); sem sinal de conexão ainda (jogo recém-aberto ou sem conexão contínua), fica vazio.
- Conta com alerta disparado: borda `warning` no card (`.alerting`).
- Conta **pesada** (muita CPU ou memória, regra em `src/main/metrics.js`): o texto `CPU x% · memória` do topo do card ganha fundo amarelo (`.tile-mem.heavy`, tokens `warning`); a borda continua sendo só dos alertas. Na janela Desempenho a linha ganha o mesmo tom e o selo `warning` "Pesada".

### Gráficos

- Gráficos são SVG inline feitos à mão (sem biblioteca): `lineChart()` em `app.js`. Linha `--brand` de 2px com `vector-effect: non-scaling-stroke`, área `--brand-soft`, grade `--wa-color-surface-border` e fundo `--wa-color-surface-lowered`. Os números dos eixos ficam em HTML (`.meta num`), porque o SVG se estica. O teto do eixo é redondo (1, 2 ou 5 × 10ⁿ) para não pular a cada ponto.
- O histórico não vai no `state` de cada 3 s: a janela Desempenho pede `metrics:history` ao abrir e a cada 5 s enquanto estiver aberta.

## Ícones

Font Awesome grátis (`<wa-icon name="…">`), sempre com o mesmo significado. Os do Painel (tabela no [idlelive/DESIGN.md](idlelive/DESIGN.md)) valem aqui também. Os do IdleHub:

| Ícone | Significa |
|---|---|
| `table-cells-large` | todas as contas |
| `plus` | adicionar (jogo, conta, alerta) |
| `expand` | expandir a conta |
| `rotate-right` | recarregar |
| `moon` | dormir (conta parada, sem gastar memória) |
| `sun` | acordar |
| `house` | voltar ao link inicial do jogo |
| `magnifying-glass` | inspecionar a página (achar seletor de alerta); procurar a conversa do bot (Telegram) |
| `crosshairs` | escolher na tela: clicar no valor dentro do jogo para criar o alerta |
| `pen` | editar jogo |
| `trash` | remover |
| `link` | falta o link do jogo |
| `globe` | subpáginas da conta (outros sites do jogo) |
| `xmark` | fechar uma subpágina |
| `clone` | copiar as subpáginas para as outras contas |
| `bell` | atividade (recargas, logouts, alertas) |
| `gear` | configurações |
| `layer-group` | grupos e perfis de arrumação |
| `repeat` | trocar para este grupo |
| `bookmark` | perfil salvo |
| `floppy-disk` | salvar ou atualizar o perfil com a arrumação de agora |
| `gauge-high` | desempenho (CPU e memória) |
| `hourglass-half` | tempo que as contas ficaram rodando (resumo de quem estava fora) |
| `wifi` | tempo sem internet (resumo de quem estava fora) |
| `paper-plane` | enviar teste de aviso (Discord, Telegram) |
| `file-import` | importar dados |
| `gamepad` | contas dos jogos |
| `power-off` | Painel parado |

- O ícone do Painel na barra lateral é o pixel art do IdleLive (`icon.png`, `image-rendering: pixelated`).
- Ícone sem texto do lado precisa de `label` (leitor de tela) e o botão em volta precisa de `title`.

## Movimento

- Curva padrão: `cubic-bezier(0.22, 1, 0.36, 1)` (`--ease`), entre 120 e 280 ms.
- Toda animação nova precisa de uma regra em `@media (prefers-reduced-motion: reduce)` que a desliga.
- Não anime na carga da janela.

## Textos

- Português do Brasil, frases curtas, sem termos técnicos ("conta dormindo", não "WebContents destruído"; "janela preta", não "terminal").
- Fale com o jogador no imperativo e diga o caminho com setas: "Vá em **Configurações → Importar dados do IdleLive**."
- Botões começam com verbo: Adicionar jogo, Acordar todas, Recarregar, Salvar.
- Nomes de botões e seções citados no texto vão em **negrito**.
- Erro diz o que fazer, não só o que falhou: "Feche a janela preta do IdleLive e tente de novo."
